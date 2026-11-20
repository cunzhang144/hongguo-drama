// 滑动推荐数据源：复用 App 个性化推荐流（landpage）的分页能力。
// 产品口径只区分真人剧与漫剧：AI 剧并入漫剧组；综合为两组交错。
const { browseList } = require('./hongguo-app-catalog');

const GROUPS = {
  real: ['real-drama'],
  comic: ['comic-drama', 'ai-drama'],
};
const ALL_CATEGORIES = ['real-drama', 'comic-drama', 'ai-drama'];
const MAX_EXCLUDE = 540;
const MAX_PAGE = 50;
const MAX_ATTEMPTS = 3;

let cursors = freshCursors();
function freshCursors() {
  return Object.fromEntries(ALL_CATEGORIES.map(category => [category, { page: 0, exhausted: false }]));
}

function normalizeExclude(value) {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter(id => typeof id === 'string' && /^\d{1,30}$/.test(id)).slice(0, MAX_EXCLUDE));
}

function validItem(item) {
  return !!item && item.source === 'hongguo' && /^\d{1,30}$/.test(String(item.series_id || ''));
}

/** 交错合并批次，避免连续多部同一组/同一类型。 */
function interleave(batches) {
  const queues = batches.filter(batch => batch.items.length).map(batch => ({ group: batch.group, items: [...batch.items] }));
  const merged = [];
  while (queues.some(queue => queue.items.length)) {
    for (const queue of queues) {
      const item = queue.items.shift();
      if (item) merged.push({ ...item, genre: queue.group });
    }
  }
  return merged;
}

async function fetchCategory(category, exclude) {
  let lastError = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const cursor = cursors[category];
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
      cursors[category] = { page: 0, exhausted: false };
      continue;
    }
    if (!result || result.success !== true) {
      if (process.env.SWIPE_DEBUG) console.error('[swipe-feed]', category, page, result?.success, result?.error, result?.code);
      lastError = new Error(result?.error || 'App 推荐流暂不可用');
      // 游标失效、超时或网络抖动都回到第 1 页重新开流；业务拒绝交给调用方提示。
      if (['APP_CURSOR', 'APP_TIMEOUT', 'APP_NETWORK', 'APP_CANCELLED'].includes(result?.code)) {
        cursors[category] = { page: 0, exhausted: false };
        continue;
      }
      break;
    }
    cursors[category] = { page, exhausted: result.hasMore !== true };
    const items = (Array.isArray(result.results) ? result.results : [])
      .filter(item => validItem(item) && !exclude.has(String(item.series_id)));
    if (items.length || result.hasMore !== true) return items;
    // 整页都被已看/隐藏过滤掉：继续拉下一页，而不是让队列空转。
  }
  if (lastError) throw lastError;
  return [];
}

/** 一组可能包含多个 App 目录（漫剧=漫剧+AI 剧），按组内交错返回。 */
async function fetchGroup(group, exclude) {
  const categories = GROUPS[group];
  const settled = await Promise.allSettled(categories.map(category => fetchCategory(category, exclude)));
  const batches = [], failures = [];
  settled.forEach((entry, index) => {
    if (entry.status === 'fulfilled') batches.push({ group, items: entry.value });
    else failures.push(entry.reason);
  });
  if (!batches.length) throw failures[0] || new Error('推荐流加载失败');
  return { group, items: interleave(batches).map(item => ({ ...item, genre: group })), failed: failures.length > 0 };
}

/**
 * @param {{ genre?: 'mixed'|'real'|'comic'|'ai', reset?: boolean, exclude?: string[] }} options
 * legacy genre='ai' 会并入漫剧组，兼容旧客户端。
 */
async function recommendFeed(options = {}) {
  const requested = options.genre === 'real' || options.genre === 'comic' || options.genre === 'ai' ? options.genre : 'mixed';
  const genre = requested === 'ai' ? 'comic' : requested;
  if (options.reset === true) cursors = freshCursors();
  const exclude = normalizeExclude(options.exclude);
  const groups = genre === 'mixed' ? ['real', 'comic'] : [genre];
  const settled = await Promise.allSettled(groups.map(group => fetchGroup(group, exclude)));
  const batches = [], failures = [];
  settled.forEach((entry, index) => {
    if (entry.status === 'fulfilled') batches.push(entry.value);
    else failures.push({ group: groups[index], error: entry.reason?.message || '加载失败' });
  });
  if (!batches.length) {
    return { success: false, items: [], hasMore: false, error: failures[0]?.error || '推荐流加载失败，请重试' };
  }
  const items = interleave(batches);
  const hasMore = ALL_CATEGORIES.some(category => !cursors[category].exhausted);
  const failed = failures.length || batches.some(batch => batch.failed);
  return {
    success: true,
    items: items.slice(0, 30),
    hasMore,
    ...(failed ? { warning: '部分类型暂不可用' } : {}),
  };
}

module.exports = { recommendFeed, GROUPS };
