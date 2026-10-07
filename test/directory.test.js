import test from 'node:test';
import assert from 'node:assert/strict';
import { pickDownloadDirectory, createDirectorySinkFactory, pickSingleTarget } from '../src/directory.js';

function directoryFake(existing = []) {
  const files = new Map(existing.map((name) => [name, { existing: true }]));
  return {
    files,
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
        files.set(name, { writes: 0, closed: false, aborted: false });
      }
      const file = files.get(name);
      return { async createWritable() { assert.ok(!file.existing, '不能覆盖已有文件'); return {
        write() { file.writes++; }, close() { file.closed = true; }, abort() { file.aborted = true; },
      }; } };
    },
    async removeEntry(name) { files.delete(name); },
  };
}

test('目录选择一次；不支持 API 或权限失败时明确失败，不退回 Blob', async () => {
  let calls = 0;
  const directory = {};
  assert.equal(await pickDownloadDirectory({ showDirectoryPicker(options) { calls++; assert.equal(options.mode, 'readwrite'); return directory; } }), directory);
  assert.equal(calls, 1);
  await assert.rejects(pickDownloadDirectory({}), /批量下载需要/);
  const denied = Object.assign(new Error('denied'), { name: 'SecurityError' });
  await assert.rejects(pickDownloadDirectory({ showDirectoryPicker() { throw denied; } }), (e) => e === denied);
});

test('同名并发录像和已有文件不覆盖；顺序写流，abort 清理本任务文件', async () => {
  const directory = directoryFake(['lecture.ts']);
  const open = createDirectorySinkFactory(directory);
  const sinks = await Promise.all([open('lecture.ts'), open('lecture.ts'), open('LECTURE.ts')]);
  assert.equal(new Set(sinks.map((s) => s.filename.toLowerCase())).size, 3);
  assert.ok(sinks.every((s) => s.kind === 'file' && s.filename.toLowerCase() !== 'lecture.ts'));
  await sinks[0].write(new Uint8Array(1)); await sinks[0].close();
  await sinks[1].abort(); await sinks[2].abort();
  assert.equal(directory.files.size, 2);
  assert.equal(directory.files.get(sinks[0].filename).writes, 1);
  assert.equal(directory.files.get(sinks[0].filename).closed, true);
  assert.equal(directory.files.get('lecture.ts').existing, true);
});

test('取消已排队文件创建不落盘；创建过程中取消也会关闭迟到的流并删除空文件', async () => {
  const directory = directoryFake();
  const ctrl = new AbortController(); ctrl.abort();
  await assert.rejects(createDirectorySinkFactory(directory)('a.ts', ctrl.signal), { name: 'AbortError' });
  assert.equal(directory.files.size, 0);
  const late = new AbortController(); let aborted = false, removed = false;
  const slowDirectory = {
    async getFileHandle(name, options) {
      if (!options) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      return { async createWritable() { late.abort(); return { abort() { aborted = true; } }; } };
    },
    async removeEntry() { removed = true; },
  };
  await assert.rejects(createDirectorySinkFactory(slowDirectory)('a.ts', late.signal), { name: 'AbortError' });
  assert.ok(aborted && removed);
});

test('同名避让保留实际扩展名：.mp4 / 无扩展名', async () => {
  const directory = directoryFake(['a.mp4', 'b']);
  const open = createDirectorySinkFactory(directory);
  assert.equal((await open('a.mp4')).filename, 'a (2).mp4');
  assert.equal((await open('b')).filename, 'b (2)');
});

test('单条保存位置：有目录 API 时直接写盘；仅在不支持或 SecurityError 时退回内存并给出原因；取消选择抛 AbortError', async () => {
  const directory = directoryFake();
  const target = await pickSingleTarget({ showDirectoryPicker: async ({ mode }) => { assert.equal(mode, 'readwrite'); return directory; } });
  assert.equal(target.kind, 'file');
  const sink = await target.open('a.mp4');
  assert.equal(sink.kind, 'file'); assert.equal(sink.filename, 'a.mp4');
  assert.ok(directory.files.has('a.mp4'));

  const missing = await pickSingleTarget({});
  assert.equal(missing.kind, 'memory'); assert.match(missing.reason, /不支持目录写入/);
  const memory = await missing.open('b.mp4');
  assert.equal(memory.kind, 'memory'); assert.equal(memory.filename, 'b.mp4');

  const denied = await pickSingleTarget({ showDirectoryPicker() { throw Object.assign(new Error('x'), { name: 'SecurityError' }); } });
  assert.equal(denied.kind, 'memory'); assert.match(denied.reason, /跨域 iframe/);

  await assert.rejects(pickSingleTarget({ showDirectoryPicker() { throw Object.assign(new Error('x'), { name: 'AbortError' }); } }), { name: 'AbortError' });
  await assert.rejects(pickSingleTarget({ showDirectoryPicker() { throw Object.assign(new Error('nope'), { name: 'NotAllowedError' }); } }), { name: 'NotAllowedError' });
});
