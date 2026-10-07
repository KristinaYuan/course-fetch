// 自动捕获 playlist.m3u8：m3u8 由播放器运行后动态请求，不在 playVideo 页面的静态 HTML 中。
//
// 每个任务使用独立 pending/result key。临时播放页携带 capture ID，iframe 通过父子握手继承，
// 只有属于该任务的页面才观察 Resource Timing；普通已打开的播放器不能领取其他任务。
//
// GM storage 中只保存 capture id 和过期时间；捕获到的 m3u8 地址（可能含临时 token）读取后立即删除。

import { abortError } from './downloader.js';
import { store } from './storage.js';
import { captureTabUrl, resolveCaptureId, bridgeCaptureId } from './capture-context.js';

export const PENDING_KEY = 'capture:pending';
export const RESULT_KEY = 'capture:result';
export const CAPTURE_TIMEOUT_MS = 20000;
export const pendingKey = (id) => `${PENDING_KEY}:${id}`;
export const resultKey = (id) => `${RESULT_KEY}:${id}`;

export function isM3u8Url(url) {
  return /^https?:\/\/\S+?\.m3u8(?:[?#]|$)/i.test(String(url || ''));
}

/**
 * 监听当前文档发出的 .m3u8 请求：先检查已有的 resource 条目，再用 PerformanceObserver 监听新条目，
 * 并定时轮询作为兜底（Observer 不可用或页面清空了缓冲区时）。返回 stop()。
 */
export function watchM3u8Requests(onUrl, { perf = globalThis.performance, Observer = globalThis.PerformanceObserver, pollMs = 500 } = {}) {
  let stopped = false;
  const seen = new Set();
  const check = (entries) => {
    // 不用 Array.from(list, fn)：教学网的 Prototype.js 会破坏它
    for (let i = 0; entries && i < entries.length && !stopped; i++) {
      const name = entries[i] && entries[i].name;
      if (isM3u8Url(name) && !seen.has(name)) {
        seen.add(name);
        onUrl(name);
      }
    }
  };
  const scan = () => {
    try {
      check(perf.getEntriesByType('resource'));
    } catch (_) {
      /* ignore */
    }
  };
  try {
    if (perf && typeof perf.setResourceTimingBufferSize === 'function') perf.setResourceTimingBufferSize(1000);
  } catch (_) {
    /* ignore */
  }
  let observer = null;
  if (typeof Observer === 'function') {
    try {
      observer = new Observer((list) => check(list.getEntries()));
      observer.observe({ type: 'resource', buffered: true });
    } catch (_) {
      observer = null;
    }
  }
  scan();
  const timer = setInterval(scan, pollMs);
  return () => {
    stopped = true;
    clearInterval(timer);
    if (observer) observer.disconnect();
  };
}

/** 播放器没有自动开始加载时，尝试静音播放页面中的 <video>（与用户点击播放等效）。 */
function nudgePlayback(doc) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return;
  const videos = doc.querySelectorAll('video');
  for (let i = 0; i < videos.length; i++) {
    try {
      videos[i].muted = true;
      const p = videos[i].play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {
      /* ignore */
    }
  }
}

/**
 * 播放器页面 / iframe 中运行。没有未过期的 pending capture 时什么都不做，返回 false。
 */
export async function runPlayerCapture({
  kv = store,
  now = Date.now,
  watch = watchM3u8Requests,
  host = typeof location !== 'undefined' ? location.hostname : '',
  doc = typeof document !== 'undefined' ? document : null,
  maxWaitMs = CAPTURE_TIMEOUT_MS,
  nudgeAfterMs = 3000,
  win = typeof window !== 'undefined' ? window : null,
  captureId,
} = {}) {
  const id = captureId || (win && await resolveCaptureId(win, maxWaitMs));
  if (!id) return false;
  const key = pendingKey(id);
  const valid = () => {
    const pending = kv.get(key, null);
    return pending?.id === id && pending.expires > now();
  };
  if (!valid()) return false;
  console.info(`[Course Fetch] 正在捕获播放列表（${host}）`);

  let done = false;
  let stop = () => {};
  let unlisten = () => {};
  const stopBridge = win ? bridgeCaptureId(win, id, valid) : () => {};
  const finish = () => {
    if (done) return;
    done = true;
    stop();
    unlisten();
    stopBridge();
    clearTimeout(giveUp);
    clearTimeout(nudge);
    clearInterval(poll);
    win?.removeEventListener('pagehide', finish);
  };
  const giveUp = setTimeout(finish, maxWaitMs);
  const nudge = setTimeout(() => nudgePlayback(doc), nudgeAfterMs);
  const poll = setInterval(() => { if (!valid()) finish(); }, 500);
  unlisten = kv.onChange(key, () => { if (!valid()) finish(); });
  win?.addEventListener('pagehide', finish, { once: true });
  stop = watch((url) => {
    if (done) return;
    finish();
    // 取消/超时后迟到的播放器不能复活已清理的结果，更不能写入其它任务。
    if (valid() && isM3u8Url(url)) kv.set(resultKey(id), { id, url, host });
  });
  if (done) stop(); // watch 同步回调时 stop 尚未赋值
  return true;
}

function openCaptureTab(url) {
  if (typeof GM_openInTab === 'function') return GM_openInTab(url, { active: false, insert: true, setParent: true });
  return window.open(url, '_blank');
}

function captureTimeoutError(ms) {
  const e = new Error(`自动捕获播放列表超时（${Math.round(ms / 1000)} 秒）`);
  e.name = 'CaptureTimeout';
  return e;
}

/**
 * 列表页中运行：打开临时 playVideo 页面，等待播放器页面回报 m3u8 地址。
 * 成功 resolve(url)；超时 reject(CaptureTimeout)；signal 中止 reject(AbortError)。任何结果都会关闭临时页并清理 storage。
 */
export function capturePlaylist({
  watchUrl,
  signal,
  timeoutMs = CAPTURE_TIMEOUT_MS,
  kv = store,
  openTab = openCaptureTab,
  newId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  pollMs = 500,
}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const id = newId();
    const pending = pendingKey(id);
    const result = resultKey(id);
    let tab = null;
    let done = false;
    let unlisten = () => {};
    let poll = null;
    let timer = null;

    const finish = (settle, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      unlisten();
      if (signal) signal.removeEventListener('abort', onAbort);
      kv.delete(pending);
      kv.delete(result);
      try {
        if (tab && typeof tab.close === 'function') tab.close();
      } catch (_) {
        /* ignore */
      }
      settle(value);
    };
    const accept = (val) => {
      if (val && val.id === id && isM3u8Url(val.url)) {
        console.info(`[Course Fetch] 已捕获播放列表（来自 ${val.host || '播放页'}）`);
        finish(resolve, val.url);
      }
    };
    const onAbort = () => finish(reject, abortError());

    kv.set(pending, { id, expires: Date.now() + timeoutMs + 5000 });
    unlisten = kv.onChange(result, accept);
    poll = setInterval(() => accept(kv.get(result, null)), pollMs); // 值变化监听不可用时的兜底
    timer = setTimeout(() => finish(reject, captureTimeoutError(timeoutMs)), timeoutMs);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      tab = openTab(captureTabUrl(watchUrl, id));
      if (done && tab && typeof tab.close === 'function') tab.close();
    } catch (e) {
      finish(reject, e);
    }
  });
}
