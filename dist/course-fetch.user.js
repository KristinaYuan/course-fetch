// ==UserScript==
// @name         Course Fetch
// @namespace    https://github.com/MiniYuanBot/course-fetch
// @version      0.3.0
// @description  北大教学网课堂实录：枚举整门课程录像、排序、命名、导出 manifest，支持单条和批量下载，无损保存为 MP4。
// @homepageURL  https://github.com/MiniYuanBot/course-fetch
// @supportURL   https://github.com/MiniYuanBot/course-fetch/issues
// @updateURL    https://github.com/MiniYuanBot/course-fetch/releases/latest/download/course-fetch.user.js
// @downloadURL  https://github.com/MiniYuanBot/course-fetch/releases/latest/download/course-fetch.user.js
// @match        *://*.pku.edu.cn/*videoList.action*
// @match        *://*.pku.edu.cn/*playVideo.action*
// @match        *://onlineroomse.pku.edu.cn/*
// @include      /^https?:\/\/[^/]*pku\.edu\.cn\/.*videoList\.action.*/
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @connect      pku.edu.cn
// @connect      self
// @run-at       document-idle
// ==/UserScript==

/*
 * 功能：课程录像枚举、metadata 解析、排序、命名、工作流辅助；单条和批量录像下载（标准 HLS AES-128）。
 * 下载只使用当前浏览器登录会话本来就能访问的 m3u8 / key / 分片：遇到 401/403 直接失败，
 * 不做任何登录或权限绕过；不支持 SAMPLE-AES、非 identity KEYFORMAT 等 DRM 方案。
 * “观看”链接和 AES key 只保存在内存中，不写入 storage / manifest / 剪贴板清单。
 * m3u8 地址由临时打开的播放页自动捕获，经 GM storage 短暂传回列表页，读取后立即删除。
 * 播放页 / 播放器 iframe 上只在下载时存在未过期的 capture 请求时才运行捕获，平时什么都不做。
 *
 * 本文件由 src/ 下的模块经 esbuild 打包生成，请修改 src/ 后运行 npm run build。
 */
(() => {
  // src/parser.js
  var DEFAULT_TEMPLATE = "L{index:02d}-{date}-第{periodStart}-{periodEnd}节.mp4";
  var DATE_PERIOD_RE = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\s*第\s*(\d{1,2})\s*(?:[-－–—~～至到]\s*(\d{1,2}))?\s*节/;
  var DATETIME_RE = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/;
  var TIME_RE = new RegExp("时间\\s*[:：]\\s*" + DATETIME_RE.source);
  var TEACHER_RE = /教师\s*[:：]\s*(.*?)\s*(?:操作\s*[:：]|观看|$)/;
  var pad2 = (n) => String(n).padStart(2, "0");
  var ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
  function normalizeText(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  }
  function parseTitle(title) {
    const m = DATE_PERIOD_RE.exec(normalizeText(title));
    if (!m) return { ok: false, error: "无法解析日期/节次" };
    const periodStart = Number(m[4]);
    const periodEnd = m[5] ? Number(m[5]) : periodStart;
    if (periodEnd < periodStart) return { ok: false, error: "节次范围异常" };
    return { ok: true, date: ymd(m[1], m[2], m[3]), periodStart, periodEnd };
  }
  function formatDateTime(m) {
    return m ? `${ymd(m[1], m[2], m[3])} ${pad2(m[4])}:${m[5]}:${m[6] || "00"}` : null;
  }
  function parseStructuredRow({ title, startTime, teacher }) {
    const text = [title, startTime, teacher].map(normalizeText).join(" | ");
    const p = parseTitle(title);
    if (!p.ok) return { ok: false, error: p.error, text };
    return {
      ok: true,
      entry: {
        date: p.date,
        periodStart: p.periodStart,
        periodEnd: p.periodEnd,
        startTime: formatDateTime(DATETIME_RE.exec(normalizeText(startTime))),
        teacher: normalizeText(teacher)
      }
    };
  }
  function parseRowText(raw) {
    const text = normalizeText(raw);
    const p = parseTitle(text);
    if (!p.ok) return { ok: false, error: p.error, text };
    const tm = TEACHER_RE.exec(text);
    return {
      ok: true,
      entry: {
        date: p.date,
        periodStart: p.periodStart,
        periodEnd: p.periodEnd,
        startTime: formatDateTime(TIME_RE.exec(text)),
        teacher: tm ? tm[1].trim() : ""
      }
    };
  }
  function parseRows(rows) {
    const entries = [];
    const failures = [];
    for (const row of rows) {
      const r = row.cols ? parseStructuredRow(row.cols) : parseRowText(row.text);
      if (r.ok) entries.push({ ...r.entry, watchUrl: row.watchUrl || null, page: row.page });
      else failures.push({ error: r.error, text: r.text, page: row.page });
    }
    return { entries, failures };
  }
  function entryKey(e) {
    return `${e.date}|${e.periodStart}-${e.periodEnd}|${e.startTime || ""}`;
  }
  function compareEntries(a, b) {
    const ka = a.startTime || `${a.date} ~`;
    const kb = b.startTime || `${b.date} ~`;
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.periodStart - b.periodStart;
  }
  function dedupeAndSort(entries) {
    const seen = /* @__PURE__ */ new Map();
    const duplicates = [];
    for (const e of entries) {
      const k = entryKey(e);
      if (seen.has(k)) duplicates.push(e);
      else seen.set(k, e);
    }
    const sorted = [...seen.values()].sort(compareEntries).map((e, i) => ({ ...e, index: i + 1 }));
    return { entries: sorted, duplicates };
  }
  function sanitizeFilename(name) {
    const s = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
    return s || "untitled";
  }
  function formatFilename(template, entry, ctx = {}) {
    const vars = {
      index: entry.index,
      date: entry.date,
      periodStart: entry.periodStart,
      periodEnd: entry.periodEnd,
      teacher: entry.teacher || "",
      course: ctx.course || "",
      startTime: entry.startTime || "",
      time: entry.startTime ? entry.startTime.slice(11, 16).replace(":", "") : ""
    };
    const out = String(template || DEFAULT_TEMPLATE).replace(/\{(\w+)(?::0?(\d+)d)?\}/g, (all, name, width) => {
      if (!Object.prototype.hasOwnProperty.call(vars, name)) return all;
      const v = String(vars[name] == null ? "" : vars[name]);
      return width ? v.padStart(Number(width), "0") : v;
    });
    return sanitizeFilename(out);
  }
  var OUTPUT_FORMATS = ["mp4", "ts"];
  function withExtension(name, format) {
    return `${String(name).replace(/\.(mp4|ts|mkv|flv|mov)$/i, "")}.${format}`;
  }
  function parseCourseId(url) {
    const m = /[?&]course_id=([^&#]+)/.exec(String(url || ""));
    return m ? decodeURIComponent(m[1]) : "";
  }
  function buildManifest({ course, courseId, template, entries, generatedAt }) {
    const tpl = template || DEFAULT_TEMPLATE;
    return {
      schema: "course-fetch.manifest/v1",
      generatedAt: generatedAt || (/* @__PURE__ */ new Date()).toISOString(),
      course: { name: course || "", id: courseId || "" },
      template: tpl,
      count: entries.length,
      lectures: entries.map((e) => ({
        index: e.index,
        date: e.date,
        periodStart: e.periodStart,
        periodEnd: e.periodEnd,
        startTime: e.startTime,
        teacher: e.teacher,
        filename: formatFilename(tpl, e, { course })
      }))
    };
  }
  function buildListText({ course, template, entries }) {
    const lines = [`# ${course || "未命名课程"}（${entries.length} 条）`];
    for (const e of entries) {
      lines.push([formatFilename(template, e, { course }), e.startTime || e.date, e.teacher].join("	"));
    }
    return lines.join("\n");
  }
  function safeStringify(value) {
    const saved = Array.prototype.toJSON;
    if (saved) delete Array.prototype.toJSON;
    try {
      return JSON.stringify(value, null, 2);
    } finally {
      if (saved) Array.prototype.toJSON = saved;
    }
  }

  // src/hls.js
  var tagValue = (line) => line.slice(line.indexOf(":") + 1);
  function parseAttributes(str) {
    const attrs = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while (m = re.exec(str)) attrs[m[1]] = m[2].replace(/^"|"$/g, "");
    return attrs;
  }
  function parseHexIV(hex) {
    const h = String(hex).replace(/^0x/i, "");
    if (!/^[0-9a-f]{1,32}$/i.test(h)) throw new Error(`无效的 IV：${hex}`);
    const padded = h.padStart(32, "0");
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(padded.substr(i * 2, 2), 16);
    return out;
  }
  function ivForSequence(seq) {
    const out = new Uint8Array(16);
    let n = BigInt(seq);
    for (let i = 15; i >= 0 && n > 0n; i--) {
      out[i] = Number(n & 0xffn);
      n >>= 8n;
    }
    return out;
  }
  function parseM3U8(text, baseUrl) {
    const lines = String(text).replace(/^﻿/, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines[0] !== "#EXTM3U") throw new Error("不是有效的 m3u8 播放列表（登录可能已失效）");
    let mediaSequence = 0;
    let key = null;
    let duration = null;
    let variant = null;
    let endList = false;
    const segments = [];
    const variants = [];
    for (const line of lines.slice(1)) {
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        mediaSequence = parseInt(tagValue(line), 10) || 0;
      } else if (line.startsWith("#EXT-X-KEY:")) {
        const a = parseAttributes(tagValue(line));
        const method = (a.METHOD || "NONE").toUpperCase();
        key = method === "NONE" ? null : {
          method,
          uri: a.URI ? new URL(a.URI, baseUrl).href : null,
          iv: a.IV ? parseHexIV(a.IV) : null,
          keyformat: a.KEYFORMAT || "identity"
        };
      } else if (line.startsWith("#EXTINF:")) {
        duration = parseFloat(tagValue(line));
      } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
        const a = parseAttributes(tagValue(line));
        variant = { bandwidth: Number(a.BANDWIDTH) || 0, resolution: a.RESOLUTION || "" };
      } else if (line.startsWith("#EXT-X-BYTERANGE") || line.startsWith("#EXT-X-MAP")) {
        throw new Error(`暂不支持 ${line.split(":")[0]}`);
      } else if (line === "#EXT-X-ENDLIST") {
        endList = true;
      } else if (!line.startsWith("#")) {
        const uri = new URL(line, baseUrl).href;
        if (variant) {
          variants.push({ ...variant, uri });
          variant = null;
        } else {
          segments.push({ uri, duration, seq: mediaSequence + segments.length, key });
          duration = null;
        }
      }
    }
    if (variants.length) return { type: "master", variants };
    return { type: "media", mediaSequence, endList, segments };
  }
  function pickVariant(variants) {
    return variants.reduce((best, v) => v.bandwidth > best.bandwidth ? v : best, variants[0]);
  }
  function assertSupported(segments) {
    for (const seg of segments) {
      const k = seg.key;
      if (!k) continue;
      if (k.method !== "AES-128" || String(k.keyformat).toLowerCase() !== "identity") {
        throw new Error(
          `不支持的加密方式 ${k.method}${k.keyformat !== "identity" ? ` / ${k.keyformat}` : ""}（可能是 DRM 保护，本工具不处理）`
        );
      }
      if (!k.uri) throw new Error("EXT-X-KEY 缺少 URI");
    }
  }

  // src/downloader.js
  var HttpError = class extends Error {
    constructor(status) {
      super(
        status === 401 || status === 403 ? `无权限访问（HTTP ${status}），请确认已登录且能在教学网正常播放该录像` : `HTTP ${status}`
      );
      this.status = status;
    }
  };
  function abortError() {
    const e = new Error("已取消");
    e.name = "AbortError";
    return e;
  }
  function throwIfAborted(signal) {
    if (signal && signal.aborted) throw abortError();
  }
  function abortable(promise, signal) {
    promise = Promise.resolve(promise);
    if (!signal) return promise;
    if (signal.aborted) {
      promise.catch(() => {
      });
      return Promise.reject(abortError());
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        }
      );
    });
  }
  var sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  async function withRetry(fn, { attempts = 3, delayMs = 1e3, signal } = {}) {
    for (let i = 1; ; i++) {
      throwIfAborted(signal);
      try {
        return await fn();
      } catch (e) {
        if (e.name === "AbortError" || signal && signal.aborted) throw abortError();
        if (i >= attempts || e.fatal || e.status >= 400 && e.status < 500) throw e;
        await sleep(delayMs * i, signal);
      }
    }
  }
  function withTimeout(promise, ms) {
    let timer;
    return Promise.race([Promise.resolve(promise).catch(() => {
    }), new Promise((r) => {
      timer = setTimeout(r, ms);
    })]).finally(() => clearTimeout(timer));
  }
  async function fetchInOrder(count, { concurrency = 4, fetchOne, onData, signal }) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError("分片并发数必须是正整数");
    throwIfAborted(signal);
    const pending = /* @__PURE__ */ new Map();
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
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
        stop.abort();
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
        pending.delete(i);
        throwIfAborted(stop.signal);
        if (next < count) start();
      }
    } catch (error) {
      throw firstError || error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      pending.clear();
    }
  }
  function subtle() {
    const c = globalThis.crypto;
    if (!c || !c.subtle) throw new Error("当前环境不支持 WebCrypto（需要 HTTPS 页面）");
    return c.subtle;
  }
  function importAesKey(bytes2) {
    if (bytes2.byteLength !== 16) throw new Error(`AES-128 key 长度应为 16 字节，实际为 ${bytes2.byteLength} 字节`);
    return subtle().importKey("raw", bytes2, { name: "AES-CBC" }, false, ["decrypt"]);
  }
  async function decryptAes128(data, cryptoKey, iv) {
    return new Uint8Array(await subtle().decrypt({ name: "AES-CBC", iv }, cryptoKey, data));
  }
  function looksLikeTs(bytes2) {
    if (!bytes2 || bytes2.length < 1 || bytes2[0] !== 71) return false;
    return bytes2.length <= 188 || bytes2[188] === 71;
  }
  async function downloadHls({
    playlistUrl,
    request,
    write,
    onProgress = () => {
    },
    concurrency = 4,
    retryDelayMs = 1e3,
    signal
  }) {
    const req = (url, type, resource) => abortable(request(url, type, signal, resource), signal);
    let res = await req(playlistUrl, "text", { kind: "m3u8" });
    let playlist = parseM3U8(res.data, res.finalUrl || playlistUrl);
    if (playlist.type === "master") {
      const v = pickVariant(playlist.variants);
      res = await req(v.uri, "text", { kind: "m3u8-variant" });
      playlist = parseM3U8(res.data, res.finalUrl || v.uri);
      if (playlist.type !== "media") throw new Error("无法解析多级 master playlist");
    }
    const { segments } = playlist;
    if (!segments.length) throw new Error("播放列表中没有分片");
    assertSupported(segments);
    const keys = /* @__PURE__ */ new Map();
    const getKey = (uri) => {
      if (!keys.has(uri)) {
        const p = req(uri, "arraybuffer", { kind: "key" }).then((r) => importAesKey(new Uint8Array(r.data)));
        p.catch(() => keys.delete(uri));
        keys.set(uri, p);
      }
      return keys.get(uri);
    };
    const total = segments.length;
    const totalSeconds = segments.reduce((sum, seg) => sum + (seg.duration || 0), 0);
    const progress = { phase: "download", done: 0, total, bytes: 0, seconds: 0, totalSeconds, badTs: 0 };
    onProgress({ ...progress });
    await fetchInOrder(total, {
      concurrency,
      signal,
      fetchOne: (i) => withRetry(
        async () => {
          const seg = segments[i];
          const r = await req(seg.uri, "arraybuffer", { kind: "segment", index: i + 1, total });
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
        { delayMs: retryDelayMs, signal }
      ).catch((e) => {
        if (e.name !== "AbortError" && !e.resource && !e.message.startsWith("第 ")) {
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
      }
    });
    return { segments: total, duration: totalSeconds, bytes: progress.bytes, badTs: progress.badTs };
  }
  function describeResource(resource) {
    const r = resource || {};
    switch (r.kind) {
      case "playVideo":
        return "playVideo 页面";
      case "frame":
        return "播放页 iframe";
      case "m3u8":
        return "m3u8 播放列表";
      case "m3u8-variant":
        return "m3u8 子播放列表";
      case "key":
        return "AES key";
      case "segment":
        return r.index ? `TS 分片 ${r.index}/${r.total}` : "TS 分片";
      default:
        return "资源";
    }
  }
  function hostnameOf(url) {
    try {
      return new URL(url).hostname;
    } catch (_) {
      return "(无效 URL)";
    }
  }
  function annotateRequestError(err, { url, type, resource, via, detail }) {
    const hostname = hostnameOf(url);
    const what = describeResource(resource);
    const sep = /[A-Za-z0-9]$/.test(what) ? " " : "";
    err.message = `请求 ${what}${sep}失败（${hostname}）：${err.message}`;
    err.resource = { ...resource || {}, name: what, url, hostname, type };
    console.warn(`[Course Fetch] request failed: ${url}`, {
      resource: what,
      hostname,
      type,
      via,
      status: err.status,
      message: err.message,
      detail
    });
    return err;
  }
  function networkErrorMessage(r, hostname) {
    const reason = r && (r.error || r.statusText);
    let msg = `网络错误（${reason ? `Tampermonkey: ${reason}` : "Tampermonkey 未返回详细原因"}）`;
    if (!/(^|\.)pku\.edu\.cn$/i.test(hostname)) {
      msg += `；${hostname} 不在 @connect 列表中，请在 Tampermonkey 弹窗中允许该域名，或在脚本头部添加 // @connect ${hostname}`;
    } else {
      msg += "；如果 Tampermonkey 拦截了跨域请求，请允许该域名";
    }
    return msg;
  }
  function gmRequest(url, type, signal, resource) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError());
      const fail = (err, via, detail) => reject(annotateRequestError(err, { url, type, resource, via, detail }));
      if (typeof GM_xmlhttpRequest !== "function") {
        fetch(url, { credentials: "include", signal }).then(async (res) => {
          if (!res.ok) {
            const err = new HttpError(res.status);
            err.detail = { status: res.status, statusText: res.statusText, finalUrl: res.url };
            throw err;
          }
          resolve({ data: type === "text" ? await res.text() : await res.arrayBuffer(), finalUrl: res.url });
        }).catch((e) => {
          if (e && e.name === "AbortError") return reject(abortError());
          fail(e, "fetch", e.detail || e);
        });
        return;
      }
      const onAbort = () => {
        try {
          xhr && xhr.abort();
        } catch (_) {
        }
        reject(abortError());
      };
      const done = () => signal && signal.removeEventListener("abort", onAbort);
      const xhr = GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: type === "text" ? void 0 : "arraybuffer",
        timeout: 6e4,
        onload: (r) => {
          done();
          if (r.status < 200 || r.status >= 300) {
            return fail(new HttpError(r.status), "GM_xmlhttpRequest", {
              status: r.status,
              statusText: r.statusText,
              finalUrl: r.finalUrl,
              responseHeaders: r.responseHeaders
            });
          }
          resolve({ data: type === "text" ? r.responseText : r.response, finalUrl: r.finalUrl || url });
        },
        onerror: (r) => {
          done();
          fail(new Error(networkErrorMessage(r, hostnameOf(url))), "GM_xmlhttpRequest", r);
        },
        ontimeout: (r) => {
          done();
          fail(new Error("请求超时（60 秒）"), "GM_xmlhttpRequest", r);
        },
        onabort: () => {
          done();
          reject(abortError());
        }
      });
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  function saveBlob(blob, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 6e4);
  }
  function memorySink(filename, save = saveBlob) {
    const mime = /\.mp4$/i.test(filename) ? "video/mp4" : "video/mp2t";
    let chunks = [];
    return {
      kind: "memory",
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
        throw new Error("内存写入位置无效");
      },
      close: () => {
        save(new Blob(chunks, { type: mime }), filename);
        chunks = [];
      },
      abort: () => {
        chunks = [];
      }
    };
  }

  // src/storage.js
  var store = {
    get(k, d) {
      try {
        return typeof GM_getValue === "function" ? GM_getValue(k, d) : d;
      } catch (_) {
        return d;
      }
    },
    set(k, v) {
      try {
        if (typeof GM_setValue === "function") GM_setValue(k, v);
      } catch (_) {
      }
    },
    delete(k) {
      try {
        if (typeof GM_deleteValue === "function") GM_deleteValue(k);
      } catch (_) {
      }
    },
    /** 监听其它标签页 / frame 对 k 的修改，cb(newValue)。返回取消监听的函数。 */
    onChange(k, cb) {
      if (typeof GM_addValueChangeListener !== "function") return () => {
      };
      let id;
      try {
        id = GM_addValueChangeListener(k, (name, oldValue, newValue) => cb(newValue));
      } catch (_) {
        return () => {
        };
      }
      return () => {
        try {
          if (typeof GM_removeValueChangeListener === "function") GM_removeValueChangeListener(id);
        } catch (_) {
        }
      };
    }
  };

  // src/capture-context.js
  var PARAM = "course-fetch-capture";
  var REQUEST = "course-fetch:capture-context-request";
  var RESPONSE = "course-fetch:capture-context-response";
  function captureTabUrl(watchUrl, id) {
    const url = new URL(watchUrl);
    const fragment = url.hash.slice(1);
    url.hash = `${fragment ? `${fragment}&` : ""}${PARAM}=${encodeURIComponent(id)}`;
    return url.href;
  }
  function captureIdFromUrl(url) {
    try {
      return new URLSearchParams(new URL(url).hash.slice(1)).get(PARAM);
    } catch (_) {
      return null;
    }
  }
  function resolveCaptureId(win, timeoutMs = 3e3) {
    const ownId = captureIdFromUrl(win.location.href);
    if (ownId) return Promise.resolve(ownId);
    if (win.parent === win) return Promise.resolve(null);
    return new Promise((resolve) => {
      const finish = (id) => {
        clearTimeout(timeout);
        clearInterval(retry);
        win.removeEventListener("message", receive);
        win.removeEventListener("pagehide", leave);
        resolve(id);
      };
      const receive = (event) => {
        if (event.source === win.parent && event.data?.type === RESPONSE && typeof event.data.id === "string") finish(event.data.id);
      };
      const leave = () => finish(null);
      const ask = () => win.parent.postMessage({ type: REQUEST }, "*");
      win.addEventListener("message", receive);
      win.addEventListener("pagehide", leave, { once: true });
      const timeout = setTimeout(() => finish(null), timeoutMs);
      const retry = setInterval(ask, 100);
      ask();
    });
  }
  function bridgeCaptureId(win, id, valid) {
    const receive = (event) => {
      if (event.data?.type !== REQUEST || !valid()) return;
      for (let i = 0; i < win.frames.length; i++) {
        if (event.source === win.frames[i]) {
          event.source.postMessage({ type: RESPONSE, id }, event.origin === "null" ? "*" : event.origin);
          break;
        }
      }
    };
    win.addEventListener("message", receive);
    return () => win.removeEventListener("message", receive);
  }

  // src/capture.js
  var PENDING_KEY = "capture:pending";
  var RESULT_KEY = "capture:result";
  var CAPTURE_TIMEOUT_MS = 2e4;
  var pendingKey = (id) => `${PENDING_KEY}:${id}`;
  var resultKey = (id) => `${RESULT_KEY}:${id}`;
  function isM3u8Url(url) {
    return /^https?:\/\/\S+?\.m3u8(?:[?#]|$)/i.test(String(url || ""));
  }
  function watchM3u8Requests(onUrl, { perf = globalThis.performance, Observer = globalThis.PerformanceObserver, pollMs = 500 } = {}) {
    let stopped = false;
    const seen = /* @__PURE__ */ new Set();
    const check = (entries) => {
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
        check(perf.getEntriesByType("resource"));
      } catch (_) {
      }
    };
    try {
      if (perf && typeof perf.setResourceTimingBufferSize === "function") perf.setResourceTimingBufferSize(1e3);
    } catch (_) {
    }
    let observer = null;
    if (typeof Observer === "function") {
      try {
        observer = new Observer((list) => check(list.getEntries()));
        observer.observe({ type: "resource", buffered: true });
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
  function nudgePlayback(doc) {
    if (!doc || typeof doc.querySelectorAll !== "function") return;
    const videos = doc.querySelectorAll("video");
    for (let i = 0; i < videos.length; i++) {
      try {
        videos[i].muted = true;
        const p = videos[i].play();
        if (p && typeof p.catch === "function") p.catch(() => {
        });
      } catch (_) {
      }
    }
  }
  async function runPlayerCapture({
    kv = store,
    now = Date.now,
    watch = watchM3u8Requests,
    host = typeof location !== "undefined" ? location.hostname : "",
    doc = typeof document !== "undefined" ? document : null,
    maxWaitMs = CAPTURE_TIMEOUT_MS,
    nudgeAfterMs = 3e3,
    win = typeof window !== "undefined" ? window : null,
    captureId
  } = {}) {
    const id = captureId || win && await resolveCaptureId(win, maxWaitMs);
    if (!id) return false;
    const key = pendingKey(id);
    const valid = () => {
      const pending = kv.get(key, null);
      return pending?.id === id && pending.expires > now();
    };
    if (!valid()) return false;
    console.info(`[Course Fetch] 正在捕获播放列表（${host}）`);
    let done = false;
    let stop = () => {
    };
    let unlisten = () => {
    };
    const stopBridge = win ? bridgeCaptureId(win, id, valid) : () => {
    };
    const finish = () => {
      if (done) return;
      done = true;
      stop();
      unlisten();
      stopBridge();
      clearTimeout(giveUp);
      clearTimeout(nudge);
      clearInterval(poll);
      win?.removeEventListener("pagehide", finish);
    };
    const giveUp = setTimeout(finish, maxWaitMs);
    const nudge = setTimeout(() => nudgePlayback(doc), nudgeAfterMs);
    const poll = setInterval(() => {
      if (!valid()) finish();
    }, 500);
    unlisten = kv.onChange(key, () => {
      if (!valid()) finish();
    });
    win?.addEventListener("pagehide", finish, { once: true });
    stop = watch((url) => {
      if (done) return;
      finish();
      if (valid() && isM3u8Url(url)) kv.set(resultKey(id), { id, url, host });
    });
    if (done) stop();
    return true;
  }
  function openCaptureTab(url) {
    if (typeof GM_openInTab === "function") return GM_openInTab(url, { active: false, insert: true, setParent: true });
    return window.open(url, "_blank");
  }
  function captureTimeoutError(ms) {
    const e = new Error(`自动捕获播放列表超时（${Math.round(ms / 1e3)} 秒）`);
    e.name = "CaptureTimeout";
    return e;
  }
  function capturePlaylist({
    watchUrl,
    signal,
    timeoutMs = CAPTURE_TIMEOUT_MS,
    kv = store,
    openTab = openCaptureTab,
    newId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    pollMs = 500
  }) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError());
      const id = newId();
      const pending = pendingKey(id);
      const result = resultKey(id);
      let tab = null;
      let done = false;
      let unlisten = () => {
      };
      let poll = null;
      let timer = null;
      const finish = (settle, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        unlisten();
        if (signal) signal.removeEventListener("abort", onAbort);
        kv.delete(pending);
        kv.delete(result);
        try {
          if (tab && typeof tab.close === "function") tab.close();
        } catch (_) {
        }
        settle(value);
      };
      const accept = (val) => {
        if (val && val.id === id && isM3u8Url(val.url)) {
          console.info(`[Course Fetch] 已捕获播放列表（来自 ${val.host || "播放页"}）`);
          finish(resolve, val.url);
        }
      };
      const onAbort = () => finish(reject, abortError());
      kv.set(pending, { id, expires: Date.now() + timeoutMs + 5e3 });
      unlisten = kv.onChange(result, accept);
      poll = setInterval(() => accept(kv.get(result, null)), pollMs);
      timer = setTimeout(() => finish(reject, captureTimeoutError(timeoutMs)), timeoutMs);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      try {
        tab = openTab(captureTabUrl(watchUrl, id));
        if (done && tab && typeof tab.close === "function") tab.close();
      } catch (e) {
        finish(reject, e);
      }
    });
  }

  // src/page.js
  function resolveUrl(href, base) {
    const h = String(href || "").trim();
    if (!h || h === "#" || /^javascript:/i.test(h)) return null;
    try {
      const u = new URL(h, base);
      return /^https?:$/.test(u.protocol) ? u.href : null;
    } catch (_) {
      return null;
    }
  }
  function linkTarget(a, base) {
    const href = a.getAttribute("href");
    const direct = resolveUrl(href, base);
    if (direct) return direct;
    const src = `${href || ""} ${a.getAttribute("onclick") || ""}`;
    const m = /['"]([^'"\s]+\.(?:action|do|jsp|php|html?)(?:\?[^'"\s]*)?)['"]/i.exec(src);
    return m ? resolveUrl(m[1], base) : null;
  }
  function toList(collection) {
    const out = [];
    if (collection) for (let i = 0; i < collection.length; i++) out.push(collection[i]);
    return out;
  }
  function textOf(node) {
    return node && typeof node.textContent === "string" ? normalizeText(node.textContent) : "";
  }
  function rowText(tr) {
    const cells = toList(tr.cells || tr.children);
    if (cells.length) return cells.map(textOf).join(" ");
    return textOf(tr);
  }
  function extractCols(tr) {
    if (typeof tr.querySelector !== "function") return null;
    const th = tr.querySelector('th[scope="row"]');
    const values = toList(tr.querySelectorAll("td .table-data-cell-value"));
    if (!th || values.length < 2) return null;
    return {
      cols: { title: textOf(th), startTime: textOf(values[0]), teacher: textOf(values[1]) },
      link: values[2] ? values[2].querySelector("a") : null
    };
  }
  function extractPage(doc, baseUrl) {
    const rows = [];
    const issues = [];
    let next = null;
    for (const a of toList(doc.querySelectorAll("a"))) {
      const label = textOf(a);
      if (label === "观看") {
        const tr = a.closest ? a.closest("tr") : null;
        if (!tr) {
          issues.push("有一个“观看”链接不在表格行内，已跳过");
          continue;
        }
        const s = extractCols(tr);
        if (s) rows.push({ cols: s.cols, watchUrl: linkTarget(s.link || a, baseUrl) });
        else rows.push({ text: rowText(tr), watchUrl: linkTarget(a, baseUrl) });
      } else if (label === "前进" && !next) {
        next = { url: linkTarget(a, baseUrl), hasHref: a.getAttribute("href") != null };
      }
    }
    return { rows, next, issues };
  }
  function rowKey(row) {
    const r = row.cols ? parseStructuredRow(row.cols) : parseRowText(row.text);
    return r.ok ? entryKey(r.entry) : `raw:${r.text}`;
  }
  async function crawlCourse({ firstDoc, firstUrl, fetchDoc, maxPages = 50, onProgress = () => {
  } }) {
    const stripHash = (u) => String(u).split("#")[0];
    const warnings = [];
    const rows = [];
    const seen = /* @__PURE__ */ new Set();
    const visited = /* @__PURE__ */ new Set([stripHash(firstUrl)]);
    let pageNo = 1;
    const addPage = (pg, n) => {
      for (const r of pg.rows) {
        rows.push({ ...r, page: n });
        seen.add(rowKey(r));
      }
      pg.issues.forEach((msg) => warnings.push(`第 ${n} 页：${msg}`));
    };
    let page = extractPage(firstDoc, firstUrl);
    addPage(page, 1);
    while (page.next) {
      if (!page.next.url) {
        if (page.next.hasHref) {
          warnings.push(`第 ${pageNo} 页的“前进”链接是脚本跳转，无法自动请求；只收集到前 ${pageNo} 页`);
        }
        break;
      }
      const url = stripHash(page.next.url);
      if (visited.has(url)) {
        warnings.push("“前进”链接指向已读取过的页面，停止翻页");
        break;
      }
      if (pageNo >= maxPages) {
        warnings.push(`已达到最大页数 ${maxPages}，停止翻页`);
        break;
      }
      visited.add(url);
      onProgress(`正在读取第 ${pageNo + 1} 页…`);
      let doc;
      try {
        doc = await fetchDoc(url);
      } catch (e) {
        warnings.push(`读取第 ${pageNo + 1} 页失败（${e.message}），已保留前 ${pageNo} 页的结果`);
        break;
      }
      const next = extractPage(doc, url);
      if (next.rows.length && next.rows.every((r) => seen.has(rowKey(r)))) break;
      pageNo += 1;
      page = next;
      if (!page.rows.length) warnings.push(`第 ${pageNo} 页没有找到“观看”条目（登录可能已过期）`);
      addPage(page, pageNo);
    }
    const { entries, failures } = parseRows(rows);
    const { entries: sorted, duplicates } = dedupeAndSort(entries);
    failures.forEach((f) => warnings.push(`第 ${f.page} 页：${f.error}：“${f.text.slice(0, 60)}”`));
    if (duplicates.length) warnings.push(`发现 ${duplicates.length} 条重复录像，已合并`);
    if (!rows.length) warnings.push("当前页面没有找到文本为“观看”的链接");
    const status = `共 ${pageNo} 页，${sorted.length} 条录像` + (failures.length ? `，${failures.length} 行解析失败` : "");
    return { entries: sorted, duplicates, failures, warnings, pages: pageNo, status };
  }
  async function locatePlaylist(watchUrl, { signal, capture = capturePlaylist, ask = askPlaylistUrl, allowManual = true } = {}) {
    try {
      return await capture({ watchUrl, signal });
    } catch (e) {
      if (e.name !== "CaptureTimeout" || !allowManual) throw e;
      console.warn(`[Course Fetch] ${e.message}，改为手动输入`);
    }
    if (signal && signal.aborted) throw abortError();
    return ask();
  }
  function askPlaylistUrl() {
    const manual = prompt(
      "自动捕获播放列表超时。\n可以打开该录像的播放页，按 F12 → Network 搜索 “m3u8”，复制请求地址粘贴到这里："
    );
    if (manual && /^https?:\/\/\S+\.m3u8/i.test(manual.trim())) return manual.trim();
    if (manual === null) throw abortError();
    throw new Error("未找到 playlist.m3u8");
  }
  function detectCourseName() {
    const docs = [document];
    for (const w of [window.parent, window.top]) {
      try {
        if (w && w !== window && w.document && !docs.includes(w.document)) docs.push(w.document);
      } catch (_) {
      }
    }
    const selectors = [
      "#courseMenuPalette_paletteTitleHeading",
      "#courseMenu_link",
      ".courseName",
      ".course-name",
      "#crumb_1"
    ];
    for (const d of docs) {
      for (const sel of selectors) {
        const el = d.querySelector(sel);
        if (!el) continue;
        const txt = normalizeText(el.textContent) || normalizeText(el.getAttribute("title"));
        if (txt && txt.length <= 80) return txt;
      }
    }
    for (const d of docs) {
      const body = normalizeText(d.body && d.body.textContent).slice(0, 5e3);
      const m = /课程名称\s*[:：]\s*([^\s|]+)/.exec(body);
      if (m) return m[1];
    }
    for (const d of docs) {
      const title = normalizeText(d.title);
      if (title && !/^(课堂实录|教学网|Blackboard|北京大学)/i.test(title)) return title;
    }
    return "";
  }
  async function fetchDocument(url) {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const headerCharset = (/charset=([\w-]+)/i.exec(res.headers.get("content-type") || "") || [])[1];
    const decode = (cs) => {
      try {
        return new TextDecoder(cs).decode(buf);
      } catch (_) {
        return null;
      }
    };
    let html = decode(headerCharset || document.characterSet || "utf-8") || decode("utf-8");
    if (!headerCharset) {
      const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(html.slice(0, 4096));
      if (meta && meta[1].toLowerCase() !== String(document.characterSet).toLowerCase()) {
        html = decode(meta[1]) || html;
      }
    }
    return new DOMParser().parseFromString(html, "text/html");
  }

  // src/scheduler.js
  function positiveInteger(value, name) {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} 必须是正整数`);
    return value;
  }
  function createRequestLimiter(limit = 8) {
    positiveInteger(limit, "请求上限");
    let active = 0;
    const queue = [];
    function pump() {
      while (active < limit && queue.length) {
        const job = queue.shift();
        job.signal?.removeEventListener("abort", job.onAbort);
        if (job.signal?.aborted) {
          job.reject(abortError());
          continue;
        }
        active++;
        Promise.resolve().then(() => {
          if (job.signal?.aborted) throw abortError();
          return job.fn();
        }).then(job.resolve, job.reject).finally(() => {
          active--;
          pump();
        });
      }
    }
    return {
      get active() {
        return active;
      },
      get queued() {
        return queue.length;
      },
      run(fn, signal) {
        if (signal?.aborted) return Promise.reject(abortError());
        return new Promise((resolve, reject) => {
          const job = { fn, signal, resolve, reject, onAbort: null };
          job.onAbort = () => {
            const index = queue.indexOf(job);
            if (index !== -1) queue.splice(index, 1);
            reject(abortError());
          };
          signal?.addEventListener("abort", job.onAbort, { once: true });
          queue.push(job);
          pump();
        });
      },
      wrap(request) {
        return (url, type, signal, resource) => this.run(() => request(url, type, signal, resource), signal);
      }
    };
  }

  // src/ts-demux.js
  var PACKET = 188;
  var STREAM_TYPE_NAMES = {
    1: "MPEG-1 视频",
    2: "MPEG-2 视频",
    3: "MPEG-1 音频（MP3）",
    4: "MPEG-2 音频（MP3）",
    6: "私有 PES 数据（可能是 AC-3 或字幕）",
    15: "AAC（ADTS）",
    16: "MPEG-4 Part 2 视频",
    17: "AAC（LATM）",
    27: "H.264/AVC",
    36: "H.265/HEVC",
    66: "AVS 视频",
    129: "AC-3",
    135: "E-AC-3",
    234: "VC-1"
  };
  var SUPPORTED_STREAM_TYPES = { 27: "video", 15: "audio" };
  var IGNORED_STREAM_TYPES = /* @__PURE__ */ new Set([5, 21, 134]);
  var streamTypeName = (type) => STREAM_TYPE_NAMES[type] || `未知类型 0x${type.toString(16).padStart(2, "0")}`;
  function concat(parts, size) {
    if (parts.length === 1) return parts[0];
    const out = new Uint8Array(size);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
  function readTimestamp(b, o) {
    return (b[o] & 14) * 536870912 + b[o + 1] * 4194304 + (b[o + 2] & 254) * 16384 + b[o + 3] * 128 + (b[o + 4] >> 1);
  }
  var TsDemuxer = class {
    constructor() {
      this.carry = null;
      this.pmtPid = -1;
      this.streams = null;
      this.signature = "";
      this.kinds = /* @__PURE__ */ new Map();
      this.sections = /* @__PURE__ */ new Map();
      this.pes = /* @__PURE__ */ new Map();
      this.packets = 0;
      this.resyncs = 0;
      this.errors = 0;
    }
    /** 输入一块 TS 字节，返回在这块中结束的 PES：[{ pid, kind, pts, dts, data }]。 */
    push(chunk) {
      const out = [];
      let i = 0;
      if (this.carry) {
        const need = PACKET - this.carry.length;
        if (chunk.length < need) {
          this.carry = concat([this.carry, chunk], this.carry.length + chunk.length);
          return out;
        }
        const packet = concat([this.carry, chunk.subarray(0, need)], PACKET);
        this.carry = null;
        if (chunk.length === need || chunk[need] === 71) {
          this.packet(packet, 0, out);
          i = need;
        } else {
          this.resyncs++;
        }
      }
      const n = chunk.length;
      while (i < n) {
        if (chunk[i] !== 71) {
          const j = this.resync(chunk, i);
          if (j < 0) break;
          i = j;
        }
        if (i + PACKET > n) {
          this.carry = chunk.slice(i);
          break;
        }
        this.packet(chunk, i, out);
        i += PACKET;
      }
      return out;
    }
    /** 输入结束：输出所有未结束的 PES。 */
    flush() {
      const out = [];
      for (const [pid, s] of this.pes) this.emit(pid, s, out);
      this.pes.clear();
      this.carry = null;
      return out;
    }
    resync(chunk, i) {
      this.resyncs++;
      for (let j = i + 1; j < chunk.length; j++) {
        if (chunk[j] === 71 && (j + PACKET >= chunk.length || chunk[j + PACKET] === 71)) return j;
      }
      return -1;
    }
    packet(d, off, out) {
      this.packets++;
      if (d[off + 1] & 128) {
        this.errors++;
        return;
      }
      const pusi = (d[off + 1] & 64) !== 0;
      const pid = (d[off + 1] & 31) << 8 | d[off + 2];
      const afc = d[off + 3] >> 4 & 3;
      let p = off + 4;
      if (afc & 2) p += 1 + d[off + 4];
      if (!(afc & 1) || p >= off + PACKET) return;
      const payload = d.subarray(p, off + PACKET);
      if (pid === 0) this.section(pid, pusi, payload, (s) => this.parsePat(s));
      else if (pid === this.pmtPid) this.section(pid, pusi, payload, (s) => this.parsePmt(s));
      else if (this.kinds.has(pid)) this.pesPacket(pid, pusi, payload, out);
    }
    section(pid, pusi, payload, onSection) {
      let s = this.sections.get(pid);
      if (pusi) {
        const start = 1 + payload[0];
        if (start >= payload.length) return;
        s = { parts: [payload.subarray(start)], size: payload.length - start };
      } else if (s) {
        s.parts.push(payload);
        s.size += payload.length;
      } else {
        return;
      }
      const buf = concat(s.parts, s.size);
      if (buf.length >= 3) {
        const len = 3 + ((buf[1] & 15) << 8 | buf[2]);
        if (buf.length >= len) {
          this.sections.delete(pid);
          onSection(buf.subarray(0, len));
          return;
        }
      }
      this.sections.set(pid, { parts: [buf], size: buf.length });
    }
    parsePat(s) {
      if (s[0] !== 0) return;
      for (let o = 8; o + 4 <= s.length - 4; o += 4) {
        const program = s[o] << 8 | s[o + 1];
        if (program === 0) continue;
        this.pmtPid = (s[o + 2] & 31) << 8 | s[o + 3];
        return;
      }
    }
    parsePmt(s) {
      if (s[0] !== 2) return;
      const end = s.length - 4;
      const streams = [];
      for (let o = 12 + ((s[10] & 15) << 8 | s[11]); o + 5 <= end; ) {
        const type = s[o];
        const pid = (s[o + 1] & 31) << 8 | s[o + 2];
        const kind = SUPPORTED_STREAM_TYPES[type] || (IGNORED_STREAM_TYPES.has(type) ? "ignored" : "unsupported");
        streams.push({ pid, type, kind });
        o += 5 + ((s[o + 3] & 15) << 8 | s[o + 4]);
      }
      const signature = streams.map((x) => `${x.pid}:${x.type}`).join(",");
      if (this.streams) {
        if (signature !== this.signature) {
          const err = new Error("录像中途改变了音视频流结构（PMT），无法无损封装为单个 MP4");
          err.fatal = true;
          throw err;
        }
        return;
      }
      this.streams = streams;
      this.signature = signature;
      for (const x of streams) if (x.kind === "video" || x.kind === "audio") this.kinds.set(x.pid, x.kind);
    }
    pesPacket(pid, pusi, payload, out) {
      let s = this.pes.get(pid);
      if (pusi) {
        if (s) this.emit(pid, s, out);
        const len = payload.length >= 6 ? payload[4] << 8 | payload[5] : 0;
        s = { parts: [], size: 0, expected: len ? len + 6 : 0 };
        this.pes.set(pid, s);
      } else if (!s) {
        return;
      }
      s.parts.push(payload);
      s.size += payload.length;
      if (s.expected && s.size >= s.expected) {
        this.pes.delete(pid);
        this.emit(pid, s, out);
      }
    }
    emit(pid, s, out) {
      if (!s.size) return;
      const buf = concat(s.parts, s.size);
      if (buf.length < 9 || buf[0] !== 0 || buf[1] !== 0 || buf[2] !== 1) {
        this.errors++;
        return;
      }
      const flags = buf[7];
      const pts = flags & 128 ? readTimestamp(buf, 9) : null;
      const dts = flags & 64 ? readTimestamp(buf, 14) : pts;
      const end = s.expected ? Math.min(s.expected, buf.length) : buf.length;
      out.push({ pid, kind: this.kinds.get(pid), pts, dts, data: buf.subarray(9 + buf[8], end) });
    }
  };

  // src/codecs.js
  function splitAnnexB(data) {
    const nals = [];
    const n = data.length;
    let start = -1;
    let i = 0;
    while (i + 2 < n) {
      if (data[i + 2] > 1) {
        i += 3;
      } else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
        if (start >= 0) pushNal(nals, data, start, i);
        start = i + 3;
        i += 3;
      } else {
        i++;
      }
    }
    if (start >= 0) pushNal(nals, data, start, n);
    return nals;
  }
  function pushNal(nals, data, start, end) {
    while (end > start && data[end - 1] === 0) end--;
    if (end > start) nals.push(data.subarray(start, end));
  }
  function unescapeRbsp(nal) {
    const out = new Uint8Array(nal.length);
    let n = 0;
    let zeros = 0;
    for (let i = 0; i < nal.length; i++) {
      const byte = nal[i];
      if (zeros >= 2 && byte === 3) {
        zeros = 0;
        continue;
      }
      out[n++] = byte;
      zeros = byte === 0 ? zeros + 1 : 0;
    }
    return out.subarray(0, n);
  }
  var BitReader = class {
    constructor(bytes2) {
      this.bytes = bytes2;
      this.pos = 0;
    }
    u(bits) {
      let v = 0;
      for (let i = 0; i < bits; i++) {
        const byte = this.bytes[this.pos >> 3];
        if (byte === void 0) throw new Error("SPS 数据不完整");
        v = v * 2 + (byte >> 7 - (this.pos & 7) & 1);
        this.pos++;
      }
      return v;
    }
    ue() {
      let zeros = 0;
      while (this.u(1) === 0) if (++zeros > 31) throw new Error("SPS 中的 Exp-Golomb 数值无效");
      return 2 ** zeros - 1 + this.u(zeros);
    }
    se() {
      const k = this.ue();
      return k & 1 ? (k + 1) / 2 : -k / 2;
    }
  };
  var HIGH_PROFILES = /* @__PURE__ */ new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);
  function parseSps(nal) {
    const r = new BitReader(unescapeRbsp(nal.subarray(1)));
    const profileIdc = r.u(8);
    const constraintFlags = r.u(8);
    const levelIdc = r.u(8);
    r.ue();
    let chromaFormatIdc = 1;
    let separateColourPlane = 0;
    let bitDepthLuma = 8;
    let bitDepthChroma = 8;
    if (HIGH_PROFILES.has(profileIdc)) {
      chromaFormatIdc = r.ue();
      if (chromaFormatIdc === 3) separateColourPlane = r.u(1);
      bitDepthLuma = r.ue() + 8;
      bitDepthChroma = r.ue() + 8;
      r.u(1);
      if (r.u(1)) {
        for (let i = 0; i < (chromaFormatIdc !== 3 ? 8 : 12); i++) {
          if (!r.u(1)) continue;
          const size = i < 6 ? 16 : 64;
          let last = 8;
          let next = 8;
          for (let j = 0; j < size; j++) {
            if (next !== 0) next = (last + r.se() + 256) % 256;
            last = next === 0 ? last : next;
          }
        }
      }
    }
    r.ue();
    const pocType = r.ue();
    if (pocType === 0) r.ue();
    else if (pocType === 1) {
      r.u(1);
      r.se();
      r.se();
      const n = r.ue();
      for (let i = 0; i < n; i++) r.se();
    }
    r.ue();
    r.u(1);
    const widthMbs = r.ue() + 1;
    const heightMapUnits = r.ue() + 1;
    const frameMbsOnly = r.u(1);
    if (!frameMbsOnly) r.u(1);
    r.u(1);
    let crop = [0, 0, 0, 0];
    if (r.u(1)) crop = [r.ue(), r.ue(), r.ue(), r.ue()];
    const chroma = separateColourPlane ? 0 : chromaFormatIdc;
    const cropX = chroma === 1 || chroma === 2 ? 2 : 1;
    const cropY = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
    return {
      profileIdc,
      constraintFlags,
      levelIdc,
      chromaFormatIdc,
      bitDepthLuma,
      bitDepthChroma,
      highProfile: HIGH_PROFILES.has(profileIdc),
      width: widthMbs * 16 - cropX * (crop[0] + crop[1]),
      height: (2 - frameMbsOnly) * heightMapUnits * 16 - cropY * (crop[2] + crop[3])
    };
  }
  function ppsId(nal) {
    return new BitReader(unescapeRbsp(nal.subarray(1, 8))).ue();
  }
  var AAC_SAMPLE_RATES = [96e3, 88200, 64e3, 48e3, 44100, 32e3, 24e3, 22050, 16e3, 12e3, 11025, 8e3, 7350];
  function parseAdtsHeader(b, o) {
    if (o + 7 > b.length || b[o] !== 255 || (b[o + 1] & 246) !== 240) return null;
    const sampleRateIndex = b[o + 2] >> 2 & 15;
    return {
      headerLength: b[o + 1] & 1 ? 7 : 9,
      frameLength: (b[o + 3] & 3) << 11 | b[o + 4] << 3 | b[o + 5] >> 5,
      objectType: (b[o + 2] >> 6) + 1,
      sampleRateIndex,
      sampleRate: AAC_SAMPLE_RATES[sampleRateIndex] || 0,
      channelConfig: (b[o + 2] & 1) << 2 | b[o + 3] >> 6,
      rawBlocks: b[o + 6] & 3
    };
  }
  function audioSpecificConfig({ objectType, sampleRateIndex, channelConfig }) {
    return new Uint8Array([objectType << 3 | sampleRateIndex >> 1, (sampleRateIndex & 1) << 7 | channelConfig << 3]);
  }

  // src/mp4-mux.js
  var UINT32 = 4294967296;
  var GrowU32 = class {
    constructor(capacity = 1024) {
      this.data = new Uint32Array(capacity);
      this.length = 0;
    }
    push(v) {
      if (this.length === this.data.length) {
        const next = new Uint32Array(this.data.length * 2);
        next.set(this.data);
        this.data = next;
      }
      this.data[this.length++] = v;
    }
    get last() {
      return this.data[this.length - 1];
    }
    set last(v) {
      this.data[this.length - 1] = v;
    }
  };
  var RunTable = class {
    constructor() {
      this.counts = new GrowU32(64);
      this.values = new GrowU32(64);
    }
    add(value, count = 1) {
      if (this.counts.length && this.values.last === value >>> 0) this.counts.last += count;
      else {
        this.counts.push(count);
        this.values.push(value >>> 0);
      }
    }
    get length() {
      return this.counts.length;
    }
  };
  var ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  function bytes(...fields) {
    const size = fields.reduce((n, [bits]) => n + bits / 8, 0);
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    let o = 0;
    for (const [bits, value] of fields) {
      if (bits === 8) view.setUint8(o, value);
      else if (bits === 16) view.setUint16(o, value);
      else if (bits === 24) {
        view.setUint8(o, value >>> 16 & 255);
        view.setUint16(o + 1, value & 65535);
      } else if (bits === 32) view.setUint32(o, value >>> 0);
      else {
        view.setUint32(o, Math.floor(value / UINT32));
        view.setUint32(o + 4, value % UINT32);
      }
      o += bits / 8;
    }
    return out;
  }
  var u32 = (...values) => bytes(...values.map((v) => [32, v]));
  function box(type, ...parts) {
    const size = parts.reduce((n, p) => n + p.length, 8);
    const out = new Uint8Array(size);
    new DataView(out.buffer).setUint32(0, size);
    out.set(ascii(type), 4);
    let o = 8;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
  var fullBox = (type, version, flags, ...parts) => box(type, bytes([8, version], [24, flags]), ...parts);
  function u32Array(...arrays) {
    const n = arrays[0].length;
    const out = new Uint8Array(n * 4 * arrays.length);
    const view = new DataView(out.buffer);
    let o = 0;
    for (let i = 0; i < n; i++) {
      for (const a of arrays) {
        view.setUint32(o, a.data[i]);
        o += 4;
      }
    }
    return out;
  }
  var MATRIX = u32(65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824);
  var FTYP = box("ftyp", ascii("isom"), u32(512), ascii("isomiso2avc1mp41"));
  var MDAT_HEADER_SIZE = 16;
  function mdatHeader(payloadSize) {
    return concatBytes(u32(1), ascii("mdat"), bytes([64, payloadSize + MDAT_HEADER_SIZE]));
  }
  function concatBytes(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
  var Track = class {
    constructor(kind, timescale) {
      this.kind = kind;
      this.timescale = timescale;
      this.sizes = new GrowU32();
      this.stts = new RunTable();
      this.ctts = new RunTable();
      this.hasCts = false;
      this.sync = new GrowU32(256);
      this.chunkOffsets = [];
      this.stsc = [];
      this.lastDts = null;
      this.lastDuration = 0;
      this.duration = 0;
    }
    get count() {
      return this.sizes.length;
    }
    addSample(size, dts, cts, key) {
      if (this.lastDts !== null) {
        const d = dts - this.lastDts;
        if (!(d > 0)) throw new Error("内部错误：样本时间戳必须递增");
        this.stts.add(d);
        this.duration += d;
        this.lastDuration = d;
      }
      this.lastDts = dts;
      this.sizes.push(size);
      if (this.kind === "video") {
        if (cts) this.hasCts = true;
        this.ctts.add(cts);
        if (key) this.sync.push(this.count);
      }
    }
    growLast(extra) {
      this.sizes.last += extra;
    }
    /** 一段连续写入的样本（本轨道上一次 addChunk 之后新增的样本）。 */
    addChunk(offset, samples) {
      if (!samples) return;
      this.chunkOffsets.push(offset);
      const last = this.stsc[this.stsc.length - 1];
      if (!last || last[1] !== samples) this.stsc.push([this.chunkOffsets.length, samples]);
    }
    /** 结束：最后一个样本沿用前一个时长（单样本时用 defaultDuration）。 */
    close(defaultDuration) {
      const d = this.lastDuration || defaultDuration;
      this.stts.add(d);
      this.duration += d;
    }
  };
  function sampleEntry(track) {
    if (track.kind === "video") {
      const { sps, pps, info } = track.codec;
      const avcCParts = [
        bytes([8, 1], [8, info.profileIdc], [8, info.constraintFlags], [8, info.levelIdc], [8, 255], [8, 224 | 1], [16, sps.length]),
        sps,
        bytes([8, pps.length])
      ];
      for (const p of pps) avcCParts.push(bytes([16, p.length]), p);
      if (info.highProfile) {
        avcCParts.push(bytes([8, 252 | info.chromaFormatIdc], [8, 248 | info.bitDepthLuma - 8], [8, 248 | info.bitDepthChroma - 8], [8, 0]));
      }
      return box(
        "avc1",
        new Uint8Array(6),
        bytes([16, 1], [16, 0], [16, 0], [32, 0], [32, 0], [32, 0], [16, info.width], [16, info.height]),
        u32(4718592, 4718592, 0),
        bytes([16, 1]),
        new Uint8Array(32),
        // compressorname
        bytes([16, 24], [16, 65535]),
        box("avcC", ...avcCParts)
      );
    }
    const { config, channels, sampleRate } = track.codec;
    const descriptor = (tag, ...parts) => {
      const body = concatBytes(...parts);
      return concatBytes(bytes([8, tag], [8, body.length]), body);
    };
    const esds = fullBox(
      "esds",
      0,
      0,
      descriptor(
        3,
        bytes([16, track.id], [8, 0]),
        descriptor(4, bytes([8, 64], [8, 21], [24, 0], [32, track.codec.bitrate], [32, track.codec.bitrate]), descriptor(5, config)),
        descriptor(6, bytes([8, 2]))
      )
    );
    return box(
      "mp4a",
      new Uint8Array(6),
      bytes([16, 1], [32, 0], [32, 0], [16, channels], [16, 16], [16, 0], [16, 0], [32, sampleRate <= 65535 ? sampleRate * 65536 : 0]),
      esds
    );
  }
  function sampleTable(track) {
    const parts = [fullBox("stsd", 0, 0, u32(1), sampleEntry(track)), fullBox("stts", 0, 0, u32(track.stts.length), u32Array(track.stts.counts, track.stts.values))];
    if (track.hasCts) parts.push(fullBox("ctts", 0, 0, u32(track.ctts.length), u32Array(track.ctts.counts, track.ctts.values)));
    if (track.kind === "video" && track.sync.length < track.count) {
      parts.push(fullBox("stss", 0, 0, u32(track.sync.length), u32Array(track.sync)));
    }
    parts.push(fullBox("stsz", 0, 0, u32(0, track.count), u32Array(track.sizes)));
    parts.push(fullBox("stsc", 0, 0, u32(track.stsc.length), ...track.stsc.map(([first, n]) => u32(first, n, 1))));
    const offsets = track.chunkOffsets;
    if (offsets.length && offsets[offsets.length - 1] >= UINT32) {
      parts.push(fullBox("co64", 0, 0, u32(offsets.length), bytes(...offsets.map((o) => [64, o]))));
    } else {
      parts.push(fullBox("stco", 0, 0, u32(offsets.length, ...offsets)));
    }
    return box("stbl", ...parts);
  }
  var timeFields = (duration) => duration >= UINT32 ? [1, [64, 0], [64, 0]] : [0, [32, 0], [32, 0]];
  var durationField = (version, d) => version ? [64, d] : [32, d];
  function trak(track, movieTimescale) {
    const movieDuration = Math.round((track.emptyEdit + track.duration) / track.timescale * movieTimescale);
    const [tv, ...tTimes] = timeFields(movieDuration);
    const tkhd = fullBox(
      "tkhd",
      tv,
      3,
      bytes(...tTimes, [32, track.id], [32, 0], durationField(tv, movieDuration), [32, 0], [32, 0], [16, 0], [16, 0], [16, track.kind === "audio" ? 256 : 0], [16, 0]),
      MATRIX,
      u32(track.kind === "video" ? track.codec.info.width * 65536 : 0, track.kind === "video" ? track.codec.info.height * 65536 : 0)
    );
    const edits = [];
    const empty = Math.round(track.emptyEdit / track.timescale * movieTimescale);
    if (empty > 0) edits.push(u32(empty, 4294967295, 65536));
    edits.push(u32(Math.round(track.duration / track.timescale * movieTimescale), track.mediaTime, 65536));
    const [mv, ...mTimes] = timeFields(track.duration);
    const mdhd = fullBox("mdhd", mv, 0, bytes(...mTimes, [32, track.timescale], durationField(mv, track.duration), [16, 21956], [16, 0]));
    const handler = track.kind === "video" ? ["vide", "VideoHandler"] : ["soun", "SoundHandler"];
    const hdlr = fullBox("hdlr", 0, 0, u32(0), ascii(handler[0]), u32(0, 0, 0), ascii(`${handler[1]}\0`));
    const mediaHeader = track.kind === "video" ? fullBox("vmhd", 0, 1, new Uint8Array(8)) : fullBox("smhd", 0, 0, new Uint8Array(4));
    const dinf = box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));
    return box(
      "trak",
      tkhd,
      box("edts", fullBox("elst", 0, 0, u32(edits.length), ...edits)),
      box("mdia", mdhd, hdlr, box("minf", mediaHeader, dinf, sampleTable(track)))
    );
  }
  function buildMoov(tracks, movieTimescale = 1e3) {
    const traks = tracks.map((t) => trak(t, movieTimescale));
    const duration = Math.max(...tracks.map((t) => Math.round((t.emptyEdit + t.duration) / t.timescale * movieTimescale)));
    const [v, ...times] = timeFields(duration);
    const mvhd = fullBox(
      "mvhd",
      v,
      0,
      bytes(...times, [32, movieTimescale], durationField(v, duration), [32, 65536], [16, 256], [16, 0], [32, 0], [32, 0]),
      MATRIX,
      new Uint8Array(24),
      u32(Math.max(...tracks.map((t) => t.id)) + 1)
    );
    return box("moov", mvhd, ...traks);
  }

  // src/remux.js
  var WRAP = 2 ** 33;
  var HALF_WRAP = 2 ** 32;
  var MAX_STEP = 10 * 9e4;
  var PMT_DEADLINE = PACKET * 1024;
  var CHANNELS = [0, 1, 2, 3, 4, 5, 6, 8];
  var RemuxError = class extends Error {
    /** unsupported：编码无法无损放进 MP4，且尚未写出任何字节，调用方可以改存为 TS。 */
    constructor(message, { unsupported = false, reason = message } = {}) {
      super(message);
      this.name = "RemuxError";
      this.fatal = true;
      this.unsupported = unsupported;
      this.reason = reason;
    }
  };
  var unwrap = (ts, ref) => {
    if (ref === null) return ts;
    while (ts - ref > HALF_WRAP) ts -= WRAP;
    while (ref - ts > HALF_WRAP) ts += WRAP;
    return ts;
  };
  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function createMp4Remuxer({ write, writeAt }) {
    const demux = new TsDemuxer();
    const warnings = { timestamps: 0, droppedFrames: 0, corrupt: 0 };
    let started = false;
    let checked = false;
    let bytesIn = 0;
    let offset = FTYP.length + MDAT_HEADER_SIZE;
    let dataBytes = 0;
    const video = { track: null, sps: null, info: null, pps: /* @__PURE__ */ new Map(), keyed: false, lastRaw: null, lastT: null, shift: 0, firstPts: 0, firstCts: 0 };
    const audio = { track: null, codec: null, rest: null, lastRaw: null, lastT: null, base: 0, shift: 0, bytes: 0 };
    let chunk = { videoNals: [], videoSamples: 0, videoBytes: 0, audioFrames: [], audioBytes: 0 };
    const fail = (reason) => {
      throw new RemuxError(`${reason}，无法无损封装为 MP4`, { unsupported: !started, reason });
    };
    function checkStreams() {
      if (checked) return;
      if (!demux.streams) {
        if (bytesIn < PMT_DEADLINE) return;
        if (demux.packets * PACKET < bytesIn / 2) {
          throw new RemuxError("解密后的数据不是有效的 MPEG-TS（key 或 IV 可能不对），无法转封装");
        }
        fail("没有在录像开头找到 TS 节目表（PAT/PMT）");
      }
      const bad = demux.streams.filter((s) => s.kind === "unsupported");
      if (bad.length) fail(`录像包含 ${bad.map((s) => streamTypeName(s.type)).join("、")} 流`);
      const count = (kind) => demux.streams.filter((s) => s.kind === kind).length;
      if (count("video") > 1 || count("audio") > 1) fail("录像包含多条视频或音频流");
      if (!count("video") && !count("audio")) fail("录像中没有音视频流");
      checked = true;
    }
    function onParameterSet(nal, type) {
      if (type === 7) {
        if (!video.sps) {
          try {
            video.info = parseSps(nal);
          } catch (e) {
            fail(`无法解析 H.264 SPS（${e.message}）`);
          }
          video.sps = nal.slice();
        } else if (!sameBytes(video.sps, nal)) {
          fail("视频参数（分辨率或编码配置）在录像中途改变");
        }
      } else {
        const id = ppsId(nal);
        const prev = video.pps.get(id);
        if (!prev) video.pps.set(id, nal.slice());
        else if (!sameBytes(prev, nal)) fail("视频 PPS 参数在录像中途改变");
      }
    }
    function onVideo(unit) {
      const keep = [];
      let size = 0;
      let key = false;
      for (const nal of splitAnnexB(unit.data)) {
        const type = nal[0] & 31;
        if (type === 9) continue;
        if (type === 7 || type === 8) onParameterSet(nal, type);
        else if (type === 5) key = true;
        keep.push(nal);
        size += 4 + nal.length;
      }
      if (!keep.length) return;
      if (unit.pts === null) {
        if (chunk.videoSamples) {
          chunk.videoNals.push(...keep);
          chunk.videoBytes += size;
          video.track.growLast(size);
        } else warnings.droppedFrames++;
        return;
      }
      if (!video.keyed && !key) {
        warnings.droppedFrames++;
        return;
      }
      video.keyed = true;
      const dts = unwrap(unit.dts, video.lastRaw);
      const pts = unwrap(unit.pts, dts);
      let cts = pts - dts;
      if (cts < 0) {
        cts = 0;
        warnings.timestamps++;
      }
      let t;
      if (video.lastT === null) {
        video.track = new Track("video", 9e4);
        video.shift = dts;
        video.firstPts = pts;
        video.firstCts = cts;
        t = 0;
      } else {
        t = dts - video.shift;
        const step = t - video.lastT;
        if (step <= 0 || step > MAX_STEP) {
          const nominal = video.track.lastDuration || 3600;
          video.shift += step - nominal;
          t = video.lastT + nominal;
          warnings.timestamps++;
        }
      }
      video.lastRaw = dts;
      video.lastT = t;
      video.track.addSample(size, t, cts, key);
      chunk.videoNals.push(...keep);
      chunk.videoSamples++;
      chunk.videoBytes += size;
    }
    function onAudio(unit) {
      const restLength = audio.rest ? audio.rest.length : 0;
      let data = unit.data;
      if (audio.rest) {
        data = new Uint8Array(restLength + unit.data.length);
        data.set(audio.rest);
        data.set(unit.data, restLength);
        audio.rest = null;
      }
      const raw = unit.pts === null ? null : unwrap(unit.pts, audio.lastRaw);
      if (raw !== null) audio.lastRaw = raw;
      let o = 0;
      let index = 0;
      let lost = false;
      while (o + 7 <= data.length) {
        const h = parseAdtsHeader(data, o);
        if (!h) {
          if (!lost) warnings.corrupt++;
          lost = true;
          o++;
          continue;
        }
        lost = false;
        if (h.frameLength < h.headerLength) {
          warnings.corrupt++;
          o++;
          continue;
        }
        if (o + h.frameLength > data.length) break;
        if (!audio.codec) {
          if (!h.sampleRate || !h.channelConfig) fail("AAC 的采样率或声道配置无法写入 MP4");
          if (h.rawBlocks) fail("AAC ADTS 帧包含多个 raw data block");
          audio.codec = h;
          audio.track = new Track("audio", h.sampleRate);
        } else if (h.sampleRate !== audio.codec.sampleRate || h.channelConfig !== audio.codec.channelConfig || h.objectType !== audio.codec.objectType) {
          fail("音频参数（采样率、声道或 AAC 类型）在录像中途改变");
        } else if (h.rawBlocks) {
          fail("AAC ADTS 帧包含多个 raw data block");
        }
        const sr = audio.codec.sampleRate;
        const ownPts = o >= restLength && raw !== null;
        const framePts = ownPts ? raw + index * 1024 * 9e4 / sr : null;
        if (o >= restLength) index++;
        let t;
        if (audio.lastT === null) {
          if (framePts === null) {
            o += h.frameLength;
            warnings.droppedFrames++;
            continue;
          }
          audio.base = framePts;
          t = 0;
        } else {
          const expected = audio.lastT + 1024;
          t = expected;
          if (framePts !== null) {
            const gap = Math.round((framePts - audio.base) * sr / 9e4) - audio.shift - expected;
            if (gap > sr * 0.1 && gap <= sr * 10) {
              t = expected + gap;
              warnings.timestamps++;
            } else if (Math.abs(gap) > sr * 0.1) {
              audio.shift += gap;
              warnings.timestamps++;
            }
          }
        }
        audio.lastT = t;
        const frame = data.subarray(o + h.headerLength, o + h.frameLength);
        audio.track.addSample(frame.length, t, 0, true);
        chunk.audioFrames.push(frame);
        chunk.audioBytes += frame.length;
        audio.bytes += frame.length;
        o += h.frameLength;
      }
      if (o < data.length) audio.rest = data.slice(o);
    }
    function onUnits(units) {
      for (const unit of units) {
        if (unit.kind === "video") onVideo(unit);
        else onAudio(unit);
      }
    }
    async function flushChunk() {
      const c = chunk;
      if (!c.videoSamples && !c.audioFrames.length) return;
      chunk = { videoNals: [], videoSamples: 0, videoBytes: 0, audioFrames: [], audioBytes: 0 };
      const head = started ? 0 : FTYP.length + MDAT_HEADER_SIZE;
      const buf = new Uint8Array(head + c.videoBytes + c.audioBytes);
      const view = new DataView(buf.buffer);
      let o = 0;
      if (!started) {
        buf.set(FTYP, 0);
        buf.set(mdatHeader(0), FTYP.length);
        o = head;
        started = true;
      }
      for (const nal of c.videoNals) {
        view.setUint32(o, nal.length);
        buf.set(nal, o + 4);
        o += 4 + nal.length;
      }
      for (const frame of c.audioFrames) {
        buf.set(frame, o);
        o += frame.length;
      }
      if (c.videoSamples) video.track.addChunk(offset, c.videoSamples);
      if (c.audioFrames.length) audio.track.addChunk(offset + c.videoBytes, c.audioFrames.length);
      offset += c.videoBytes + c.audioBytes;
      dataBytes += c.videoBytes + c.audioBytes;
      await write(buf);
    }
    return {
      get started() {
        return started;
      },
      warnings,
      async push(data) {
        bytesIn += data.length;
        const units = demux.push(data);
        checkStreams();
        if (!checked) return;
        onUnits(units);
        await flushChunk();
      },
      async finish() {
        const units = demux.flush();
        bytesIn = Math.max(bytesIn, PMT_DEADLINE);
        checkStreams();
        onUnits(units);
        await flushChunk();
        if (!started) throw new RemuxError("没有解析到任何音视频帧，无法生成 MP4");
        warnings.corrupt += demux.errors + demux.resyncs;
        const tracks = [];
        if (video.track) {
          if (!video.sps || !video.pps.size) throw new RemuxError("视频流中没有 SPS/PPS 参数集，无法生成 MP4");
          video.track.close(3600);
          video.track.codec = { sps: video.sps, pps: [...video.pps.values()], info: video.info };
          video.track.mediaTime = video.firstCts;
          tracks.push({ track: video.track, start: video.firstPts });
        }
        if (audio.track) {
          audio.track.close(1024);
          const { sampleRate, channelConfig } = audio.codec;
          const seconds = audio.track.duration / sampleRate;
          audio.track.codec = {
            config: audioSpecificConfig(audio.codec),
            channels: CHANNELS[channelConfig],
            sampleRate,
            bitrate: seconds ? Math.round(audio.bytes * 8 / seconds) : 0
          };
          audio.track.mediaTime = 0;
          tracks.push({ track: audio.track, start: audio.base });
        }
        const t0 = Math.min(...tracks.map((t) => t.start));
        tracks.forEach(({ track, start }, i) => {
          track.id = i + 1;
          track.emptyEdit = Math.round((start - t0) * track.timescale / 9e4);
        });
        const moov = buildMoov(tracks.map((t) => t.track));
        await write(moov);
        await writeAt(FTYP.length, mdatHeader(dataBytes));
        const duration = Math.max(...tracks.map(({ track }) => (track.emptyEdit + track.duration) / track.timescale));
        return {
          format: "mp4",
          bytes: FTYP.length + MDAT_HEADER_SIZE + dataBytes + moov.length,
          duration,
          video: video.track ? { frames: video.track.count, width: video.info.width, height: video.info.height } : null,
          audio: audio.track ? { frames: audio.track.count, sampleRate: audio.codec.sampleRate, channels: CHANNELS[audio.codec.channelConfig] } : null,
          warnings: { ...warnings }
        };
      }
    };
  }
  var isMp4Filename = (name) => /\.mp4$/i.test(String(name));
  function createOutput({ filename, sink, onFallback }) {
    if (!isMp4Filename(filename)) {
      return { format: "ts", write: (data) => sink.write(data), finish: async () => ({ format: "ts" }) };
    }
    let target = sink;
    let fallback = null;
    let pending = [];
    const remuxer = createMp4Remuxer({ write: (d) => target.write(d), writeAt: (p, d) => target.writeAt(p, d) });
    return {
      get format() {
        return fallback ? "ts" : "mp4";
      },
      async write(data) {
        if (fallback) return target.write(data);
        try {
          await remuxer.push(data);
          if (remuxer.started) pending = null;
          else pending.push(data);
        } catch (error) {
          if (!error.unsupported || !onFallback) throw error;
          target = await onFallback(error);
          fallback = error;
          for (const d of [...pending, data]) await target.write(d);
          pending = null;
        }
      },
      async finish() {
        if (fallback) return { format: "ts", fallback };
        try {
          return await remuxer.finish();
        } catch (error) {
          if (!error.unsupported || !onFallback || !pending) throw error;
          target = await onFallback(error);
          fallback = error;
          for (const d of pending) await target.write(d);
          pending = null;
          return { format: "ts", fallback };
        }
      }
    };
  }

  // src/batch.js
  var BATCH_LIMITS = Object.freeze({ recordings: 3, segments: 4, requests: 8 });
  var isTaskFinished = (task) => ["completed", "failed", "cancelled"].includes(task.status);
  function batchProgress(batch) {
    const totals = { total: batch.tasks.length, settled: 0, completed: 0, failed: 0, cancelled: 0, active: 0, queued: 0, bytes: 0, badTs: 0, fallbacks: 0, percent: 0 };
    let units = 0;
    for (const task of batch.tasks) {
      if (isTaskFinished(task)) {
        totals.settled++;
        totals[task.status]++;
        units++;
      } else {
        totals[task.status === "queued" ? "queued" : "active"]++;
        units += task.total ? Math.min(0.99, task.done / task.total * 0.99) : 0;
      }
      totals.bytes += task.bytes;
      totals.badTs += task.badTs;
      if (task.fallback) totals.fallbacks++;
    }
    totals.percent = totals.total ? units / totals.total * 100 : 0;
    return totals;
  }
  function createBatch(entries) {
    return {
      tasks: entries.map((entry) => ({
        ...entry,
        controller: new AbortController(),
        status: "queued",
        phase: "queued",
        done: 0,
        total: 0,
        bytes: 0,
        seconds: 0,
        totalSeconds: 0,
        badTs: 0,
        error: "",
        notice: "",
        fallback: false,
        aborting: false
      })),
      running: true,
      phase: "pick",
      aborting: false,
      startedAt: Date.now()
    };
  }
  function cancelBatchTask(batch, key) {
    const task = batch.tasks.find((t) => t.key === key);
    if (!task || isTaskFinished(task) || task.aborting) return;
    task.aborting = true;
    task.controller.abort();
    if (task.status === "queued") task.status = "cancelled";
  }
  function cancelBatch(batch) {
    if (!batch.running || batch.aborting) return;
    batch.aborting = true;
    for (const task of batch.tasks) cancelBatchTask(batch, task.key);
  }
  async function runBatch(batch, {
    openSink,
    locate,
    request,
    onChange = () => {
    },
    recordingConcurrency = BATCH_LIMITS.recordings,
    segmentConcurrency = BATCH_LIMITS.segments,
    limiter = createRequestLimiter(BATCH_LIMITS.requests),
    retryDelayMs = 1e3
  }) {
    positiveInteger(recordingConcurrency, "录像并发数");
    positiveInteger(segmentConcurrency, "分片并发数");
    const limitedRequest = limiter.wrap(request);
    batch.phase = "download";
    let next = 0;
    async function runTask(task) {
      const { signal } = task.controller;
      let sink = null;
      try {
        task.status = "running";
        task.phase = "file";
        onChange();
        if (!task.watchUrl) throw new Error("该条目没有可用的观看链接");
        sink = await openSink(task.filename, signal);
        if (signal.aborted) throw abortError();
        if (!sink || sink.kind !== "file") throw new Error("批量下载必须直接写入磁盘");
        task.filename = sink.filename || task.filename;
        task.phase = "locate";
        onChange();
        const playlistUrl = await abortable(locate(task.watchUrl, { signal, allowManual: false }), signal);
        task.phase = "download";
        task.startedAt = Date.now();
        const output = createOutput({
          filename: task.filename,
          sink,
          onFallback: async (error) => {
            const old = sink;
            sink = null;
            await old.abort();
            sink = await openSink(withExtension(task.filename, "ts"), signal);
            if (signal.aborted) throw abortError();
            if (!sink || sink.kind !== "file") throw new Error("批量下载必须直接写入磁盘");
            task.filename = sink.filename || withExtension(task.filename, "ts");
            task.fallback = true;
            task.notice = `${error.reason}，无法无损转为 MP4，已改存为 TS`;
            onChange();
            return sink;
          }
        });
        await downloadHls({
          playlistUrl,
          request: limitedRequest,
          write: (data) => output.write(data),
          signal,
          concurrency: segmentConcurrency,
          retryDelayMs,
          onProgress: (progress) => {
            Object.assign(task, progress);
            onChange();
          }
        });
        if (signal.aborted) throw abortError();
        task.phase = "finish";
        onChange();
        const result = await output.finish();
        if (signal.aborted) throw abortError();
        if (result.warnings?.timestamps) task.notice = `${result.warnings.timestamps} 处时间戳不连续，已自动接续`;
        await sink.close();
        sink = null;
        task.status = "completed";
      } catch (error) {
        task.status = signal.aborted || error.name === "AbortError" ? "cancelled" : "failed";
        task.error = task.status === "failed" ? error.message : "";
      } finally {
        task.controller.abort();
        if (sink) await withTimeout(Promise.resolve().then(() => sink.abort()), 3e3);
        onChange();
      }
    }
    async function worker() {
      while (next < batch.tasks.length) {
        const task = batch.tasks[next++];
        if (isTaskFinished(task)) continue;
        if (batch.aborting) {
          cancelBatchTask(batch, task.key);
          continue;
        }
        await runTask(task);
      }
    }
    try {
      const workers = [];
      for (let i = 0; i < Math.min(recordingConcurrency, batch.tasks.length); i++) workers.push(worker());
      await Promise.all(workers);
    } finally {
      batch.running = false;
      onChange();
    }
    return batchProgress(batch);
  }

  // src/ui.js
  var PANEL_CSS = `
  :host { all: initial; }
  .cf { font: 12px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #222;
        background: #fff; border: 1px solid #ccc; border-radius: 6px; box-shadow: 0 2px 12px rgba(0,0,0,.15);
        width: 620px; max-width: calc(100vw - 32px); }
  .cf.collapsed { width: auto; }
  .hd { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; user-select: none;
        background: #f6f6f6; border-radius: 6px; }
  .cf:not(.collapsed) .hd { border-bottom: 1px solid #e5e5e5; border-radius: 6px 6px 0 0; }
  .hd b { font-weight: 600; } .hd .count { color: #666; } .hd .arrow { margin-left: auto; color: #999; }
  .bd { padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
  .collapsed .bd { display: none; }
  label { display: flex; align-items: center; gap: 6px; }
  label span { width: 56px; color: #555; flex: none; }
  select { font: inherit; padding: 1px 4px; border: 1px solid #ccc; border-radius: 3px; }
  input[type=text] { flex: 1; min-width: 0; font: inherit; padding: 2px 6px; border: 1px solid #ccc; border-radius: 3px; }
  .hint { color: #888; font-size: 11px; margin-left: 62px; }
  .bar { display: flex; flex-wrap: wrap; gap: 4px; }
  button { font: inherit; padding: 2px 8px; border: 1px solid #bbb; border-radius: 3px; background: #fafafa; cursor: pointer; }
  button:hover { background: #eee; } button:disabled { opacity: .5; cursor: default; }
  button.link { border: none; background: none; color: #1a5fb4; padding: 0 4px; }
  .status { color: #444; } .status.flash { color: #1a7f37; }
  details { color: #9a6700; } details ul { margin: 4px 0 0; padding-left: 18px; max-height: 100px; overflow: auto; }
  .tbl { max-height: 45vh; overflow: auto; border: 1px solid #eee; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 2px 6px; border-bottom: 1px solid #f0f0f0; text-align: left; white-space: nowrap; }
  th { position: sticky; top: 0; background: #fafafa; font-weight: 600; }
  td.fn { font-family: ui-monospace, Menlo, Consolas, monospace; white-space: normal; word-break: break-all; }
  .muted { color: #888; }
  .dl { border: 1px solid #cfe0f5; background: #f5f9ff; border-radius: 4px; padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; }
  .dl[hidden] { display: none; }
  .dl-top { display: flex; align-items: center; gap: 8px; }
  .dl-name { flex: 1; min-width: 0; font-family: ui-monospace, Menlo, Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dl-bar { height: 6px; background: #dde6f0; border-radius: 3px; overflow: hidden; position: relative; }
  .dl-fill { height: 100%; width: 0; background: #1a5fb4; transition: width .2s; }
  .dl-bar.indeterminate .dl-fill { width: 30%; position: absolute; animation: cf-slide 1.2s ease-in-out infinite; }
  @keyframes cf-slide { from { left: -30%; } to { left: 100%; } }
  .dl-l1 { color: #333; } .dl-l2 { color: #666; font-size: 11px; }
  .dl-warn { color: #b42318; font-size: 11px; }
  .dl-note { color: #9a6700; font-size: 11px; }
  .dl.done { border-color: #b7dfc3; background: #f3fbf5; }
  .dl.done .dl-cancel { font-weight: 600; }
  .task-state { display: block; color: #555; white-space: normal; max-width: 220px; }
  .task-state[data-status="failed"] { color: #b42318; }
  .task-state .notice { color: #9a6700; }
`;
  var PANEL_HTML = `
  <style>${PANEL_CSS}</style>
  <div class="cf">
    <div class="hd"><b>Course Fetch</b><span class="count"></span><span class="arrow"></span></div>
    <div class="bd">
      <label><span>课程</span><input type="text" class="course"></label>
      <label><span>命名模板</span><input type="text" class="tpl"><button class="reset-tpl">重置</button></label>
      <div class="hint">变量：{index:02d} {date} {periodStart} {periodEnd} {teacher} {course} {time}</div>
      <label><span>输出格式</span><select class="fmt"><option value="mp4">MP4（无损转封装，推荐）</option><option value="ts">TS（原始流）</option></select></label>
      <div class="bar">
        <button data-act="scan">重新扫描</button>
        <button data-act="all">全选</button>
        <button data-act="none">全不选</button>
        <button data-act="open">打开选中</button>
        <button data-act="download">下载选中</button>
        <button data-act="copy">复制清单</button>
        <button data-act="export">导出 JSON</button>
      </div>
      <div class="dl" hidden>
        <div class="dl-top"><span class="dl-name"></span><button class="dl-cancel">取消</button></div>
        <div class="dl-bar"><div class="dl-fill"></div></div>
        <div class="dl-l1"></div>
        <div class="dl-l2"></div>
        <div class="dl-warn" hidden></div>
        <div class="dl-note" hidden></div>
      </div>
      <div class="status"></div>
      <details class="warn" hidden><summary></summary><ul></ul></details>
      <div class="tbl"><table>
        <thead><tr><th><input type="checkbox" class="chk-all"></th><th>#</th><th>文件名</th><th>开始时间</th><th>教师</th><th></th></tr></thead>
        <tbody></tbody>
      </table></div>
    </div>
  </div>`;
  var PHASE_LABEL = {
    pick: "选择保存目录",
    locate: "打开播放页，自动捕获播放列表",
    download: "下载中",
    finish: "写入文件",
    file: "创建文件",
    queued: "排队中"
  };
  function formatBytes(n) {
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  function formatDuration(sec) {
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor(s % 3600 / 60);
    const pad = (x) => String(x).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }
  function createUI({ state, courseId, filenameOf, outputNameOf = filenameOf, actions }) {
    const host = document.createElement("div");
    host.id = "course-fetch-host";
    host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483000;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = PANEL_HTML;
    document.body.appendChild(host);
    const $ = (sel) => root.querySelector(sel);
    const ui = {
      panel: $(".cf"),
      count: $(".count"),
      arrow: $(".arrow"),
      course: $(".course"),
      tpl: $(".tpl"),
      fmt: $(".fmt"),
      status: $(".status"),
      warn: $(".warn"),
      tbody: $("tbody"),
      chkAll: $(".chk-all"),
      dl: {
        root: $(".dl"),
        name: $(".dl-name"),
        cancel: $(".dl-cancel"),
        bar: $(".dl-bar"),
        fill: $(".dl-fill"),
        l1: $(".dl-l1"),
        l2: $(".dl-l2"),
        warn: $(".dl-warn"),
        note: $(".dl-note")
      }
    };
    const selectedEntries = () => state.entries.filter((e) => state.selected.has(entryKey(e)));
    let flashTimer = null;
    function setStatus(msg) {
      state.status = msg;
      render();
    }
    function flash(msg) {
      ui.status.textContent = msg;
      ui.status.classList.add("flash");
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        ui.status.classList.remove("flash");
        ui.status.textContent = state.status;
      }, 2500);
    }
    async function copyText(text, okMsg) {
      try {
        if (typeof GM_setClipboard === "function") GM_setClipboard(text, "text");
        else await navigator.clipboard.writeText(text);
        flash(okMsg);
      } catch (e) {
        flash(`复制失败：${e.message}`);
      }
    }
    function headerCount() {
      const d = state.download;
      if (d) return d.total ? `下载 ${Math.floor(d.done / d.total * 100)}%` : "下载准备中…";
      if (state.batch) {
        const p = batchProgress(state.batch);
        if (!state.batch.running) return `批量结束 · 成功 ${p.completed}/${p.total}`;
        return `批量 ${Math.floor(p.percent)}% · ${p.settled}/${p.total}`;
      }
      return state.scanning ? "扫描中…" : `${state.entries.length} 条`;
    }
    function downloadButtonLabel(key) {
      const d = state.download;
      if (!d || d.key !== key) return "下载";
      if (d.aborting) return "取消中…";
      return d.total ? `${Math.floor(d.done / d.total * 100)}%` : "准备中…";
    }
    function updateDownloadUI() {
      const d = state.download;
      const box2 = ui.dl;
      box2.root.hidden = !d && !state.batch;
      box2.root.classList.toggle("done", !!state.batch && !state.batch.running);
      ui.count.textContent = headerCount();
      if (state.batch) {
        const batch = state.batch;
        const p = batchProgress(batch);
        box2.name.textContent = `批量下载 · ${p.total} 条录像`;
        box2.name.title = box2.name.textContent;
        box2.bar.classList.toggle("indeterminate", batch.phase === "pick" && batch.running);
        box2.fill.style.width = `${p.percent.toFixed(1)}%`;
        box2.note.hidden = true;
        if (!batch.running) {
          box2.cancel.disabled = false;
          box2.cancel.textContent = "确定";
          box2.l1.textContent = `批量下载已结束：成功 ${p.completed} · 失败 ${p.failed} · 取消 ${p.cancelled}`;
          box2.l2.textContent = `已写入 ${formatBytes(p.bytes)} · 每条结果见下表，点「确定」清除结果并恢复列表`;
        } else {
          box2.cancel.disabled = batch.aborting;
          box2.cancel.textContent = batch.aborting ? "取消中…" : "取消整个批次";
          box2.l1.textContent = batch.phase === "pick" ? "选择目标目录" : `已处理 ${p.settled} / ${p.total}（${p.percent.toFixed(0)}%）· 成功 ${p.completed} · 失败 ${p.failed} · 取消 ${p.cancelled}`;
          box2.l2.textContent = `正在处理 ${p.active} · 排队 ${p.queued} · 已写入 ${formatBytes(p.bytes)} · 直接写入磁盘（总进度按录像等权，含失败/取消）`;
        }
        if (p.fallbacks) {
          box2.note.hidden = false;
          box2.note.textContent = `⚠ ${p.fallbacks} 条录像编码无法无损转为 MP4，已改存为 TS`;
        }
        box2.warn.hidden = !p.badTs;
        box2.warn.textContent = p.badTs ? `⚠ ${p.badTs} 个分片不是有效的 TS 数据，请检查对应录像` : "";
        for (const task of batch.tasks) {
          const row = ui.tbody.querySelector(`tr[data-key="${CSS.escape(task.key)}"]`);
          if (!row) continue;
          const label = row.querySelector(".task-state");
          label.dataset.status = task.status;
          const progress = task.total ? ` · ${task.done}/${task.total} 分片 · ${formatBytes(task.bytes)}` : "";
          label.textContent = (task.status === "completed" ? "已完成" : task.status === "failed" ? `失败：${task.error}` : task.status === "cancelled" ? "已取消" : task.aborting ? "取消中…" : PHASE_LABEL[task.phase]) + progress + (task.badTs ? ` · ⚠ ${task.badTs} 个异常 TS 分片` : "");
          if (task.notice) label.appendChild(Object.assign(document.createElement("span"), { className: "notice", textContent: ` · ⚠ ${task.notice}` }));
          label.title = `${task.filename}${task.error ? `：${task.error}` : ""}${task.notice ? `：${task.notice}` : ""}`;
          const cancel = row.querySelector('[data-row="batch-cancel"]');
          cancel.hidden = !batch.running || isTaskFinished(task);
          cancel.disabled = task.aborting;
        }
        return;
      }
      if (!d) return;
      const pct = d.total ? d.done / d.total * 100 : 0;
      box2.name.textContent = d.filename;
      box2.name.title = d.filename;
      box2.bar.classList.toggle("indeterminate", !d.total);
      box2.fill.style.width = d.total ? `${pct.toFixed(1)}%` : "";
      box2.cancel.disabled = d.aborting;
      box2.cancel.textContent = d.aborting ? "取消中…" : "取消";
      let line1 = PHASE_LABEL[d.phase] || d.phase;
      if (d.total) line1 += ` · 分片 ${d.done} / ${d.total}（${pct.toFixed(0)}%）`;
      box2.l1.textContent = line1;
      const parts = [];
      if (d.total) {
        const elapsed = (Date.now() - d.startedAt) / 1e3;
        parts.push(`已下载 ${formatBytes(d.bytes)}`);
        if (d.totalSeconds) parts.push(`视频 ${formatDuration(d.seconds)} / ${formatDuration(d.totalSeconds)}`);
        if (elapsed > 1 && d.bytes) {
          parts.push(`${formatBytes(d.bytes / elapsed)}/s`);
          if (d.done > 0 && d.done < d.total) parts.push(`剩余约 ${formatDuration(elapsed / d.done * (d.total - d.done))}`);
        }
        parts.push(d.sinkKind === "file" ? "直接写入磁盘" : "内存中合并，完成后保存");
        if (/\.mp4$/i.test(d.filename)) parts.push("边下载边转封装 MP4");
      }
      box2.l2.textContent = parts.join(" · ");
      box2.warn.hidden = !d.badTs;
      box2.warn.textContent = d.badTs ? `⚠ ${d.badTs} 个分片解密后不是有效的 TS 数据（key/IV 可能不对），建议取消后检查` : "";
      const note = [d.sinkKind === "memory" && d.sinkNote ? `${d.sinkNote}，改为在内存中合并（占用内存约等于视频大小）` : "", d.notice].filter(Boolean);
      box2.note.hidden = !note.length;
      box2.note.textContent = note.map((n) => `⚠ ${n}`).join("；");
      const btn = ui.tbody.querySelector(`tr[data-key="${CSS.escape(d.key)}"] button[data-row="download"]`);
      if (btn) btn.textContent = downloadButtonLabel(d.key);
    }
    function render() {
      ui.panel.classList.toggle("collapsed", state.collapsed);
      ui.arrow.textContent = state.collapsed ? "▴" : "▾";
      ui.count.textContent = headerCount();
      if (root.activeElement !== ui.course) ui.course.value = state.course;
      if (root.activeElement !== ui.tpl) ui.tpl.value = state.template;
      ui.fmt.value = state.format;
      if (!ui.status.classList.contains("flash")) ui.status.textContent = state.status;
      const busy = !!state.download || !!state.batch?.running;
      root.querySelectorAll(".bar button").forEach((b) => b.disabled = state.scanning || busy && ["scan", "download"].includes(b.dataset.act));
      ui.fmt.disabled = busy;
      ui.warn.hidden = !state.warnings.length;
      ui.warn.querySelector("summary").textContent = `${state.warnings.length} 条提示`;
      ui.warn.querySelector("ul").replaceChildren(
        ...state.warnings.map((w) => Object.assign(document.createElement("li"), { textContent: w }))
      );
      const frag = document.createDocumentFragment();
      for (const e of state.entries) {
        const key = entryKey(e);
        const tr = document.createElement("tr");
        tr.dataset.key = key;
        const cells = [
          Object.assign(document.createElement("input"), { type: "checkbox", checked: state.selected.has(key) }),
          String(e.index),
          outputNameOf(e),
          e.startTime ? e.startTime.slice(0, 16) : e.date,
          e.teacher
        ];
        cells.forEach((c, i) => {
          const td = document.createElement("td");
          if (i === 2) td.className = "fn";
          if (typeof c === "string") td.textContent = c;
          else td.appendChild(c);
          tr.appendChild(td);
        });
        const act = document.createElement("td");
        const otherDownload = state.download && state.download.key !== key || state.batch?.running;
        act.innerHTML = `<button class="link" data-row="open"${e.watchUrl ? "" : ' disabled title="无可用链接"'}>打开</button><button class="link" data-row="copy">复制名</button><button class="link" data-row="download"${!e.watchUrl || otherDownload ? " disabled" : ""}${state.download && !otherDownload ? ' title="点击取消"' : ""}></button>`;
        act.lastChild.textContent = downloadButtonLabel(key);
        const taskState = document.createElement("span");
        taskState.className = "task-state";
        const cancel = document.createElement("button");
        cancel.className = "link";
        cancel.dataset.row = "batch-cancel";
        cancel.textContent = "取消此条";
        cancel.hidden = true;
        act.appendChild(taskState);
        act.appendChild(cancel);
        tr.appendChild(act);
        frag.appendChild(tr);
      }
      if (!state.entries.length) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td colspan="6" class="muted">${state.scanning ? "扫描中…" : "暂无条目"}</td>`;
        frag.appendChild(tr);
      }
      ui.tbody.replaceChildren(frag);
      ui.chkAll.checked = state.entries.length > 0 && state.selected.size === state.entries.length;
      updateDownloadUI();
    }
    $(".hd").addEventListener("click", () => {
      state.collapsed = !state.collapsed;
      store.set("collapsed", state.collapsed);
      render();
    });
    ui.course.addEventListener("input", () => {
      state.course = ui.course.value.trim();
      store.set(`course:${courseId}`, state.course);
      render();
    });
    ui.tpl.addEventListener("input", () => {
      state.template = ui.tpl.value || DEFAULT_TEMPLATE;
      store.set("template", state.template);
      render();
    });
    ui.fmt.addEventListener("change", () => {
      state.format = ui.fmt.value === "ts" ? "ts" : "mp4";
      store.set("format", state.format);
      render();
    });
    $(".reset-tpl").addEventListener("click", () => {
      state.template = DEFAULT_TEMPLATE;
      store.set("template", state.template);
      ui.tpl.value = state.template;
      render();
    });
    ui.chkAll.addEventListener("change", () => {
      state.selected = ui.chkAll.checked ? new Set(state.entries.map(entryKey)) : /* @__PURE__ */ new Set();
      render();
    });
    $(".bar").addEventListener("click", (ev) => {
      const act = ev.target.dataset && ev.target.dataset.act;
      if (act === "scan") actions.scan();
      else if (act === "all") state.selected = new Set(state.entries.map(entryKey)), render();
      else if (act === "none") state.selected = /* @__PURE__ */ new Set(), render();
      else if (act === "open") actions.openEntries(selectedEntries());
      else if (act === "copy") {
        if (!state.entries.length) return flash("没有可复制的条目");
        const list = state.selected.size ? selectedEntries() : state.entries;
        copyText(
          buildListText({ course: state.course, template: state.template, entries: list }),
          `已复制 ${list.length} 条清单` + (state.selected.size ? "（仅选中）" : "")
        );
      } else if (act === "export") actions.exportManifest();
      else if (act === "download") actions.downloadSelected(selectedEntries());
    });
    ui.tbody.addEventListener("click", (ev) => {
      const tr = ev.target.closest("tr");
      const key = tr && tr.dataset.key;
      if (!key) return;
      const entry = state.entries.find((e) => entryKey(e) === key);
      if (ev.target.type === "checkbox") {
        if (ev.target.checked) state.selected.add(key);
        else state.selected.delete(key);
        ui.chkAll.checked = state.selected.size === state.entries.length;
      } else if (ev.target.dataset.row === "open") {
        actions.openEntries([entry]);
      } else if (ev.target.dataset.row === "copy") {
        copyText(outputNameOf(entry), "已复制文件名");
      } else if (ev.target.dataset.row === "download") {
        const d = state.download;
        if (d && d.key === key) {
          if (confirm(`取消下载 ${d.filename}？`)) actions.cancelDownload();
        } else {
          actions.downloadEntry(entry);
        }
      } else if (ev.target.dataset.row === "batch-cancel") {
        actions.cancelTask(key);
      }
    });
    ui.dl.cancel.addEventListener("click", () => {
      if (state.batch?.running) return actions.cancelBatchDownload();
      if (state.batch) return actions.dismissBatch();
      const d = state.download;
      if (d && confirm(`取消下载 ${d.filename}？`)) actions.cancelDownload();
    });
    return { render, setStatus, flash, updateDownloadUI };
  }

  // src/directory.js
  async function pickDownloadDirectory(win = window) {
    if (typeof win.showDirectoryPicker !== "function") {
      throw new Error("批量下载需要支持目录写入的 Chrome / Edge，请在独立的 HTTPS 课堂实录页面中使用");
    }
    return win.showDirectoryPicker({ mode: "readwrite" });
  }
  function createDirectorySinkFactory(directory) {
    const reserved = /* @__PURE__ */ new Set();
    return async (filename, signal) => {
      const [, base, ext] = /^(.*?)(\.[^.]*)?$/.exec(filename);
      let name;
      for (let suffix = 0; ; suffix++) {
        if (signal?.aborted) throw abortError();
        name = suffix ? `${base} (${suffix + 1})${ext || ""}` : filename;
        const canonical = name.toLowerCase();
        if (reserved.has(canonical)) continue;
        reserved.add(canonical);
        try {
          await directory.getFileHandle(name);
        } catch (error) {
          if (error.name === "NotFoundError") break;
          if (error.name !== "TypeMismatchError") throw error;
        }
      }
      if (signal?.aborted) throw abortError();
      const handle = await directory.getFileHandle(name, { create: true });
      let writable;
      try {
        if (signal?.aborted) throw abortError();
        writable = await handle.createWritable();
        if (signal?.aborted) throw abortError();
      } catch (error) {
        if (writable) await writable.abort();
        await directory.removeEntry(name).catch(() => {
        });
        throw error;
      }
      return {
        kind: "file",
        filename: name,
        write: (data) => writable.write(data),
        writeAt: (position, data) => writable.write({ type: "write", position, data }),
        close: () => writable.close(),
        abort: async () => {
          await writable.abort();
          await directory.removeEntry(name);
        }
      };
    };
  }
  async function pickSingleTarget(win = window) {
    let reason = "当前浏览器不支持目录写入（需要 Chrome / Edge）";
    if (typeof win.showDirectoryPicker === "function") {
      try {
        const directory = await win.showDirectoryPicker({ mode: "readwrite" });
        return { kind: "file", reason: "", open: createDirectorySinkFactory(directory) };
      } catch (error) {
        if (error.name !== "SecurityError") throw error;
        reason = "当前页面不允许目录写入（可能在跨域 iframe 中，可右键「在新标签页中打开框架」）";
      }
    }
    return { kind: "memory", reason, open: async (filename) => Object.assign(memorySink(filename), { filename }) };
  }

  // src/main.js
  var MAX_PAGES = 50;
  var MAX_TABS_WITHOUT_CONFIRM = 8;
  var DOWNLOAD_CONCURRENCY = 4;
  function main() {
    if (typeof document === "undefined") return;
    if (/videoList\.action/i.test(location.href)) return listPage();
    if (window.__courseFetchCapture) return;
    window.__courseFetchCapture = true;
    runPlayerCapture().catch((e) => console.warn("[Course Fetch] 捕获失败", e));
  }
  function listPage() {
    if (window.__courseFetchLoaded) return;
    window.__courseFetchLoaded = true;
    const VERSION = typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version || "0.3.0";
    console.info(`[Course Fetch] v${VERSION} loaded`);
    const courseId = parseCourseId(location.href);
    const state = {
      course: store.get(`course:${courseId}`, "") || detectCourseName() || (courseId ? `course_${courseId}` : ""),
      template: store.get("template", DEFAULT_TEMPLATE),
      format: OUTPUT_FORMATS.includes(store.get("format", "mp4")) ? store.get("format", "mp4") : "mp4",
      // 输出格式：mp4（无损转封装）/ ts
      collapsed: store.get("collapsed", true),
      entries: [],
      // 含 watchUrl，仅内存
      duplicates: [],
      failures: [],
      warnings: [],
      pages: 0,
      selected: /* @__PURE__ */ new Set(),
      // entryKey
      scanning: false,
      status: "",
      download: null,
      // { key, filename, controller, aborting, phase, done, total, bytes, ... }，仅内存
      batch: null
      // 仅内存；完成后保留每条录像结果，直到下次下载。
    };
    const requestLimiter = createRequestLimiter(BATCH_LIMITS.requests);
    const limitedRequest = requestLimiter.wrap(gmRequest);
    const filenameOf = (e) => formatFilename(state.template, e, { course: state.course });
    const outputNameOf = (e) => withExtension(filenameOf(e), state.format);
    async function scan() {
      if (state.scanning || state.download || state.batch?.running) return;
      state.scanning = true;
      ui.setStatus("正在解析当前页…");
      const result = await crawlCourse({
        firstDoc: document,
        firstUrl: location.href,
        fetchDoc: fetchDocument,
        maxPages: MAX_PAGES,
        onProgress: ui.setStatus
      });
      const keys = new Set(result.entries.map(entryKey));
      state.selected = new Set([...state.selected].filter((k) => keys.has(k)));
      Object.assign(state, {
        entries: result.entries,
        duplicates: result.duplicates,
        failures: result.failures,
        warnings: result.warnings,
        pages: result.pages,
        scanning: false
      });
      ui.setStatus(result.status);
    }
    function openUrl(url) {
      if (typeof GM_openInTab === "function") GM_openInTab(url, { active: false, insert: true, setParent: true });
      else window.open(url, "_blank", "noopener");
    }
    function openEntries(list) {
      const ok = list.filter((e) => e.watchUrl);
      const missing = list.length - ok.length;
      if (!ok.length) return ui.flash(missing ? "选中的条目没有可打开的链接" : "请先勾选要打开的录像");
      if (ok.length > MAX_TABS_WITHOUT_CONFIRM && !confirm(`将打开 ${ok.length} 个标签页，确定吗？`)) return;
      ok.forEach((e) => openUrl(e.watchUrl));
      ui.flash(`已打开 ${ok.length} 个页面` + (missing ? `，${missing} 条无链接` : ""));
    }
    function exportManifest() {
      if (!state.entries.length) return ui.flash("没有可导出的条目");
      const manifest = buildManifest({
        course: state.course,
        courseId,
        template: state.template,
        entries: state.entries
      });
      const blob = new Blob([safeStringify(manifest)], { type: "application/json" });
      saveBlob(blob, sanitizeFilename(`${state.course || courseId || "course"}-manifest.json`));
      ui.flash("已导出 manifest");
    }
    function cancelDownload() {
      const d = state.download;
      if (!d || d.aborting) return;
      d.aborting = true;
      d.controller.abort();
      ui.updateDownloadUI();
    }
    async function downloadEntry(entry) {
      if (state.download || state.batch?.running) return ui.flash("已有下载在进行中");
      if (!entry.watchUrl) return ui.flash("该条目没有可用的观看链接");
      const controller = new AbortController();
      const signal = controller.signal;
      const dl = {
        key: entryKey(entry),
        filename: outputNameOf(entry),
        controller,
        aborting: false,
        phase: "pick",
        sinkKind: "",
        sinkNote: "",
        // 退回内存合并的原因
        notice: "",
        done: 0,
        total: 0,
        bytes: 0,
        seconds: 0,
        totalSeconds: 0,
        badTs: 0,
        startedAt: Date.now()
      };
      state.download = dl;
      state.batch = null;
      state.collapsed = false;
      let sink = null;
      let outcome;
      try {
        ui.render();
        const target = await pickSingleTarget();
        if (signal.aborted) throw abortError();
        dl.sinkKind = target.kind;
        dl.sinkNote = target.reason;
        sink = await target.open(dl.filename, signal);
        if (signal.aborted) throw abortError();
        dl.filename = sink.filename || dl.filename;
        dl.phase = "locate";
        ui.updateDownloadUI();
        const playlistUrl = await locatePlaylist(entry.watchUrl, { signal });
        dl.phase = "download";
        dl.startedAt = Date.now();
        ui.updateDownloadUI();
        const output = createOutput({
          filename: dl.filename,
          sink,
          onFallback: async (error) => {
            const old = sink;
            sink = null;
            await old.abort();
            sink = await target.open(withExtension(dl.filename, "ts"), signal);
            if (signal.aborted) throw abortError();
            dl.filename = sink.filename || withExtension(dl.filename, "ts");
            dl.notice = `${error.reason}，无法无损转为 MP4，已改存为 TS`;
            ui.updateDownloadUI();
            return sink;
          }
        });
        const result = await downloadHls({
          playlistUrl,
          request: limitedRequest,
          write: (d) => output.write(d),
          concurrency: DOWNLOAD_CONCURRENCY,
          signal,
          onProgress: (p) => {
            Object.assign(dl, {
              done: p.done,
              total: p.total,
              bytes: p.bytes,
              seconds: p.seconds,
              totalSeconds: p.totalSeconds,
              badTs: p.badTs
            });
            ui.updateDownloadUI();
          }
        });
        dl.phase = "finish";
        ui.updateDownloadUI();
        const remuxed = await output.finish();
        if (signal.aborted) throw abortError();
        await sink.close();
        sink = null;
        const size = remuxed.format === "mp4" ? remuxed.bytes : result.bytes;
        outcome = `已完成：${dl.filename}（${result.segments} 个分片，${formatBytes(size)}，时长 ${formatDuration(result.duration)}）`;
        if (result.badTs) outcome += `，但有 ${result.badTs} 个分片不是有效 TS，请检查文件`;
        if (dl.notice) outcome += `；${dl.notice}`;
        if (remuxed.warnings?.timestamps) outcome += `，${remuxed.warnings.timestamps} 处时间戳不连续已自动接续`;
      } catch (e) {
        const cancelled = signal.aborted || e && e.name === "AbortError";
        let message = e && e.message;
        if (!cancelled && e?.name === "RemuxError" && /无法无损封装/.test(message)) message += "。请把面板中的「输出格式」切换为 TS 后重新下载";
        outcome = cancelled ? `已取消下载：${dl.filename}` : `下载失败：${dl.filename}：${message}`;
        if (!cancelled) console.warn("[Course Fetch] 下载失败", e);
      } finally {
        controller.abort();
        if (sink) await withTimeout(Promise.resolve().then(() => sink.abort()), 3e3);
        state.download = null;
        state.status = outcome || "";
        ui.render();
        ui.updateDownloadUI();
      }
    }
    function dismissBatch() {
      const batch = state.batch;
      if (!batch || batch.running) return;
      state.batch = null;
      state.status = batch.statusBefore || "";
      ui.render();
    }
    function cancelBatchDownload() {
      if (!state.batch) return;
      cancelBatch(state.batch);
      ui.updateDownloadUI();
    }
    function cancelTask(key) {
      if (!state.batch?.running) return;
      cancelBatchTask(state.batch, key);
      ui.updateDownloadUI();
    }
    async function downloadSelected(entries) {
      if (state.download || state.batch?.running) return ui.flash("已有下载在进行中");
      if (!entries.length) return ui.flash("请先勾选要下载的录像");
      const batch = createBatch(entries.map((entry) => ({
        key: entryKey(entry),
        filename: outputNameOf(entry),
        watchUrl: entry.watchUrl
      })));
      batch.statusBefore = state.batch && !state.batch.running ? state.batch.statusBefore : state.status;
      state.batch = batch;
      state.collapsed = false;
      let pickCancelled = false;
      try {
        ui.render();
        let directory;
        try {
          directory = await pickDownloadDirectory();
        } catch (error) {
          pickCancelled = error.name === "AbortError";
          throw error;
        }
        if (batch.aborting) return;
        await runBatch(batch, {
          openSink: createDirectorySinkFactory(directory),
          locate: locatePlaylist,
          request: gmRequest,
          limiter: requestLimiter,
          onChange: ui.updateDownloadUI
        });
      } catch (error) {
        if (error.name === "AbortError" || batch.aborting) cancelBatch(batch);
        else {
          for (const task of batch.tasks) {
            if (task.status === "queued") {
              task.status = "failed";
              task.error = error.message;
            }
          }
        }
      } finally {
        batch.running = false;
        const p = batchProgress(batch);
        if (pickCancelled) {
          state.batch = null;
          state.status = "已取消批量下载（未选择目录）";
        } else {
          state.status = `批次结束：成功 ${p.completed}，失败 ${p.failed}，取消 ${p.cancelled}`;
          if (p.fallbacks) state.status += `；其中 ${p.fallbacks} 条编码无法无损转为 MP4，已改存为 TS`;
          state.collapsed = false;
        }
        ui.render();
      }
    }
    const ui = createUI({
      state,
      courseId,
      filenameOf,
      outputNameOf,
      actions: { scan, openEntries, exportManifest, downloadEntry, cancelDownload, downloadSelected, cancelBatchDownload, cancelTask, dismissBatch }
    });
    window.addEventListener("beforeunload", (ev) => {
      if (!state.download && !state.batch?.running) return;
      ev.preventDefault();
      ev.returnValue = "";
    });
    ui.render();
    scan().catch((e) => {
      state.scanning = false;
      state.warnings.push(`扫描出错：${e.message}`);
      ui.setStatus("扫描失败");
    });
  }
  main();
})();
