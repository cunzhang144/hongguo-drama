// 滑动推荐数据源：复用 App 个性化推荐流（landpage）的分页能力。
// browseList 已实现签名、session_id/offset 游标与 120s 缓存；这里负责多类型交错、
// 已看过滤、游标耗尽后的重新开流，保证「刷不完」的推荐队列。
const { browseList } = require('./hongguo-app-catalog');

const GENRES = { real: 'real-drama', comic: 'comic-drama', ai: 'ai-drama' };
const ALL = ['real', 'comic', 'ai'];
const MAX_EXCLUDE = 540;
const MAX_PAGE = 50;
const MAX_ATTEMPTS = 3;

let cursors = freshCursors();
function freshCursors() {
  return Object.fromEntries(ALL.map(id => [id, { page: 0, exhausted: false }]));
}

function normalizeExclude(value) {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter(id => typeof id === 'string' && /^\d{1,30}$/.test(id)).slice(0, MAX_EXCLUDE));
}

function itemGenre(item, fallback) {
  return item && item.source === 'hongguo' && /^\d{1,30}$/.test(String(item.series_id || '')) ? fallback : '';
}

/** 交错合并各类型批次，避免连续三部都是同一类。 */
function interleave(batches) {
  const queues = batches.filter(batch => batch.items.length).map(batch => ({ genre: batch.genre, items: [...batch.items] }));
  const merged = [];
  while (queues.some(queue => queue.items.length)) {
    for (const queue of queues) {
      const item = queue.items.shift();
      if (item) merged.push({ ...item, genre: queue.genre });
    }
  }
  return merged;
}

async function fetchGenre(genre, exclude) {
  const category = GENRES[genre];
  let lastError = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const cursor = cursors[genre];
    const page = cursor.exhausted ? 1 : Math.min(MAX_PAGE, cursor.page + 1);
    let result;
    try {
      result = await browseList({
        category,
        page,
        forceRefresh: cursor.exhausted,
        catalogScope: 'recommend',
      });
    } catch (error) {
      lastError = error;
      cursors[genre] = { page: 0, exhausted: false };
      continue;
    }
    if (!result || result.success !== true) {
      if (process.env.SWIPE_DEBUG) console.error('[swipe-feed]', genre, category, page, result?.success, result?.error, result?.code);
      lastError = new Error(result?.error || 'App 推荐流暂不可用');
      // 游标失效、超时或网络抖动都回到第 1 页重新开流；业务拒绝交给调用方提示。
      if (['APP_CURSOR', 'APP_TIMEOUT', 'APP_NETWORK', 'APP_CANCELLED'].includes(result?.code)) {
        cursors[genre] = { page: 0, exhausted: false };
        continue;
      }
      break;
    }
    cursors[genre] = { page, exhausted: result.hasMore !== true };
    const items = (Array.isArray(result.results) ? result.results : [])
      .filter(item => itemGenre(item, genre) && !exclude.has(String(item.series_id)));
    if (items.length || result.hasMore !== true) return { genre, items };
    // 整页都被已看/隐藏过滤掉：继续拉下一页，而不是让队列空转。
  }
  if (lastError) throw lastError;
  return { genre, items: [] };
}

/**
 * @param {{ genre?: 'mixed'|'real'|'comic'|'ai', reset?: boolean, exclude?: string[] }} options
 * @returns {Promise<{success: boolean, items: Array, hasMore: boolean, warning?: string, error?: string}>}
 */
async function recommendFeed(options = {}) {
  const genre = Object.hasOwn(GENRES, options.genre) ? options.genre : options.genre === 'mixed' ? 'mixed' : 'mixed';
  if (options.reset === true) cursors = freshCursors();
  const exclude = normalizeExclude(options.exclude);
  const wanted = genre === 'mixed' ? ALL : [genre];
  const settled = await Promise.allSettled(wanted.map(id => fetchGenre(id, exclude)));
  const batches = [], failures = [];
  settled.forEach((entry, index) => {
    if (entry.status === 'fulfilled') batches.push(entry.value);
    else failures.push({ genre: wanted[index], error: entry.reason?.message || '加载失败' });
  });
  if (!batches.length) {
    return { success: false, items: [], hasMore: false, error: failures[0]?.error || '推荐流加载失败，请重试' };
  }
  const items = interleave(batches);
  const hasMore = ALL.some(id => !cursors[id].exhausted);
  return {
    success: true,
    items: items.slice(0, 30),
    hasMore,
    ...(failures.length ? { warning: `${failures.length} 个类型暂不可用` } : {}),
  };
}

module.exports = { recommendFeed, GENRES };
