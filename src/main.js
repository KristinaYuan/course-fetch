// 入口：课堂实录页面运行完整功能；播放器页面 / iframe 只运行 m3u8 自动捕获。

import {
  DEFAULT_TEMPLATE,
  entryKey,
  formatFilename,
  withExtension,
  OUTPUT_FORMATS,
  sanitizeFilename,
  parseCourseId,
  buildManifest,
  safeStringify,
} from './parser.js';
import { crawlCourse, detectCourseName, fetchDocument, locatePlaylist } from './page.js';
import { abortError, downloadHls, gmRequest, saveBlob, withTimeout } from './downloader.js';
import { runPlayerCapture } from './capture.js';
import { store } from './storage.js';
import { createUI, formatBytes, formatDuration } from './ui.js';
import { BATCH_LIMITS, createBatch, runBatch, cancelBatch, cancelBatchTask, batchProgress } from './batch.js';
import { createRequestLimiter } from './scheduler.js';
import { pickDownloadTarget } from './directory.js';
import { createOutput } from './remux.js';

const MAX_PAGES = 50;
const MAX_TABS_WITHOUT_CONFIRM = 8;
const DOWNLOAD_CONCURRENCY = 4;

function main() {
  if (typeof document === 'undefined') return;
  if (/videoList\.action/i.test(location.href)) return listPage();
  // 其余 @match 页面（playVideo 页面、播放器 iframe）：只在有未过期的 pending capture 时捕获 m3u8
  if (window.__courseFetchCapture) return;
  window.__courseFetchCapture = true;
  runPlayerCapture().catch((e) => console.warn('[Course Fetch] 捕获失败', e));
}

function listPage() {
  if (window.__courseFetchLoaded) return;
  window.__courseFetchLoaded = true;
  // __CF_VERSION__ 由构建脚本从 package.json 注入
  const VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || __CF_VERSION__;
  console.info(`[Course Fetch] v${VERSION} loaded`);

  const courseId = parseCourseId(location.href);
  const state = {
    course: store.get(`course:${courseId}`, '') || detectCourseName() || (courseId ? `course_${courseId}` : ''),
    template: store.get('template', DEFAULT_TEMPLATE),
    format: OUTPUT_FORMATS.includes(store.get('format', 'mp4')) ? store.get('format', 'mp4') : 'mp4', // 输出格式：mp4（无损转封装）/ ts
    collapsed: store.get('collapsed', true),
    entries: [], // 含 watchUrl，仅内存
    duplicates: [],
    failures: [],
    warnings: [],
    pages: 0,
    selected: new Set(), // entryKey
    scanning: false,
    status: '',
    download: null, // { key, filename, controller, aborting, phase, done, total, bytes, ... }，仅内存
    batch: null, // 仅内存；完成后保留每条录像结果，直到下次下载。
  };
  const requestLimiter = createRequestLimiter(BATCH_LIMITS.requests);
  const limitedRequest = requestLimiter.wrap(gmRequest);

  const filenameOf = (e) => formatFilename(state.template, e, { course: state.course });
  const outputNameOf = (e) => withExtension(filenameOf(e), state.format);

  // ---- 扫描 ----------------------------------------------------------------------
  async function scan() {
    if (state.scanning || state.download || state.batch?.running) return;
    state.scanning = true;
    ui.setStatus('正在解析当前页…');
    const result = await crawlCourse({
      firstDoc: document,
      firstUrl: location.href,
      fetchDoc: fetchDocument,
      maxPages: MAX_PAGES,
      onProgress: ui.setStatus,
    });
    const keys = new Set(result.entries.map(entryKey));
    state.selected = new Set([...state.selected].filter((k) => keys.has(k)));
    Object.assign(state, {
      entries: result.entries,
      duplicates: result.duplicates,
      failures: result.failures,
      warnings: result.warnings,
      pages: result.pages,
      scanning: false,
    });
    ui.setStatus(result.status);
  }

  // ---- 打开 / 导出 ------------------------------------------------------------------
  function openUrl(url) {
    if (typeof GM_openInTab === 'function') GM_openInTab(url, { active: false, insert: true, setParent: true });
    else window.open(url, '_blank', 'noopener');
  }

  function openEntries(list) {
    const ok = list.filter((e) => e.watchUrl);
    const missing = list.length - ok.length;
    if (!ok.length) return ui.flash(missing ? '选中的条目没有可打开的链接' : '请先勾选要打开的录像');
    if (ok.length > MAX_TABS_WITHOUT_CONFIRM && !confirm(`将打开 ${ok.length} 个标签页，确定吗？`)) return;
    ok.forEach((e) => openUrl(e.watchUrl));
    ui.flash(`已打开 ${ok.length} 个页面` + (missing ? `，${missing} 条无链接` : ''));
  }

  function exportManifest() {
    if (!state.entries.length) return ui.flash('没有可导出的条目');
    const manifest = buildManifest({
      course: state.course,
      courseId,
      template: state.template,
      entries: state.entries,
    });
    const blob = new Blob([safeStringify(manifest)], { type: 'application/json' });
    saveBlob(blob, sanitizeFilename(`${state.course || courseId || 'course'}-manifest.json`));
    ui.flash('已导出 manifest');
  }

  // ---- 单条下载 ----------------------------------------------------------------------
  function cancelDownload() {
    const d = state.download;
    if (!d || d.aborting) return;
    d.aborting = true;
    d.controller.abort();
    ui.updateDownloadUI();
  }

  async function downloadEntry(entry) {
    if (state.download || state.batch?.running) return ui.flash('已有下载在进行中');
    if (!entry.watchUrl) return ui.flash('该条目没有可用的观看链接');
    const controller = new AbortController();
    const signal = controller.signal;
    const dl = {
      key: entryKey(entry),
      filename: outputNameOf(entry),
      controller,
      aborting: false,
      phase: 'pick',
      sinkKind: '',
      sinkNote: '', // 使用浏览器保存模式的原因
      notice: '',
      done: 0,
      total: 0,
      bytes: 0,
      seconds: 0,
      totalSeconds: 0,
      badTs: 0,
      startedAt: Date.now(),
    };
    state.download = dl;
    state.batch = null;
    state.collapsed = false;

    let sink = null;
    let outcome;
    try {
      // render 也放在 try 里：任何异常都会进入 finally，保证 state.download 被清空、页面恢复
      ui.render();
      // 与批量相同：点击后的第一个 await 选择目录（需要用户手势），之后直接写盘
      const target = await pickDownloadTarget();
      if (signal.aborted) throw abortError();
      dl.sinkKind = target.kind;
      dl.sinkNote = target.reason;
      sink = await target.open(dl.filename, signal);
      if (signal.aborted) throw abortError();
      dl.filename = sink.filename || dl.filename;
      dl.phase = 'locate';
      ui.updateDownloadUI();

      const playlistUrl = await locatePlaylist(entry.watchUrl, { signal });
      dl.phase = 'download';
      dl.startedAt = Date.now();
      ui.updateDownloadUI();

      // 编码无法无损转为 MP4 时，丢弃 .mp4，在同一目录改存原始 TS（不重新编码）。
      const output = createOutput({
        filename: dl.filename,
        sink,
        onFallback: async (error) => {
          const old = sink;
          sink = null;
          await old.abort();
          sink = await target.open(withExtension(dl.filename, 'ts'), signal);
          if (signal.aborted) throw abortError();
          dl.filename = sink.filename || withExtension(dl.filename, 'ts');
          dl.notice = `${error.reason}，无法无损转为 MP4，已改存为 TS`;
          ui.updateDownloadUI();
          return sink;
        },
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
            badTs: p.badTs,
          });
          ui.updateDownloadUI();
        },
      });
      dl.phase = 'finish';
      ui.updateDownloadUI();
      const remuxed = await output.finish();
      if (signal.aborted) throw abortError();
      await sink.close();
      sink = null;
      const size = remuxed.format === 'mp4' ? remuxed.bytes : result.bytes;
      outcome = `已完成：${dl.filename}（${result.segments} 个分片，${formatBytes(size)}，时长 ${formatDuration(result.duration)}）`;
      if (result.badTs) outcome += `，但有 ${result.badTs} 个分片不是有效 TS，请检查文件`;
      if (dl.notice) outcome += `；${dl.notice}`;
      if (remuxed.warnings?.timestamps) outcome += `，${remuxed.warnings.timestamps} 处时间戳不连续已自动接续`;
      if (target.kind !== 'file') outcome += '；已交给浏览器保存，请在下载列表确认结果';
    } catch (e) {
      const cancelled = signal.aborted || (e && e.name === 'AbortError');
      let message = e && e.message;
      // 已写出 MP4 数据后才出现的编码变化无法回退，只能整条改用 TS
      if (!cancelled && e?.name === 'RemuxError' && /无法无损封装/.test(message)) message += '。请把面板中的「输出格式」切换为 TS 后重新下载';
      outcome = cancelled ? `已取消下载：${dl.filename}` : `下载失败：${dl.filename}：${message}`;
      if (!cancelled) console.warn('[Course Fetch] 下载失败', e);
    } finally {
      controller.abort(); // 确保剩余请求全部停止
      if (sink) await withTimeout(Promise.resolve().then(() => sink.abort()), 3000);
      state.download = null;
      state.status = outcome || '';
      ui.render();
      ui.updateDownloadUI();
    }
  }

  // ---- 批量下载 ------------------------------------------------------------------
  /** 批次结束后由用户确认：清除每条结果和进度区，恢复下载前的列表和状态。 */
  function dismissBatch() {
    const batch = state.batch;
    if (!batch || batch.running) return;
    state.batch = null;
    state.status = batch.statusBefore || '';
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
    if (state.download || state.batch?.running) return ui.flash('已有下载在进行中');
    if (!entries.length) return ui.flash('请先勾选要下载的录像');
    const batch = createBatch(entries.map((entry) => ({
      key: entryKey(entry), filename: outputNameOf(entry), watchUrl: entry.watchUrl,
    })));
    // 上一批结果还没确认时，恢复目标仍是最初的列表状态
    batch.statusBefore = state.batch && !state.batch.running ? state.batch.statusBefore : state.status;
    state.batch = batch;
    state.collapsed = false;
    let pickCancelled = false;
    try {
      ui.render();
      // 保留点击手势：任何异步捕获、文件创建之前只弹一次目录选择器。
      let target;
      try {
        target = await pickDownloadTarget();
      } catch (error) {
        pickCancelled = error.name === 'AbortError';
        throw error;
      }
      if (batch.aborting) return;
      batch.sinkKind = target.kind;
      batch.sinkNote = target.reason;
      await runBatch(batch, {
        openSink: target.open, sinkKind: target.kind, locate: locatePlaylist,
        request: gmRequest, limiter: requestLimiter, onChange: ui.updateDownloadUI,
      });
    } catch (error) {
      if (error.name === 'AbortError' || batch.aborting) cancelBatch(batch);
      else {
        for (const task of batch.tasks) {
          if (task.status === 'queued') { task.status = 'failed'; task.error = error.message; }
        }
      }
    } finally {
      batch.running = false;
      const p = batchProgress(batch);
      if (pickCancelled) {
        // 没有选择目录：什么都没开始，直接恢复页面
        state.batch = null;
        state.status = '已取消批量下载（未选择目录）';
      } else {
        // 保留每条结果，等待用户在进度区点「确定」后恢复页面
        state.status = `批次结束：成功 ${p.completed}，失败 ${p.failed}，取消 ${p.cancelled}`;
        if (p.fallbacks) state.status += `；其中 ${p.fallbacks} 条编码无法无损转为 MP4，已改存为 TS`;
        if (batch.sinkKind && batch.sinkKind !== 'file' && p.completed) state.status += '；请在浏览器下载列表确认保存结果';
        state.collapsed = false;
      }
      ui.render();
    }
  }

  // ---- 启动 ----------------------------------------------------------------------
  const ui = createUI({
    state,
    courseId,
    filenameOf,
    outputNameOf,
    actions: { scan, openEntries, exportManifest, downloadEntry, cancelDownload, downloadSelected, cancelBatchDownload, cancelTask, dismissBatch },
  });

  window.addEventListener('beforeunload', (ev) => {
    if (!state.download && !state.batch?.running) return;
    ev.preventDefault();
    ev.returnValue = '';
  });

  ui.render();
  scan().catch((e) => {
    state.scanning = false;
    state.warnings.push(`扫描出错：${e.message}`);
    ui.setStatus('扫描失败');
  });
}

main();
