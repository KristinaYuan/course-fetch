import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createBatch, runBatch, cancelBatchTask, cancelBatch, batchProgress } from '../src/batch.js';
import { abortable, HttpError } from '../src/downloader.js';
import { ivForSequence } from '../src/hls.js';
import { createRequestLimiter } from '../src/scheduler.js';
import { createDirectorySinkFactory } from '../src/directory.js';
import { makeTs } from './ts-fixture.js';
import { readMp4 } from './mp4-reader.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const entries = (count) => {
  const out = [];
  for (let i = 0; i < count; i++) out.push({ key: String(i), filename: `L${i}.ts`, watchUrl: `https://r.pku.edu.cn/${i}/playlist.m3u8` });
  return out;
};
async function until(fn) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await delay(5); }
  assert.fail('等待状态超时');
}

function hlsServer({ segments = 10, failedId, onSegment = () => {}, payload } = {}) {
  const key = Buffer.alloc(16, 7);
  const keyCounts = new Map();
  let active = 0, peak = 0;
  const request = async (url, type, signal, resource) => {
    active++;
    peak = Math.max(peak, active);
    try {
      await abortable(delay(2), signal);
      const [id, file] = new URL(url).pathname.slice(1).split('/');
      if (id === failedId && resource.kind === 'segment') throw new HttpError(403);
      let data;
      if (file === 'playlist.m3u8') {
        const lines = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:5', '#EXT-X-KEY:METHOD=AES-128,URI="key"'];
        for (let i = 0; i < segments; i++) lines.push('#EXTINF:2,', `${i}.ts`);
        data = `${lines.join('\n')}\n#EXT-X-ENDLIST`;
      } else if (file === 'key') {
        keyCounts.set(id, (keyCounts.get(id) || 0) + 1);
        data = key;
      } else {
        const index = Number(file.replace('.ts', ''));
        let plain = payload && payload(id, index);
        if (!plain) {
          plain = Buffer.alloc(376, index);
          plain[0] = plain[188] = 0x47;
          plain[1] = Number(id);
          plain[2] = index;
        }
        const cipher = crypto.createCipheriv('aes-128-cbc', key, ivForSequence(5 + index));
        data = Buffer.concat([cipher.update(plain), cipher.final()]);
        onSegment(id, index);
      }
      if (typeof data !== 'string') data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      return { data, finalUrl: url };
    } finally { active--; }
  };
  return { request, keyCounts, get peak() { return peak; }, get active() { return active; } };
}

test('批量 AES：录像 worker / 全局请求 / 缓存窗口有界，慢写盘按序输出，key 每条只取一次', async () => {
  const batch = createBatch(entries(20));
  let open = 0, maxOpen = 0, buffered = 0, peakBuffered = 0, bytes = 0;
  const server = hlsServer({ segments: 12, onSegment() { buffered++; peakBuffered = Math.max(peakBuffered, buffered); } });
  const limiter = createRequestLimiter(5);
  let maxRunning = 0;
  const result = await runBatch(batch, {
    recordingConcurrency: 3, segmentConcurrency: 4, limiter, request: server.request,
    locate: async (url, { allowManual }) => { assert.equal(allowManual, false); return url; },
    openSink: async (filename) => {
      const id = Number(filename.match(/\d+/)[0]);
      let next = 0;
      open++; maxOpen = Math.max(maxOpen, open);
      return {
        kind: 'file',
        async write(data) {
          assert.equal(data[0], 0x47); assert.equal(data[188], 0x47);
          assert.equal(data[1], id); assert.equal(data[2], next++);
          await delay(4); // 磁盘背压也必须算入窗口。
          buffered--; bytes += data.byteLength;
        },
        close() { assert.equal(next, 12); open--; },
        abort() { assert.fail('成功任务不应 abort 文件'); },
      };
    },
    onChange() { maxRunning = Math.max(maxRunning, batch.tasks.filter((t) => t.status === 'running').length); },
  });
  assert.equal(result.completed, 20); assert.equal(result.percent, 100);
  assert.equal(bytes, 20 * 12 * 376); assert.equal(result.bytes, bytes);
  assert.equal(result.badTs, 0); assert.equal(buffered, 0);
  assert.equal(maxOpen, 3); assert.equal(maxRunning, 3);
  assert.equal(server.peak, 5); assert.equal(server.active, 0);
  assert.ok(peakBuffered <= 3 * 4, `缓存分片峰值 ${peakBuffered}`);
  assert.ok([...server.keyCounts.values()].every((n) => n === 1));
  assert.equal(limiter.active, 0); assert.equal(limiter.queued, 0);
});

test('捕获、HTTP、写盘、提交和创建文件失败互相隔离，剩余录像继续完成', async () => {
  const batch = createBatch(entries(7));
  const server = hlsServer({ segments: 2, failedId: '1' });
  const aborted = [];
  await runBatch(batch, {
    request: server.request,
    locate: async (url) => { if (url.includes('/0/')) throw new Error('capture failed'); return url; },
    openSink: async (filename) => {
      const id = filename.match(/\d+/)[0];
      if (id === '4') throw new Error('create failed');
      return {
        kind: 'file',
        write() { if (id === '2') throw new Error('disk full'); },
        close() { if (id === '3') throw new Error('close failed'); },
        abort() { aborted.push(id); },
      };
    },
  });
  assert.deepEqual(batch.tasks.map((t) => t.status), ['failed', 'failed', 'failed', 'failed', 'failed', 'completed', 'completed']);
  assert.deepEqual(aborted.sort(), ['0', '1', '2', '3']);
  assert.ok(batch.tasks.every((t) => t.controller.signal.aborted));
  assert.equal(batchProgress(batch).failed, 5);
});

test('取消活动单条和排队单条：其他任务继续，排队条目不创建文件', async () => {
  const batch = createBatch(entries(4));
  const server = hlsServer({ segments: 2 });
  const opened = [], aborted = [];
  let hanging = false;
  const limiter = createRequestLimiter(2);
  const run = runBatch(batch, {
    recordingConcurrency: 1, limiter,
    locate: async (url) => url,
    request: (url, type, signal, resource) => {
      if (url.includes('/0/') && resource.kind === 'segment') {
        hanging = true;
        return abortable(new Promise(() => {}), signal);
      }
      return server.request(url, type, signal, resource);
    },
    openSink: async (filename) => {
      opened.push(filename);
      return { kind: 'file', write() {}, close() {}, abort() { aborted.push(filename); } };
    },
  });
  await until(() => hanging);
  cancelBatchTask(batch, '1'); cancelBatchTask(batch, '0');
  await run;
  assert.deepEqual(batch.tasks.map((t) => t.status), ['cancelled', 'cancelled', 'completed', 'completed']);
  assert.deepEqual(opened, ['L0.ts', 'L2.ts', 'L3.ts']);
  assert.deepEqual(aborted, ['L0.ts']);
  assert.equal(limiter.active, 0); assert.equal(limiter.queued, 0);
});

test('取消整个批次：捕获立即停止，排队任务不启动，文件流全部 abort', async () => {
  const batch = createBatch(entries(30));
  let located = 0, opened = 0, aborted = 0;
  const run = runBatch(batch, {
    recordingConcurrency: 3,
    locate: () => { located++; return new Promise(() => {}); },
    request: () => assert.fail('捕获未完成不能下载'),
    openSink: async () => { opened++; return { kind: 'file', write() {}, close() {}, abort() { aborted++; } }; },
  });
  await until(() => located === 3);
  cancelBatch(batch); cancelBatch(batch);
  await run;
  assert.equal(opened, 3); assert.equal(aborted, 3);
  assert.ok(batch.tasks.every((t) => t.status === 'cancelled'));
  assert.equal(batchProgress(batch).cancelled, 30); assert.equal(batch.running, false);
});

test('慢写盘中取消单条不阻塞其他任务，提交前的进度小于 100%', async () => {
  const batch = createBatch(entries(2));
  const write = deferred(), close = deferred();
  let writing = false, closing = false, aborted = false;
  const server = hlsServer({ segments: 1 });
  const run = runBatch(batch, {
    request: server.request, locate: async (url) => url,
    openSink: async (filename) => ({
      kind: 'file',
      write() { if (filename === 'L0.ts') { writing = true; return write.promise; } },
      close() { closing = true; return close.promise; },
      abort() { aborted = true; write.resolve(); },
    }),
  });
  await until(() => writing && closing);
  cancelBatchTask(batch, '0');
  await until(() => aborted);
  assert.ok(batchProgress(batch).percent < 100);
  close.resolve(); await run;
  assert.deepEqual(batch.tasks.map((t) => t.status), ['cancelled', 'completed']);
});

test('批量模式拒绝 memory sink，不进行网络下载', async () => {
  const batch = createBatch(entries(1));
  let aborted = false;
  await runBatch(batch, {
    openSink: async () => ({ kind: 'memory', abort() { aborted = true; } }),
    locate: () => assert.fail('不应捕获'), request: () => assert.fail('不应请求'),
  });
  assert.equal(batch.tasks[0].status, 'failed'); assert.equal(aborted, true);
  assert.match(batch.tasks[0].error, /直接写入磁盘/);
});

test('内存合并逐条处理：允许 memory sink，但并发固定为 1，逐条保存', async () => {
  const batch = createBatch(entries(2));
  const server = hlsServer({ segments: 2 });
  let maxRunning = 0;
  const saved = [];
  const result = await runBatch(batch, {
    sinkKind: 'memory', request: server.request, locate: async (url) => url,
    openSink: async (filename) => ({
      kind: 'memory', filename,
      write() {}, close() { saved.push(filename); }, abort() {},
    }),
    onChange() { maxRunning = Math.max(maxRunning, batch.tasks.filter((t) => t.status === 'running').length); },
  });
  assert.equal(result.completed, 2);
  assert.equal(maxRunning, 1); // 内存合并每段约等于视频大小，必须逐条
  assert.deepEqual(saved.sort(), ['L0.ts', 'L1.ts']);
});

test('OPFS 临时文件可并行：sinkKind=opfs 按录制并发下载多条录像', async () => {
  const batch = createBatch(entries(3));
  const server = hlsServer({ segments: 2 });
  let maxRunning = 0;
  const result = await runBatch(batch, {
    sinkKind: 'opfs', recordingConcurrency: 2, request: server.request, locate: async (url) => url,
    openSink: async () => ({ kind: 'opfs', write() {}, close() {}, abort() {} }),
    onChange() { maxRunning = Math.max(maxRunning, batch.tasks.filter((t) => t.status === 'running').length); },
  });
  assert.equal(result.completed, 3);
  assert.equal(maxRunning, 2); // OPFS 写磁盘临时文件，不占内存，可按录制并发处理
});

test('并发重试仍走全局上限，AES key 失败可重试；重试等待期间取消单条', async () => {
  const batch = createBatch(entries(3));
  const server = hlsServer({ segments: 3 });
  const limiter = createRequestLimiter(2);
  const attempts = new Map();
  let waiting = false;
  const run = runBatch(batch, {
    retryDelayMs: 10, limiter, locate: async (url) => url,
    openSink: async () => ({ kind: 'file', write() {}, close() {}, abort() {} }),
    request: async (url, type, signal, resource) => {
      const count = (attempts.get(url) || 0) + 1; attempts.set(url, count);
      if (url.includes('/0/') && resource.kind === 'segment') {
        waiting = true; throw new Error('offline');
      }
      if (url.includes('/1/') && resource.kind === 'key' && count === 1) throw new Error('temporary key failure');
      if (url.includes('/2/') && resource.kind === 'segment' && count === 1) throw new Error('temporary segment failure');
      return server.request(url, type, signal, resource);
    },
  });
  await until(() => waiting);
  cancelBatchTask(batch, '0'); await run;
  assert.deepEqual(batch.tasks.map((t) => t.status), ['cancelled', 'completed', 'completed']);
  assert.equal(attempts.get('https://r.pku.edu.cn/1/key'), 2);
  assert.equal(attempts.get('https://r.pku.edu.cn/2/0.ts'), 2);
  assert.ok(server.peak <= 2); assert.equal(limiter.active, 0); assert.equal(limiter.queued, 0);
});

/** 可回填的假目录：FileSystemWritableFileStream 的 write(data) 与 write({ type: 'write', position, data })。 */
function writableDirectory() {
  const files = new Map();
  return {
    files,
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
        files.set(name, { chunks: [], closed: false });
      }
      const file = files.get(name);
      return { async createWritable() { return {
        async write(arg) {
          await delay(1);
          if (arg instanceof Uint8Array) return file.chunks.push(arg.slice());
          const all = Buffer.concat(file.chunks);
          all.set(arg.data, arg.position);
          file.chunks = [all];
        },
        async close() { file.closed = true; },
        async abort() { file.chunks = []; },
      }; } };
    },
    async removeEntry(name) { files.delete(name); },
  };
}

test('批量 MP4：H.264 录像直接写成 .mp4；HEVC 录像删除 .mp4 并在同一目录改存 .ts；取消的 .mp4 被清理', async () => {
  const h264 = makeTs({ segments: 4 });
  const hevc = makeTs({ segments: 4, videoType: 0x24 });
  const directory = writableDirectory();
  const batch = createBatch(['0', '1', '2'].map((key) => ({
    key, filename: `L${key}.mp4`, watchUrl: `https://r.pku.edu.cn/${key}/playlist.m3u8`,
  })));
  let hangStarted = false;
  const server = hlsServer({ segments: 4, payload: (id, i) => Buffer.from((id === '1' ? hevc : h264).segments[i]) });
  const run = runBatch(batch, {
    openSink: createDirectorySinkFactory(directory), locate: async (url) => url,
    request: (url, type, signal, resource) => {
      if (url.includes('/2/') && resource.kind === 'segment' && resource.index === 3) {
        hangStarted = true;
        return abortable(new Promise(() => {}), signal);
      }
      return server.request(url, type, signal, resource);
    },
  });
  await until(() => hangStarted && batch.tasks[2].done >= 2);
  cancelBatchTask(batch, '2');
  const result = await run;
  assert.deepEqual(batch.tasks.map((t) => t.status), ['completed', 'completed', 'cancelled']);
  assert.deepEqual([...directory.files.keys()].sort(), ['L0.mp4', 'L1.ts']);
  const mp4 = readMp4(new Uint8Array(Buffer.concat(directory.files.get('L0.mp4').chunks)));
  assert.equal(mp4.tracks[0].samples.length, h264.video.length);
  assert.equal(mp4.tracks[1].samples.length, h264.audio.length);
  assert.ok(Buffer.concat(directory.files.get('L1.ts').chunks).equals(Buffer.concat(hevc.segments)), 'TS 回退文件与原始流逐字节一致');
  assert.equal(batch.tasks[1].filename, 'L1.ts');
  assert.ok(batch.tasks[1].fallback);
  assert.match(batch.tasks[1].notice, /H\.265\/HEVC.*无法无损转为 MP4，已改存为 TS/);
  assert.equal(result.fallbacks, 1);
  assert.ok([...directory.files.values()].every((f) => f.closed));
});

test('批量 MP4：解密后不是 TS 时失败并删除 .mp4，不回退保存', async () => {
  const directory = writableDirectory();
  const batch = createBatch([{ key: '0', filename: 'L0.mp4', watchUrl: 'https://r.pku.edu.cn/0/playlist.m3u8' }]);
  const server = hlsServer({ segments: 2, payload: () => Buffer.alloc(200000, 0x5a) });
  await runBatch(batch, { openSink: createDirectorySinkFactory(directory), locate: async (url) => url, request: server.request });
  assert.equal(batch.tasks[0].status, 'failed');
  assert.match(batch.tasks[0].error, /不是有效的 MPEG-TS/);
  assert.equal(directory.files.size, 0);
});
