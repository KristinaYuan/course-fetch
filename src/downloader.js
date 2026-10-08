// 下载：网络请求、取消、重试、按序并发、AES-128 解密、合并写入、进度。
// 核心流程 downloadHls 的网络请求和写入由调用方注入，可在 Node 中测试。

import { parseM3U8, pickVariant, assertSupported, ivForSequence } from './hls.js';

export class HttpError extends Error {
  constructor(status) {
    super(
      status === 401 || status === 403
        ? `无权限访问（HTTP ${status}），请确认已登录且能在教学网正常播放该录像`
        : `HTTP ${status}`,
    );
    this.status = status;
  }
}

// ---- 取消与重试 ----------------------------------------------------------------

export function abortError() {
  const e = new Error('已取消');
  e.name = 'AbortError';
  return e;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

/** 让任意 Promise 在 signal 中止时立即 reject（底层请求由 request 自己负责中止）。 */
export function abortable(promise, signal) {
  promise = Promise.resolve(promise);
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {}); // 调用方已创建的请求即使立即失败，也不能留下未处理 rejection。
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError());
  const onAbort = () => {
    clearTimeout(timer);
    reject(abortError());
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

export async function withRetry(fn, { attempts = 3, delayMs = 1000, signal } = {}) {
  for (let i = 1; ; i++) {
    throwIfAborted(signal);
    try {
      return await fn();
    } catch (e) {
      // 取消、4xx（含 401/403）和解密错误不重试
      if (e.name === 'AbortError' || (signal && signal.aborted)) throw abortError();
      if (i >= attempts || e.fatal || (e.status >= 400 && e.status < 500)) throw e;
      await sleep(delayMs * i, signal);
    }
  }
}

/** 防止某个 Promise 永远不结束（例如磁盘写入句柄卡住），导致页面无法恢复。 */
export function withTimeout(promise, ms) {
  let timer;
  return Promise.race([Promise.resolve(promise).catch(() => {}), new Promise((r) => { timer = setTimeout(r, ms); })])
    .finally(() => clearTimeout(timer));
}

/**
 * 最多 concurrency 个请求同时进行，但 onData 严格按 0..count-1 的顺序调用。
 * 内存中最多缓存 concurrency 个分片。signal（AbortSignal）中止时立即 reject。
 */
export async function fetchInOrder(count, { concurrency = 4, fetchOne, onData, signal }) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('分片并发数必须是正整数');
  throwIfAborted(signal);
  const pending = new Map();
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let firstError = null;
  let next = 0;
  const start = () => {
    const i = next++;
    const p = Promise.resolve().then(() => {
      throwIfAborted(stop.signal);
      return fetchOne(i);
    });
    p.catch((error) => {
      if (!firstError) firstError = error;
      stop.abort(); // 后续分片先失败时也立即结束，不能被卡住的前序分片遮住。
    });
    pending.set(i, p);
  };
  while (next < count && pending.size < concurrency) start();
  try {
    for (let i = 0; i < count; i++) {
      const data = await abortable(pending.get(i), stop.signal);
      throwIfAborted(stop.signal);
      await abortable(Promise.resolve().then(() => {
        throwIfAborted(stop.signal);
        return onData(i, data);
      }), stop.signal);
      // 写入中的分片也占窗口；慢磁盘不能使缓存增长到 concurrency + 1。
      pending.delete(i);
      throwIfAborted(stop.signal);
      if (next < count) start();
    }
  } catch (error) {
    throw firstError || error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    pending.clear();
  }
}

// ---- 解密 ----------------------------------------------------------------------

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('当前环境不支持 WebCrypto（需要 HTTPS 页面）');
  return c.subtle;
}

export function importAesKey(bytes) {
  if (bytes.byteLength !== 16) throw new Error(`AES-128 key 长度应为 16 字节，实际为 ${bytes.byteLength} 字节`);
  return subtle().importKey('raw', bytes, { name: 'AES-CBC' }, false, ['decrypt']);
}

/** AES-128-CBC 解密，WebCrypto 自动去除 PKCS#7 padding。 */
export async function decryptAes128(data, cryptoKey, iv) {
  return new Uint8Array(await subtle().decrypt({ name: 'AES-CBC', iv }, cryptoKey, data));
}

/** 粗略校验 MPEG-TS：第 0 和第 188 字节应为同步字节 0x47。IV/key 错误会破坏开头。 */
export function looksLikeTs(bytes) {
  if (!bytes || bytes.length < 1 || bytes[0] !== 0x47) return false;
  return bytes.length <= 188 || bytes[188] === 0x47;
}

// ---- 下载流程 --------------------------------------------------------------------

/**
 * 下载并解密一个 HLS 流，按 playlist 顺序调用 write(Uint8Array)。
 * request(url, 'text' | 'arraybuffer', signal, resource) => Promise<{ data, finalUrl }>，非 2xx 时抛出 HttpError。
 * resource 描述请求的是哪类资源（见 describeResource），只用于错误诊断。
 * onProgress({ phase, done, total, bytes, seconds, totalSeconds, badTs })
 */
export async function downloadHls({
  playlistUrl,
  request,
  write,
  onProgress = () => {},
  concurrency = 4,
  retryDelayMs = 1000,
  signal,
}) {
  const req = (url, type, resource) => abortable(request(url, type, signal, resource), signal);
  let res = await req(playlistUrl, 'text', { kind: 'm3u8' });
  let playlist = parseM3U8(res.data, res.finalUrl || playlistUrl);
  if (playlist.type === 'master') {
    const v = pickVariant(playlist.variants);
    res = await req(v.uri, 'text', { kind: 'm3u8-variant' });
    playlist = parseM3U8(res.data, res.finalUrl || v.uri);
    if (playlist.type !== 'media') throw new Error('无法解析多级 master playlist');
  }
  const { segments } = playlist;
  if (!segments.length) throw new Error('播放列表中没有分片');
  assertSupported(segments);

  const keys = new Map(); // key URI -> Promise<CryptoKey>，只在内存中
  const getKey = (uri) => {
    if (!keys.has(uri)) {
      const p = req(uri, 'arraybuffer', { kind: 'key' }).then((r) => importAesKey(new Uint8Array(r.data)));
      p.catch(() => keys.delete(uri)); // 失败（如网络错误）后允许重试时重新请求
      keys.set(uri, p);
    }
    return keys.get(uri);
  };

  const total = segments.length;
  const totalSeconds = segments.reduce((sum, seg) => sum + (seg.duration || 0), 0);
  const progress = { phase: 'download', done: 0, total, bytes: 0, seconds: 0, totalSeconds, badTs: 0 };
  onProgress({ ...progress });
  await fetchInOrder(total, {
    concurrency,
    signal,
    fetchOne: (i) =>
      withRetry(
        async () => {
          const seg = segments[i];
          const r = await req(seg.uri, 'arraybuffer', { kind: 'segment', index: i + 1, total });
          if (!seg.key) return new Uint8Array(r.data);
          const cryptoKey = await getKey(seg.key.uri);
          try {
            return await decryptAes128(r.data, cryptoKey, seg.key.iv || ivForSequence(seg.seq));
          } catch (e) {
            const err = new Error(`第 ${i + 1} 个分片解密失败（key 或 IV 不匹配）`);
            err.fatal = true;
            throw err;
          }
        },
        { delayMs: retryDelayMs, signal },
      ).catch((e) => {
        if (e.name !== 'AbortError' && !e.resource && !e.message.startsWith('第 ')) {
          e.message = `第 ${i + 1} / ${total} 个分片：${e.message}`;
        }
        throw e;
      }),
    onData: async (i, data) => {
      await abortable(Promise.resolve(write(data)), signal);
      progress.done = i + 1;
      progress.bytes += data.byteLength;
      progress.seconds += segments[i].duration || 0;
      if (!looksLikeTs(data)) progress.badTs += 1;
      onProgress({ ...progress });
    },
  });
  return { segments: total, duration: totalSeconds, bytes: progress.bytes, badTs: progress.badTs };
}

// ---- 浏览器端：请求与保存 -------------------------------------------------------------

// ---- 请求诊断 ----------------------------------------------------------------------

/** resource: { kind: 'playVideo' | 'frame' | 'm3u8' | 'm3u8-variant' | 'key' | 'segment', index?, total? } */
export function describeResource(resource) {
  const r = resource || {};
  switch (r.kind) {
    case 'playVideo':
      return 'playVideo 页面';
    case 'frame':
      return '播放页 iframe';
    case 'm3u8':
      return 'm3u8 播放列表';
    case 'm3u8-variant':
      return 'm3u8 子播放列表';
    case 'key':
      return 'AES key';
    case 'segment':
      return r.index ? `TS 分片 ${r.index}/${r.total}` : 'TS 分片';
    default:
      return '资源';
  }
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return '(无效 URL)';
  }
}

/**
 * 给请求错误补充“哪个资源、哪个域名”，并在 Console 输出诊断信息。
 * HttpError 的 status 保持不变，因此 401/403 仍然不重试。
 */
export function annotateRequestError(err, { url, type, resource, via, detail }) {
  const hostname = hostnameOf(url);
  const what = describeResource(resource);
  const sep = /[A-Za-z0-9]$/.test(what) ? ' ' : ''; // “请求 AES key 失败” / “请求 m3u8 播放列表失败”
  err.message = `请求 ${what}${sep}失败（${hostname}）：${err.message}`;
  err.resource = { ...(resource || {}), name: what, url, hostname, type };
  console.warn(`[Course Fetch] request failed: ${url}`, {
    resource: what,
    hostname,
    type,
    via,
    status: err.status,
    message: err.message,
    detail,
  });
  return err;
}

function networkErrorMessage(r, hostname) {
  const reason = r && (r.error || r.statusText);
  let msg = `网络错误（${reason ? `Tampermonkey: ${reason}` : 'Tampermonkey 未返回详细原因'}）`;
  if (!/(^|\.)pku\.edu\.cn$/i.test(hostname)) {
    msg += `；${hostname} 不在 @connect 列表中，请在 Tampermonkey 弹窗中允许该域名，或在脚本头部添加 // @connect ${hostname}`;
  } else {
    msg += '；如果 Tampermonkey 拦截了跨域请求，请允许该域名';
  }
  return msg;
}

/** 用当前登录会话请求资源。有 GM_xmlhttpRequest 时用它（可跨域），否则退回同源 fetch。 */
export function gmRequest(url, type, signal, resource) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const fail = (err, via, detail) => reject(annotateRequestError(err, { url, type, resource, via, detail }));
    if (typeof GM_xmlhttpRequest !== 'function') {
      fetch(url, { credentials: 'include', signal })
        .then(async (res) => {
          if (!res.ok) {
            const err = new HttpError(res.status);
            err.detail = { status: res.status, statusText: res.statusText, finalUrl: res.url };
            throw err;
          }
          resolve({ data: type === 'text' ? await res.text() : await res.arrayBuffer(), finalUrl: res.url });
        })
        .catch((e) => {
          if (e && e.name === 'AbortError') return reject(abortError());
          fail(e, 'fetch', e.detail || e);
        });
      return;
    }
    // 跨域（如 resourcese.pku.edu.cn）需要 GM_xmlhttpRequest，携带该域名下浏览器已有的 cookie
    const onAbort = () => {
      try {
        xhr && xhr.abort();
      } catch (_) {
        /* ignore */
      }
      reject(abortError());
    };
    const done = () => signal && signal.removeEventListener('abort', onAbort);
    const xhr = GM_xmlhttpRequest({
      method: 'GET',
      url,
      responseType: type === 'text' ? undefined : 'arraybuffer',
      timeout: 60000,
      onload: (r) => {
        done();
        if (r.status < 200 || r.status >= 300) {
          // 不记录 response（可能是 key 内容），只记录状态和最终地址
          return fail(new HttpError(r.status), 'GM_xmlhttpRequest', {
            status: r.status,
            statusText: r.statusText,
            finalUrl: r.finalUrl,
            responseHeaders: r.responseHeaders,
          });
        }
        resolve({ data: type === 'text' ? r.responseText : r.response, finalUrl: r.finalUrl || url });
      },
      onerror: (r) => {
        done();
        // 完整记录 Tampermonkey 返回的错误对象（error / status / finalUrl / readyState 等）
        fail(new Error(networkErrorMessage(r, hostnameOf(url))), 'GM_xmlhttpRequest', r);
      },
      ontimeout: (r) => {
        done();
        fail(new Error('请求超时（60 秒）'), 'GM_xmlhttpRequest', r);
      },
      onabort: () => {
        done();
        reject(abortError());
      },
    });
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function saveBlob(blob, filename, onRelease) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  try {
    document.body.appendChild(a);
    a.click();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  } finally { a.remove(); }
  setTimeout(() => {
    URL.revokeObjectURL(url);
    if (onRelease) Promise.resolve().then(onRelease).catch(() => {});
  }, 60000);
}

/**
 * 内存合并：完成时一次交给浏览器下载。只在浏览器或页面不支持目录写入时使用（见 directory.js）。
 * writeAt 只能覆盖已写入的某一整块之内的字节（MP4 文件头）。
 */
export function memorySink(filename, save = saveBlob) {
  const mime = /\.mp4$/i.test(filename) ? 'video/mp4' : 'video/mp2t';
  let chunks = [];
  return {
    kind: 'memory',
    write: (d) => {
      chunks.push(d);
    },
    writeAt: (position, data) => {
      let o = 0;
      for (const [i, c] of chunks.entries()) {
        if (position >= o && position + data.length <= o + c.length) {
          const copy = c.slice();
          copy.set(data, position - o);
          chunks[i] = copy;
          return;
        }
        o += c.length;
      }
      throw new Error('内存写入位置无效');
    },
    close: async () => {
      await save(new Blob(chunks, { type: mime }), filename);
      chunks = [];
    },
    abort: () => {
      chunks = [];
    },
  };
}
