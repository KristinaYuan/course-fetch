// 有界录像 worker 池；每个任务独立 capture / AbortController / 文件流。
import { abortError, abortable, downloadHls, withTimeout } from './downloader.js';
import { positiveInteger, createRequestLimiter } from './scheduler.js';
import { createOutput } from './remux.js';
import { withExtension } from './parser.js';

export const BATCH_LIMITS = Object.freeze({ recordings: 3, segments: 4, requests: 8 });
export const isTaskFinished = (task) => ['completed', 'failed', 'cancelled'].includes(task.status);

/** 总进度按录像等权；失败/取消计入已处理，只有成功 close 的任务计入 completed。 */
export function batchProgress(batch) {
  const totals = { total: batch.tasks.length, settled: 0, completed: 0, failed: 0, cancelled: 0, active: 0, queued: 0, bytes: 0, badTs: 0, fallbacks: 0, percent: 0 };
  let units = 0;
  for (const task of batch.tasks) {
    if (isTaskFinished(task)) {
      totals.settled++;
      totals[task.status]++;
      units++;
    } else {
      totals[task.status === 'queued' ? 'queued' : 'active']++;
      // 保留最后的 1% 给文件 close，不能在提交文件前显示完成。
      units += task.total ? Math.min(0.99, task.done / task.total * 0.99) : 0;
    }
    totals.bytes += task.bytes;
    totals.badTs += task.badTs;
    if (task.fallback) totals.fallbacks++;
  }
  totals.percent = totals.total ? units / totals.total * 100 : 0;
  return totals;
}

export function createBatch(entries) {
  return {
    tasks: entries.map((entry) => ({
      ...entry, controller: new AbortController(), status: 'queued', phase: 'queued',
      done: 0, total: 0, bytes: 0, seconds: 0, totalSeconds: 0, badTs: 0, error: '', notice: '', fallback: false, aborting: false,
    })),
    running: true, phase: 'pick', aborting: false, startedAt: Date.now(),
  };
}

export function cancelBatchTask(batch, key) {
  const task = batch.tasks.find((t) => t.key === key);
  if (!task || isTaskFinished(task) || task.aborting) return;
  task.aborting = true;
  task.controller.abort();
  if (task.status === 'queued') task.status = 'cancelled';
}

export function cancelBatch(batch) {
  if (!batch.running || batch.aborting) return;
  batch.aborting = true;
  for (const task of batch.tasks) cancelBatchTask(batch, task.key);
}

/** 仅为固定数量 worker 创建 Promise，录像总数不会增加活动任务或分片窗口。 */
export async function runBatch(batch, {
  openSink, locate, request, onChange = () => {},
  recordingConcurrency = BATCH_LIMITS.recordings,
  sinkKind = 'file', // 'file' | 'opfs' | 'memory'
  segmentConcurrency = BATCH_LIMITS.segments,
  limiter = createRequestLimiter(BATCH_LIMITS.requests),
  retryDelayMs = 1000,
}) {
  positiveInteger(recordingConcurrency, '录像并发数');
  positiveInteger(segmentConcurrency, '分片并发数');
  const limitedRequest = limiter.wrap(request);
  batch.phase = 'download';
  // 内存合并每段约等于视频大小，必须逐条；临时文件和磁盘可按录制并发处理。
  const workerCount = sinkKind === 'memory' ? 1 : recordingConcurrency;
  const checkSink = (sink) => {
    const allowed = sinkKind === 'file' ? ['file'] : ['file', 'opfs', 'memory'];
    if (!sink || !allowed.includes(sink.kind)) {
      throw new Error('批量下载必须直接写入磁盘，或使用浏览器保存模式');
    }
  };
  let next = 0;
  async function runTask(task) {
    const { signal } = task.controller;
    let sink = null;
    try {
      task.status = 'running';
      task.phase = 'file';
      onChange();
      if (!task.watchUrl) throw new Error('该条目没有可用的观看链接');
      // 文件句柄创建不能 abortable：必须取得最终结果后才能可靠关闭迟到的句柄。
      sink = await openSink(task.filename, signal);
      if (signal.aborted) throw abortError();
      checkSink(sink);
      task.filename = sink.filename || task.filename;
      task.phase = 'locate';
      onChange();
      const playlistUrl = await abortable(locate(task.watchUrl, { signal, allowManual: false }), signal);
      task.phase = 'download';
      task.startedAt = Date.now();
      // .mp4 边下载边转封装；编码无法无损放入 MP4 时，删除 .mp4 并在同一目录改存原始 TS（不重新编码）。
      const output = createOutput({
        filename: task.filename, sink,
        onFallback: async (error) => {
          const old = sink;
          sink = null;
          await old.abort();
          sink = await openSink(withExtension(task.filename, 'ts'), signal);
          if (signal.aborted) throw abortError();
          checkSink(sink);
          task.filename = sink.filename || withExtension(task.filename, 'ts');
          task.fallback = true;
          task.notice = `${error.reason}，无法无损转为 MP4，已改存为 TS`;
          onChange();
          return sink;
        },
      });
      await downloadHls({
        playlistUrl, request: limitedRequest, write: (data) => output.write(data), signal,
        concurrency: segmentConcurrency, retryDelayMs,
        onProgress: (progress) => { Object.assign(task, progress); onChange(); },
      });
      if (signal.aborted) throw abortError();
      task.phase = 'finish';
      onChange();
      const result = await output.finish();
      if (signal.aborted) throw abortError();
      if (result.warnings?.timestamps) task.notice = `${result.warnings.timestamps} 处时间戳不连续，已自动接续`;
      // close 成功才计为完成；提交期间取消若已无法撤回，则仍以真实写入结果为准。
      await sink.close();
      sink = null;
      task.status = 'completed';
    } catch (error) {
      task.status = signal.aborted || error.name === 'AbortError' ? 'cancelled' : 'failed';
      task.error = task.status === 'failed' ? error.message : '';
    } finally {
      task.controller.abort(); // 失败时立即中止同条录像剩余请求和重试。
      if (sink) await withTimeout(Promise.resolve().then(() => sink.abort()), 3000);
      onChange();
    }
  }
  async function worker() {
    while (next < batch.tasks.length) {
      const task = batch.tasks[next++];
      if (isTaskFinished(task)) continue;
      if (batch.aborting) { cancelBatchTask(batch, task.key); continue; }
      await runTask(task);
    }
  }
  try {
    const workers = [];
    for (let i = 0; i < Math.min(workerCount, batch.tasks.length); i++) workers.push(worker());
    await Promise.all(workers);
  } finally {
    batch.running = false;
    onChange();
  }
  return batchProgress(batch);
}
