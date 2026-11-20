// 滑动推荐的纯逻辑：便于 node:test 覆盖游标、去重、切集边界与预取时机。
// 产品口径：只区分真人剧与漫剧；AI 剧并入漫剧，不再单独展示。
export const SWIPE_GENRES = [
  { id: 'mixed', label: '综合' },
  { id: 'real', label: '真人剧' },
  { id: 'comic', label: '漫剧' },
];

export const SEEN_LIMIT = 540;

export function validFeedItem(item) {
  return !!item && item.source === 'hongguo' && /^\d{1,30}$/.test(String(item.series_id || ''))
    && typeof item.series_title === 'string' && item.series_title.trim().length > 0;
}

/** 合入新批次：按 series_id 去重，过滤已看/已隐藏，保留顺序并限制队列长度。 */
export function mergeFeedItems(existing, incoming, { seen = new Set(), hidden = new Set(), limit = 80 } = {}) {
  const ids = new Set();
  const merged = [];
  for (const item of [...(existing || []), ...(incoming || [])]) {
    if (!validFeedItem(item)) continue;
    const id = String(item.series_id);
    if (ids.has(id) || seen.has(id) || hidden.has(id)) continue;
    ids.add(id);
    merged.push(item);
  }
  return merged.slice(-limit);
}

/** 从 from 开始找下一部可用推荐；跳过已看、隐藏与非法条目。 */
export function nextFeedCandidate(feed, from, { seen = new Set(), hidden = new Set() } = {}) {
  for (let index = Math.max(0, from); index < (feed?.length || 0); index += 1) {
    const item = feed[index];
    if (!validFeedItem(item)) continue;
    const id = String(item.series_id);
    if (seen.has(id) || hidden.has(id)) continue;
    return { item, index };
  }
  return null;
}

export function firstPlayableIndex(episodes) {
  return findPlayableIndex(episodes, -1, 1);
}

/** 在分集列表里按方向找可播放的一集（跳过 locked 与缺少 vid 的占位）。 */
export function findPlayableIndex(episodes, fromIndex, direction = 1) {
  const list = Array.isArray(episodes) ? episodes : [];
  for (let index = fromIndex + direction; index >= 0 && index < list.length; index += direction) {
    const episode = list[index];
    if (episode && !episode.locked && /^\d{1,30}$/.test(String(episode.vid || ''))) return index;
  }
  return -1;
}

/** 已看集合持久化时截断，避免 localStorage 无限增长。 */
export function capSeenList(values, limit = SEEN_LIMIT) {
  const unique = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const id = String(value || '');
    if (!/^\d{1,30}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  return unique.slice(-limit);
}

/** 剩余时长或进度达到阈值时预取下一集；already=true 表示已预取/正在播放。 */
export function shouldPrefetchNext({ currentTime = 0, duration = 0, already = false } = {}) {
  if (already || !Number.isFinite(duration) || duration <= 0) return false;
  const remaining = duration - (Number.isFinite(currentTime) ? currentTime : 0);
  return currentTime / duration >= 0.7 || remaining <= 10;
}

/** 滚轮/拖拽位移转成翻页方向；位移不足返回 0。 */
export function resolveSwipeDirection(delta, threshold = 120) {
  if (!Number.isFinite(delta)) return 0;
  if (delta >= threshold) return 1;
  if (delta <= -threshold) return -1;
  return 0;
}

export function formatEpisodeLabel(episode, index) {
  const number = Number(episode?.vid_index || index + 1);
  const title = typeof episode?.title === 'string' ? episode.title.trim() : '';
  // 部分来源（安卓官网解析）把标题直接写成“第N集”，避免出现“第 1 集 · 第1集”。
  const duplicate = /^第\s*\d+\s*集$/.test(title) && Number(title.replace(/\D/g, '')) === number;
  return title && !duplicate ? `第 ${number} 集 · ${title}` : `第 ${number} 集`;
}
