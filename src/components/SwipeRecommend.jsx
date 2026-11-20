import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../i18n';
import { readLocalLibrary, saveLocalSeries } from '../localLibrary';
import { Pause, Play } from './icons';
import {
  SWIPE_GENRES, capSeenList, findPlayableIndex, firstPlayableIndex, formatEpisodeLabel,
  mergeFeedItems, nextFeedCandidate, resolveSwipeDirection, shouldPrefetchNext,
} from './swipeRecommendModel.mjs';
import './SwipeRecommend.css';

const SEEN_KEY = 'hongguo:swipe:seen:v1';
const HIDDEN_KEY = 'hongguo:swipe:hidden:v1';
const GENRE_KEY = 'hongguo:swipe:genre:v1';
const RATE_KEY = 'hongguo:swipe:rate:v1';
const RATE_OPTIONS = [0.75, 1, 1.25, 1.5, 2, 3, 4];
const LONG_PRESS_MS = 300;
const LONG_PRESS_RATE = 4;
const PREFETCH_RETRY_MS = 15000;
const SWIPE_LOCK_MS = 500;
const SAVE_INTERVAL_SECONDS = 5;

const IconHeart = ({ size = 20, filled = false }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1L12 21l7.7-7.6 1.1-1a5.5 5.5 0 0 0 0-7.8Z" />
  </svg>
);
const IconList = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </svg>
);
const IconBlock = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" />
  </svg>
);
const IconVolume = ({ size = 20, muted = false }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 5 6 9H3v6h3l5 4V5Z" />
    {muted ? <path d="m16 9 5 6M21 9l-5 6" /> : <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 6a9 9 0 0 1 0 12" />}
  </svg>
);
const IconFullscreen = ({ size = 20, exit = false }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {exit ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
  </svg>
);
const IconSpeed = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4.9 19a9 9 0 1 1 14.2 0" /><path d="m12 13 4-4" /><circle cx="12" cy="13" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);

const readIdList = (key) => {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || '[]');
    return new Set(capSeenList(value));
  } catch (_) { return new Set(); }
};
const writeIdList = (key, set) => {
  try { window.localStorage.setItem(key, JSON.stringify(capSeenList([...set]))); } catch (_) { /* 存储失败不阻断播放 */ }
};
const readRate = () => {
  try {
    const value = Number(window.localStorage.getItem(RATE_KEY));
    return RATE_OPTIONS.includes(value) ? value : 1;
  } catch (_) { return 1; }
};
const isAndroid = () => {
  try { return window.electronAPI?.platform === 'android'; } catch (_) { return false; }
};
const formatTime = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** 释放一次在线播放会话；失败不影响切集。 */
const releasePlayback = request => {
  if (!request) return Promise.resolve();
  return window.electronAPI.releaseOnlinePlay({ requestId: request.requestId, streamId: request.streamId })
    .catch(() => {});
};

export default function SwipeRecommend({ active = true, onNavigate }) {
  const [genre, setGenre] = useState(() => {
    try {
      const saved = window.localStorage.getItem(GENRE_KEY);
      return SWIPE_GENRES.some(item => item.id === saved) ? saved : 'mixed';
    } catch (_) { return 'mixed'; }
  });
  const [feed, setFeed] = useState([]);
  const [feedIndex, setFeedIndex] = useState(-1);
  const [item, setItem] = useState(null);
  const [episodes, setEpisodes] = useState([]);
  const [episodeIndex, setEpisodeIndex] = useState(-1);
  const [videoUrl, setVideoUrl] = useState('');
  const [status, setStatus] = useState('idle'); // idle|loading|playing|paused|buffering|error
  const [error, setError] = useState('');
  const [muted, setMuted] = useState(true);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [episodesOpen, setEpisodesOpen] = useState(false);
  const [favorite, setFavorite] = useState(false);
  const [prefetching, setPrefetching] = useState(false);
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(readRate);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [seekHint, setSeekHint] = useState(null);

  const containerRef = useRef(null);
  const videoRef = useRef(null);
  const feedRef = useRef([]);
  const feedIndexRef = useRef(-1);
  const seriesRef = useRef(null); // { item, episodes }
  const episodeIndexRef = useRef(-1);
  const seenRef = useRef(readIdList(SEEN_KEY));
  const hiddenRef = useRef(readIdList(HIDDEN_KEY));
  const requestRef = useRef(null);
  const prefetchRef = useRef(null);
  const prefetchFailedRef = useRef(new Map());
  const playTokenRef = useRef(0);
  const feedLoadingRef = useRef(false);
  const dramaLoadingRef = useRef(false);
  const startedRef = useRef(false);
  const activeRef = useRef(active);
  const wheelRef = useRef({ delta: 0, at: 0 });
  const lastSavedRef = useRef(0);
  const pendingSeekRef = useRef(0);
  const resumeOnReturnRef = useRef(0);
  const switchingRef = useRef(false);
  const progressRef = useRef(0);
  const rateRef = useRef(rate);
  const longPressTimerRef = useRef(null);
  const longPressActiveRef = useRef(false);
  const gestureRef = useRef(null);
  const fullscreenRef = useRef(false);

  activeRef.current = active;
  rateRef.current = rate;
  fullscreenRef.current = fullscreen;

  const applyRate = useCallback((value, temporary = false) => {
    const video = videoRef.current;
    const next = Number(value) || 1;
    if (video) video.playbackRate = next;
    if (!temporary) {
      rateRef.current = next;
      setRate(next);
      try { window.localStorage.setItem(RATE_KEY, String(next)); } catch (_) { /* 忽略 */ }
    }
  }, []);

  const persistPosition = useCallback((ended = false) => {
    const video = videoRef.current;
    const series = seriesRef.current;
    const index = episodeIndexRef.current;
    if (!video || !series || index < 0) return;
    const ep = series.episodes[index];
    if (!ep?.vid || !Number.isFinite(video.currentTime) || video.currentTime < 0) return;
    // 快速划过的一两秒不写入观看记录，避免推荐页把历史刷满。
    if (!ended && video.currentTime < 3) return;
    lastSavedRef.current = video.currentTime;
    window.electronAPI.savePlaybackPosition(series.item.series_id, ep.vid_index, video.currentTime,
      { duration: Number.isFinite(video.duration) ? video.duration : 0, ended: ended || video.ended === true })
      .catch(() => {});
  }, []);

  const releasePrefetch = useCallback(async () => {
    const pending = prefetchRef.current;
    prefetchRef.current = null;
    setPrefetching(false);
    if (!pending) return;
    try {
      const result = pending.ready ? pending.result : await pending.promise;
      if (result?.streamId) await releasePlayback({ requestId: pending.requestId, streamId: result.streamId });
    } catch (_) { /* 已自动清理 */ }
  }, []);

  const stopPlayback = useCallback(({ clear = true } = {}) => {
    const video = videoRef.current;
    if (video && Number.isFinite(video.currentTime)) resumeOnReturnRef.current = video.currentTime;
    persistPosition(false);
    if (video) {
      video.pause();
      if (clear) { video.removeAttribute('src'); video.load(); }
    }
    releasePlayback(requestRef.current);
    requestRef.current = null;
    void releasePrefetch();
    if (clear) setVideoUrl('');
    setPlaying(false);
  }, [persistPosition, releasePrefetch]);

  /** 加载一批推荐；reset=true 时重新开流。genreOverride 用于类型切换时避免闭包拿到旧值。 */
  const loadFeed = useCallback(async (reset = false, genreOverride) => {
    if (feedLoadingRef.current) return;
    feedLoadingRef.current = true;
    try {
      const res = await window.electronAPI.recommendFeed({
        genre: genreOverride || genre,
        reset,
        exclude: [...new Set([...seenRef.current, ...hiddenRef.current])],
      });
      if (!res?.success) throw new Error(res?.error || '推荐流加载失败');
      const merged = mergeFeedItems(reset ? [] : feedRef.current, res.items || [], {
        seen: seenRef.current, hidden: hiddenRef.current, limit: 500,
      });
      feedRef.current = merged;
      setFeed(merged);
      if (res.warning) console.info('[SwipeFeed]', res.warning);
    } catch (error) {
      setError(error.message || '推荐流加载失败');
      setStatus('error');
    } finally {
      feedLoadingRef.current = false;
    }
  }, [genre]);

  const refreshFavorite = useCallback(() => {
    const current = seriesRef.current?.item;
    const resolved = readLocalLibrary();
    const record = current ? resolved.items.find(entry => entry.id === String(current.series_id)) : null;
    setFavorite(record?.favorite === true);
  }, []);

  /** 取播放地址：优先复用预取，失败再单独请求。 */
  const resolveMedia = useCallback(async (ep, seriesId) => {
    const pending = prefetchRef.current;
    if (pending && pending.vid === ep.vid) {
      prefetchRef.current = null;
      setPrefetching(false);
      if (!pending.ready) window.electronAPI.promoteOnlinePlay({ requestId: pending.requestId }).catch(() => {});
      const result = await pending.promise;
      return { result, requestId: pending.requestId };
    }
    // 与目标集无关的旧预取异步释放，不阻塞本次切集。
    if (prefetchRef.current) void releasePrefetch();
    const requestId = crypto.randomUUID();
    let result;
    try {
      result = await window.electronAPI.prepareOnlinePlay({
        requestId, vid: ep.vid, seriesId, vidIndex: ep.vid_index, quality: 'auto',
      });
    } catch (error) {
      result = { success: false, error: error?.message || String(error) };
    }
    return { result, requestId };
  }, [releasePrefetch]);

  const playEpisode = useCallback(async (index, { resumeAt = 0 } = {}) => {
    const series = seriesRef.current;
    const ep = series?.episodes?.[index];
    if (!series || !ep) return;
    if (ep.locked) { setError('这一集需在来源平台解锁'); setStatus('error'); return; }
    if (!ep.vid) { setError('这一集暂时没有可播放片源'); setStatus('error'); return; }

    const token = ++playTokenRef.current;
    switchingRef.current = true;
    persistPosition(false);
    const video = videoRef.current;
    if (video) { video.pause(); }
    releasePlayback(requestRef.current);
    requestRef.current = null;
    setVideoUrl('');
    setProgress(0);
    progressRef.current = 0;
    setPlaying(false);
    setStatus('loading');
    setError('');
    setEpisodeIndex(index);
    episodeIndexRef.current = index;
    pendingSeekRef.current = resumeAt;

    const { result, requestId } = await resolveMedia(ep, series.item.series_id);
    if (token !== playTokenRef.current) {
      switchingRef.current = false;
      if (result?.streamId) releasePlayback({ requestId, streamId: result.streamId });
      return;
    }
    if (!result?.success) {
      switchingRef.current = false;
      if (result?.streamId) releasePlayback({ requestId, streamId: result.streamId });
      setStatus('error');
      setError(result?.error || '取源失败，请重试或换一部');
      return;
    }
    requestRef.current = {
      requestId, streamId: result.streamId, vid: ep.vid,
      seriesId: series.item.series_id, vidIndex: ep.vid_index,
    };
    lastSavedRef.current = 0;
    setVideoUrl(result.url);
    switchingRef.current = false;
    refreshFavorite();
  }, [persistPosition, refreshFavorite, resolveMedia]);

  const prefetchNext = useCallback(() => {
    const series = seriesRef.current;
    if (!series) return;
    const nextIndex = findPlayableIndex(series.episodes, episodeIndexRef.current, 1);
    if (nextIndex < 0) return;
    const next = series.episodes[nextIndex];
    if (prefetchRef.current?.vid === next.vid) return;
    const failedAt = prefetchFailedRef.current.get(next.vid);
    if (failedAt && Date.now() - failedAt < PREFETCH_RETRY_MS) return;
    if (prefetchRef.current) void releasePrefetch();
    const requestId = crypto.randomUUID();
    const pending = { requestId, vid: next.vid, seriesId: series.item.series_id, vidIndex: next.vid_index, ready: false };
    prefetchRef.current = pending;
    setPrefetching(true);
    pending.promise = window.electronAPI.prepareOnlinePlay({
      requestId, vid: next.vid, seriesId: series.item.series_id, vidIndex: next.vid_index,
      quality: 'auto', prefetch: true,
    }).then(result => {
      pending.ready = result?.success === true;
      pending.result = result;
      if (!pending.ready) prefetchFailedRef.current.set(next.vid, Date.now());
      if (prefetchRef.current === pending) setPrefetching(false);
      return result;
    }).catch(() => {
      prefetchFailedRef.current.set(next.vid, Date.now());
      if (prefetchRef.current === pending) setPrefetching(false);
      return { success: false, error: '预取失败' };
    });
  }, [releasePrefetch]);

  /** 打开一部推荐：解析分集（搜索解析 + 分集状态），成功后播第一集可播放的分集。 */
  const openDrama = useCallback(async (candidate) => {
    const { item: nextItem, index } = candidate;
    feedIndexRef.current = index;
    setFeedIndex(index);
    setItem(nextItem);
    const resolved = await window.electronAPI.searchResolve(nextItem.series_id)
      .catch(error => ({ success: false, error: error.message }));
    if (!resolved?.success) throw new Error(resolved?.error || '加载剧集失败，请重试');
    const detail = resolved.data || {};
    let list = Array.isArray(detail.episodes) ? detail.episodes : [];
    // 档案馆里的分集状态更全（locked / 已下载），解析结果作为兜底。
    const enriched = await window.electronAPI.getSeriesEpisodes(nextItem.series_id)
      .catch(() => null);
    if (enriched?.success && Array.isArray(enriched.data?.episodes) && enriched.data.episodes.length) {
      list = enriched.data.episodes;
    }
    if (!Array.isArray(list) || !list.length) throw new Error('这部剧暂时没有可播放的分集');
    const sorted = [...list].sort((a, b) => Number(a.vid_index || 0) - Number(b.vid_index || 0));
    seriesRef.current = { item: { ...nextItem, series_title: detail.series_title || nextItem.series_title }, episodes: sorted };
    setEpisodes(sorted);
    refreshFavorite();
    const first = firstPlayableIndex(sorted);
    if (first < 0) throw new Error('这部剧的分集都需要在来源平台解锁');
    await playEpisode(first);
  }, [playEpisode, refreshFavorite]);

  /** 切到下一部推荐；skipCurrent=true 表示当前剧加入「不感兴趣」。 */
  const nextDrama = useCallback(async ({ skipCurrent = false, fromEnded = false } = {}) => {
    if (dramaLoadingRef.current) return;
    dramaLoadingRef.current = true;
    try {
      const current = seriesRef.current?.item;
      if (current) {
        seenRef.current.add(String(current.series_id));
        if (skipCurrent) hiddenRef.current.add(String(current.series_id));
        writeIdList(SEEN_KEY, seenRef.current);
        writeIdList(HIDDEN_KEY, hiddenRef.current);
      }
      if (fromEnded) persistPosition(true);
      stopPlayback();
      setEpisodes([]);
      setEpisodeIndex(-1);
      episodeIndexRef.current = -1;
      seriesRef.current = null;

      for (let attempt = 0; attempt < 4; attempt += 1) {
        let candidate = nextFeedCandidate(feedRef.current, feedIndexRef.current + 1, {
          seen: seenRef.current, hidden: hiddenRef.current,
        });
        if (!candidate) {
          await loadFeed(false);
          candidate = nextFeedCandidate(feedRef.current, feedIndexRef.current + 1, {
            seen: seenRef.current, hidden: hiddenRef.current,
          });
        }
        if (!candidate) {
          await loadFeed(true);
          candidate = nextFeedCandidate(feedRef.current, 0, { seen: seenRef.current, hidden: hiddenRef.current });
        }
        if (!candidate) break;
        try {
          await openDrama(candidate);
          return;
        } catch (error) {
          console.warn('[SwipeFeed] 跳过无法播放的推荐:', error.message);
          seenRef.current.add(String(candidate.item.series_id));
          writeIdList(SEEN_KEY, seenRef.current);
          feedIndexRef.current = candidate.index;
        }
      }
      setStatus('error');
      setError('推荐流暂时没有更多可播放内容，请重试');
    } finally {
      dramaLoadingRef.current = false;
    }
  }, [loadFeed, openDrama, persistPosition, stopPlayback]);

  const goNext = useCallback(() => {
    const series = seriesRef.current;
    if (!series) return;
    const next = findPlayableIndex(series.episodes, episodeIndexRef.current, 1);
    if (next >= 0) playEpisode(next);
    else nextDrama({ fromEnded: true });
  }, [nextDrama, playEpisode]);

  const goPrevious = useCallback(() => {
    const series = seriesRef.current;
    if (!series) return;
    const previous = findPlayableIndex(series.episodes, episodeIndexRef.current, -1);
    if (previous >= 0) playEpisode(previous);
  }, [playEpisode]);

  const start = useCallback(async () => {
    setStatus('loading');
    setError('');
    await loadFeed(true);
    const candidate = nextFeedCandidate(feedRef.current, 0, { seen: seenRef.current, hidden: hiddenRef.current });
    if (!candidate) { setStatus('error'); setError('推荐流暂时没有内容，请重试'); return; }
    try { await openDrama(candidate); }
    catch (error) { setStatus('error'); setError(error.message || '加载推荐失败'); }
  }, [loadFeed, openDrama]);

  // 首次进入页面时启动推荐流。
  useEffect(() => {
    if (!active || startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [active, start]);

  // 离开页面时停止播放并保存进度；回来时重新取流（旧地址可能已过期）。
  useEffect(() => {
    if (active) {
      if (startedRef.current && seriesRef.current && !videoUrl && status !== 'loading') {
        const resumeAt = resumeOnReturnRef.current;
        resumeOnReturnRef.current = 0;
        void playEpisode(episodeIndexRef.current, { resumeAt }).catch(() => {});
      }
      return;
    }
    playTokenRef.current += 1;
    stopPlayback();
    setStatus('idle');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => () => { playTokenRef.current += 1; stopPlayback(); }, [stopPlayback]);

  // 全屏状态：安卓用 WebView 内沉浸层（手势可用），桌面用浏览器全屏。
  useEffect(() => {
    const onChange = () => {
      if (isAndroid()) return;
      const on = !!document.fullscreenElement;
      setFullscreen(on);
      setSpeedOpen(false);
      if (!on) {
        setControlsVisible(true);
        if (longPressActiveRef.current) {
          longPressActiveRef.current = false;
          applyRate(rateRef.current);
        }
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, [applyRate]);

  // 安卓返回键：优先退出沉浸全屏，其次交给 App 的返回逻辑。
  useEffect(() => {
    const exitImmersive = () => {
      if (!fullscreenRef.current) return false;
      exitFullscreen();
      return true;
    };
    window.__swipeFullscreenExit = exitImmersive;
    return () => {
      if (window.__swipeFullscreenExit === exitImmersive) delete window.__swipeFullscreenExit;
      if (fullscreenRef.current) exitFullscreen();
      document.documentElement.classList.remove('swipe-immersive');
      try { window.Native?.setPlaybackOrientation?.('auto'); } catch (_) { /* 忽略 */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 键盘：与手机端一致的上下切集 + 桌面播放快捷键。
  useEffect(() => {
    if (!active) return undefined;
    const onKeyDown = (event) => {
      const tag = String(event.target?.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag) || event.target?.isContentEditable) return;
      const video = videoRef.current;
      switch (event.key) {
        case 'ArrowDown': case 'PageDown': event.preventDefault(); goNext(); break;
        case 'ArrowUp': case 'PageUp': event.preventDefault(); goPrevious(); break;
        case ' ': case 'Spacebar':
          event.preventDefault();
          if (video) { if (video.paused) { video.play().catch(() => {}); } else { video.pause(); } }
          break;
        case 'ArrowRight': if (video && Number.isFinite(video.duration)) { video.currentTime = Math.min(video.duration, video.currentTime + 5); } break;
        case 'ArrowLeft': if (video) { video.currentTime = Math.max(0, video.currentTime - 5); } break;
        case 'f': case 'F': toggleFullscreen(); break;
        case 'm': case 'M': setMuted(value => !value); break;
        case 'l': case 'L': toggleFavorite(); break;
        case 's': case 'S': void nextDrama({ skipCurrent: true }); break;
        case 'Escape':
          if (episodesOpen) setEpisodesOpen(false);
          else if (speedOpen) setSpeedOpen(false);
          break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, goNext, goPrevious, episodesOpen, speedOpen, nextDrama]);

  // 滚轮/触控板：累计位移过阈值才切集，避免轻微滚动误触。
  useEffect(() => {
    const node = containerRef.current;
    if (!node || !active) return undefined;
    const onWheel = (event) => {
      if (episodesOpen || speedOpen) return;
      event.preventDefault();
      const now = performance.now();
      if (now - wheelRef.current.at < SWIPE_LOCK_MS) return;
      wheelRef.current.delta += event.deltaY;
      const direction = resolveSwipeDirection(wheelRef.current.delta, Math.max(180, window.innerHeight * 0.18));
      if (!direction) return;
      wheelRef.current = { delta: 0, at: now };
      if (direction > 0) goNext(); else goPrevious();
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [active, episodesOpen, speedOpen, goNext, goPrevious]);

  const toggleFavorite = () => {
    const current = seriesRef.current?.item;
    if (!current) return;
    const ep = seriesRef.current?.episodes?.[episodeIndexRef.current];
    const library = readLocalLibrary();
    const record = library.items.find(entry => entry.id === String(current.series_id));
    const liked = new Set(record?.liked_episode_ids || []);
    const nextLiked = !favorite;
    if (ep?.vid) {
      if (nextLiked) liked.add(String(ep.vid));
      else liked.delete(String(ep.vid));
    }
    const result = saveLocalSeries({
      id: String(current.series_id),
      title: current.series_title,
      cover: current.cover,
      favorite: nextLiked,
      liked_episode_ids: [...liked],
    });
    if (result.error) { setError(result.error); return; }
    setFavorite(nextLiked);
    refreshFavorite();
  };

  const setImmersive = (on) => {
    setFullscreen(on);
    fullscreenRef.current = on;
    setSpeedOpen(false);
    setControlsVisible(on ? false : true);
    document.documentElement.classList.toggle('swipe-immersive', on);
  };

  const exitFullscreen = () => {
    if (isAndroid()) {
      setImmersive(false);
      try { window.Native?.setPlaybackOrientation?.('auto'); } catch (_) { /* 忽略 */ }
      return;
    }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };

  const toggleFullscreen = async () => {
    const node = containerRef.current;
    if (!node) return;
    if (isAndroid()) {
      if (fullscreenRef.current) { exitFullscreen(); return; }
      const video = videoRef.current;
      const landscape = !!video && video.videoWidth > 0 && video.videoHeight > 0 && video.videoWidth >= video.videoHeight;
      try { window.Native?.setPlaybackOrientation?.(landscape ? 'landscape' : 'portrait'); } catch (_) { /* 忽略 */ }
      setImmersive(true);
      return;
    }
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    try { await node.requestFullscreen(); } catch (_) { /* 不支持时保留普通布局 */ }
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  };

  // 手势：全屏下 1/3 区域横向拖动调进度；长按 0.3s 4 倍速；其他区域上下滑切集。
  const clearLongPress = () => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };
  const onPointerDown = (event) => {
    if (event.target.closest('button, input, .swipe-episodes, .swipe-speed-menu')) return;
    const node = containerRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const video = videoRef.current;
    const isFull = fullscreenRef.current || document.fullscreenElement === node;
    const start = {
      x: event.clientX, y: event.clientY, at: performance.now(), moved: false,
      seek: isFull && (event.clientY - rect.top) >= rect.height * (2 / 3),
      time: video && Number.isFinite(video.currentTime) ? video.currentTime : 0,
      duration: video && Number.isFinite(video.duration) ? video.duration : 0,
      rect,
    };
    gestureRef.current = start;
    longPressActiveRef.current = false;
    clearLongPress();
    longPressTimerRef.current = setTimeout(() => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.moved || longPressActiveRef.current) return;
      longPressActiveRef.current = true;
      applyRate(LONG_PRESS_RATE, true);
      try { navigator.vibrate?.(10); } catch (_) { /* 忽略 */ }
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (event) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
      gesture.moved = true;
      clearLongPress();
    }
    if (gesture.seek && gesture.duration > 0 && Math.abs(dx) > 4) {
      const next = Math.max(0, Math.min(gesture.duration, gesture.time + (dx / Math.max(1, gesture.rect.width)) * gesture.duration * 1.5));
      const video = videoRef.current;
      if (video) video.currentTime = next;
      setSeekHint({ time: next, duration: gesture.duration });
    }
  };

  const onPointerUp = (event) => {
    clearLongPress();
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture) return;
    if (longPressActiveRef.current) {
      longPressActiveRef.current = false;
      applyRate(rateRef.current);
      return;
    }
    if (gesture.seek) {
      setSeekHint(null);
      persistPosition(false);
      return;
    }
    if (gesture.moved) {
      const dy = gesture.y - event.clientY;
      if (Math.abs(dy) < 80 || performance.now() - gesture.at > 900) return;
      if (dy > 0) goNext(); else goPrevious();
      return;
    }
    togglePlay();
  };

  const onPointerCancel = () => {
    clearLongPress();
    gestureRef.current = null;
    if (longPressActiveRef.current) {
      longPressActiveRef.current = false;
      applyRate(rateRef.current);
    }
    setSeekHint(null);
  };

  const changeGenre = (id) => {
    if (id === genre) return;
    setGenre(id);
    try { window.localStorage.setItem(GENRE_KEY, id); } catch (_) { /* 忽略 */ }
    playTokenRef.current += 1;
    stopPlayback();
    seriesRef.current = null;
    feedRef.current = [];
    feedIndexRef.current = -1;
    setFeed([]); setFeedIndex(-1); setItem(null); setEpisodes([]); setEpisodeIndex(-1);
    episodeIndexRef.current = -1;
    setStatus('loading');
    void loadFeed(true, id).then(() => {
      const candidate = nextFeedCandidate(feedRef.current, 0, { seen: seenRef.current, hidden: hiddenRef.current });
      if (!candidate) { setStatus('error'); setError('推荐流暂时没有内容，请重试'); return; }
      return openDrama(candidate).catch(error => { setStatus('error'); setError(error.message || '加载推荐失败'); });
    });
  };

  const currentEpisode = episodes[episodeIndex] || null;
  const metaLine = useMemo(() => {
    if (!currentEpisode) return '';
    return `${formatEpisodeLabel(currentEpisode, episodeIndex)} · 共 ${episodes.length} 集`;
  }, [currentEpisode, episodeIndex, episodes.length]);

  const retry = () => {
    if (!seriesRef.current) { void start(); return; }
    void playEpisode(episodeIndexRef.current);
  };

  return (
    <div
      ref={containerRef}
      className={`swipe-page ${controlsVisible ? '' : 'is-clean'} ${fullscreen ? 'is-fullscreen' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onMouseLeave={() => { if (!longPressActiveRef.current) onPointerCancel(); }}
    >
      <div className="swipe-stage">
        {videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            muted={muted}
            playsInline
            autoPlay
            onLoadedMetadata={(event) => { event.currentTarget.playbackRate = rateRef.current; }}
            onCanPlay={(event) => {
              const video = event.currentTarget;
              video.playbackRate = rateRef.current;
              if (pendingSeekRef.current > 0 && pendingSeekRef.current < video.duration - 1) {
                video.currentTime = pendingSeekRef.current;
              }
              pendingSeekRef.current = 0;
              video.play().catch(() => setStatus('paused'));
            }}
            onPlay={() => { setPlaying(true); setStatus('playing'); }}
            onPause={() => {
              setPlaying(false);
              if (switchingRef.current) return;
              setStatus(value => (value === 'error' || value === 'loading' ? value : 'paused'));
            }}
            onWaiting={() => setStatus('buffering')}
            onPlaying={() => { setPlaying(true); setStatus('playing'); }}
            onTimeUpdate={(event) => {
              const video = event.currentTarget;
              if (Number.isFinite(video.duration) && video.duration > 0) {
                const next = Math.round((video.currentTime / video.duration) * 1000);
                // 进度条每 1% 更新一次即可，避免 timeupdate 高频重渲染整页。
                if (Math.abs(next - progressRef.current) >= 10) {
                  progressRef.current = next;
                  setProgress(next);
                }
              }
              if (video.currentTime - lastSavedRef.current >= SAVE_INTERVAL_SECONDS) persistPosition(false);
              if (shouldPrefetchNext({
                currentTime: video.currentTime, duration: video.duration,
                already: prefetchRef.current?.vid === seriesRef.current?.episodes?.[findPlayableIndex(seriesRef.current?.episodes || [], episodeIndexRef.current, 1)]?.vid,
              })) prefetchNext();
            }}
            onEnded={() => {
              persistPosition(true);
              goNext();
            }}
            onError={() => { setStatus('error'); setError('片源加载失败，请重试或换一部'); }}
          >
            <track kind="captions" />
          </video>
        ) : (
          <div className="swipe-cover" style={item?.cover ? { backgroundImage: `url("${item.cover}")` } : undefined} />
        )}
        <div className="swipe-scrim top" />
        <div className="swipe-scrim bottom" />

        <header className="swipe-top">
          <div className="swipe-genres" role="tablist" aria-label={t('推荐类型')}>
            {SWIPE_GENRES.map(option => (
              <button key={option.id} type="button" role="tab" aria-selected={genre === option.id}
                className={`swipe-genre ${genre === option.id ? 'active' : ''}`}
                onClick={() => changeGenre(option.id)}>{t(option.label)}</button>
            ))}
          </div>
          <div className="swipe-top-right">
            <span className="swipe-position">{feed.length ? `${Math.max(feedIndex + 1, 1)}/${feed.length}` : '—'}</span>
            <button type="button" className="swipe-ghost" onClick={() => setControlsVisible(value => !value)}>
              {t(controlsVisible ? '清屏' : '显示界面')}
            </button>
          </div>
        </header>

        <div className="swipe-rail">
          <div className="swipe-rail-group">
            <button type="button" className={`swipe-rail-btn ${speedOpen ? 'active' : ''}`}
              title={t('播放速度')} onClick={() => setSpeedOpen(value => !value)}>
              <span className="swipe-rail-icon"><IconSpeed /></span>
              <span>{rate}x</span>
            </button>
            {speedOpen && (
              <div className="swipe-speed-menu" role="menu" aria-label={t('播放速度')}>
                {RATE_OPTIONS.map(option => (
                  <button key={option} type="button" role="menuitemradio" aria-checked={rate === option}
                    className={`swipe-speed-option ${rate === option ? 'active' : ''}`}
                    onClick={() => { applyRate(option); setSpeedOpen(false); }}>{option}x</button>
                ))}
              </div>
            )}
          </div>
          <button type="button" className={`swipe-rail-btn ${favorite ? 'active' : ''}`} aria-pressed={favorite}
            title={t('收藏本集')} onClick={toggleFavorite}>
            <span className="swipe-rail-icon"><IconHeart filled={favorite} /></span>
            <span>{t(favorite ? '已收藏' : '收藏')}</span>
          </button>
          <button type="button" className="swipe-rail-btn" title={t('选择分集')}
            onClick={() => setEpisodesOpen(value => !value)}>
            <span className="swipe-rail-icon"><IconList /></span>
            <span>{t('选集')}</span>
          </button>
          <button type="button" className="swipe-rail-btn" title={t('不感兴趣')}
            onClick={() => void nextDrama({ skipCurrent: true })}>
            <span className="swipe-rail-icon"><IconBlock /></span>
            <span>{t('不感兴趣')}</span>
          </button>
          <button type="button" className="swipe-rail-btn" title={t('静音')} onClick={() => setMuted(value => !value)}>
            <span className="swipe-rail-icon"><IconVolume muted={muted} /></span>
            <span>{t(muted ? '已静音' : '声音')}</span>
          </button>
          <button type="button" className="swipe-rail-btn" title={t(fullscreen ? '退出全屏' : '全屏')} onClick={toggleFullscreen}>
            <span className="swipe-rail-icon"><IconFullscreen exit={fullscreen} /></span>
            <span>{t(fullscreen ? '退出' : '全屏')}</span>
          </button>
        </div>

        <footer className="swipe-bottom">
          <div className="swipe-title-row">
            <h2>{item?.series_title || t('滑动推荐')}</h2>
            {prefetching && <span className="swipe-prefetch">{t('预取下一集…')}</span>}
          </div>
          <p className="swipe-meta">{metaLine}</p>
          {!!(item?.tags || []).length && <p className="swipe-tags">{item.tags.map(tag => <span key={tag}>{tag}</span>)}</p>}
          {!!item?.description && <p className="swipe-desc">{item.description}</p>}
          <div className="swipe-progress-row">
            <button type="button" className="swipe-play" onClick={togglePlay} aria-label={t(playing ? '暂停' : '播放')}>
              {playing ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <input
              className="swipe-progress"
              type="range"
              min="0"
              max="1000"
              value={progress}
              onChange={(event) => {
                const video = videoRef.current;
                if (!video || !Number.isFinite(video.duration)) return;
                video.currentTime = (Number(event.target.value) / 1000) * video.duration;
                setProgress(Number(event.target.value));
              }}
              aria-label={t('播放进度')}
            />
            <span className="swipe-time">{formatTime(progress / 1000 * (videoRef.current?.duration || 0))}</span>
          </div>
        </footer>

        {status === 'loading' && <div className="swipe-center"><div className="swipe-spinner" /><p>{t('正在获取片源…')}</p></div>}
        {status === 'buffering' && <div className="swipe-center"><div className="swipe-spinner" /><p>{t('正在缓冲…')}</p></div>}
        {status === 'error' && (
          <div className="swipe-center swipe-error" role="alert">
            <p>{error || t('播放失败，请重试')}</p>
            <div className="swipe-error-actions">
              <button type="button" className="btn btn-primary" onClick={retry}>{t('重试')}</button>
              <button type="button" className="btn btn-outline" onClick={() => void nextDrama({ skipCurrent: true })}>{t('换一部')}</button>
              {onNavigate && <button type="button" className="btn btn-outline" onClick={() => onNavigate('browse')}>{t('去发现页')}</button>}
            </div>
          </div>
        )}

        {seekHint && (
          <div className="swipe-seek-hint" aria-live="polite">
            <strong>{formatTime(seekHint.time)}</strong>
            <span>/ {formatTime(seekHint.duration)}</span>
            <div className="swipe-seek-bar"><i style={{ width: `${Math.min(100, (seekHint.time / Math.max(1, seekHint.duration)) * 100)}%` }} /></div>
          </div>
        )}

        {episodesOpen && (
          <aside className="swipe-episodes" aria-label={t('选择分集')}>
            <div className="swipe-episodes-head">
              <strong>{t('选择分集')}</strong>
              <button type="button" className="swipe-ghost" onClick={() => setEpisodesOpen(false)}>{t('关闭')}</button>
            </div>
            <div className="swipe-episodes-grid">
              {episodes.map((episode, index) => (
                <button key={`${episode.vid || index}`} type="button"
                  className={`swipe-episode ${index === episodeIndex ? 'active' : ''} ${episode.locked ? 'locked' : ''}`}
                  disabled={episode.locked}
                  onClick={() => { setEpisodesOpen(false); void playEpisode(index); }}>
                  {episode.vid_index || index + 1}
                </button>
              ))}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
