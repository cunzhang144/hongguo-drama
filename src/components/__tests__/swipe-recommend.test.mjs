import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SWIPE_GENRES, capSeenList, findPlayableIndex, firstPlayableIndex, formatEpisodeLabel,
  mergeFeedItems, nextFeedCandidate, resolveSwipeDirection, shouldPrefetchNext, validFeedItem,
} from '../swipeRecommendModel.mjs';

const drama = (id, title = `剧${id}`, extra = {}) => ({
  series_id: String(id), series_title: title, source: 'hongguo', cover: '', tags: [], ...extra,
});
const episode = (index, extra = {}) => ({ vid: String(700000 + index), vid_index: index, locked: false, ...extra });

test('genre list matches the four App channels', () => {
  assert.deepEqual(SWIPE_GENRES.map(item => item.id), ['mixed', 'real', 'comic', 'ai']);
});

test('feed merge deduplicates, skips seen/hidden and rejects foreign items', () => {
  const merged = mergeFeedItems(
    [drama(1), drama(2)],
    [drama(2), drama(3), { series_id: '4', series_title: 'x', source: 'hema' }, { series_id: 'bad', series_title: 'x', source: 'hongguo' }, drama(5)],
    { seen: new Set(['5']), hidden: new Set(['3']) },
  );
  assert.deepEqual(merged.map(item => item.series_id), ['1', '2']);
});

test('feed merge keeps queue bounded', () => {
  const many = Array.from({ length: 20 }, (_, index) => drama(index + 1));
  assert.equal(mergeFeedItems([], many, { limit: 5 }).length, 5);
  assert.equal(validFeedItem(many[0]), true);
  assert.equal(validFeedItem({ series_id: 1, series_title: 'x', source: 'hongguo' }), true);
});

test('next candidate skips seen and hidden entries', () => {
  const feed = [drama(1), drama(2), drama(3), drama(4)];
  const candidate = nextFeedCandidate(feed, 0, { seen: new Set(['1']), hidden: new Set(['2']) });
  assert.equal(candidate.item.series_id, '3');
  assert.equal(candidate.index, 2);
  assert.equal(nextFeedCandidate(feed, 4, { seen: new Set(['1', '2']) }), null);
});

test('playable search skips locked and empty vids in both directions', () => {
  const episodes = [episode(1), episode(2, { locked: true }), episode(3), episode(4, { vid: '' })];
  assert.equal(firstPlayableIndex(episodes), 0);
  assert.equal(findPlayableIndex(episodes, 0, 1), 2);
  assert.equal(findPlayableIndex(episodes, 2, 1), -1);
  assert.equal(findPlayableIndex(episodes, 2, -1), 0);
  assert.equal(findPlayableIndex([], -1, 1), -1);
});

test('seen list is capped and sanitized', () => {
  const values = ['1', '2', '2', 'bad', '', '3'];
  assert.deepEqual(capSeenList(values), ['1', '2', '3']);
  const many = Array.from({ length: 600 }, (_, index) => String(index + 1));
  const capped = capSeenList(many, 540);
  assert.equal(capped.length, 540);
  assert.equal(capped.at(-1), '600');
});

test('prefetch triggers on progress or near the end only', () => {
  assert.equal(shouldPrefetchNext({ currentTime: 70, duration: 100 }), true);
  assert.equal(shouldPrefetchNext({ currentTime: 50, duration: 60 }), true);
  assert.equal(shouldPrefetchNext({ currentTime: 10, duration: 100 }), false);
  assert.equal(shouldPrefetchNext({ currentTime: 90, duration: 100, already: true }), false);
  assert.equal(shouldPrefetchNext({ currentTime: 1, duration: 0 }), false);
});

test('wheel deltas map to swipe directions with a dead zone', () => {
  assert.equal(resolveSwipeDirection(200, 120), 1);
  assert.equal(resolveSwipeDirection(-200, 120), -1);
  assert.equal(resolveSwipeDirection(60, 120), 0);
  assert.equal(resolveSwipeDirection(Number.NaN, 120), 0);
});

test('episode labels prefer the real title when available', () => {
  assert.equal(formatEpisodeLabel(episode(3, { title: '风起' }), 2), '第 3 集 · 风起');
  assert.equal(formatEpisodeLabel(episode(3), 2), '第 3 集');
});
