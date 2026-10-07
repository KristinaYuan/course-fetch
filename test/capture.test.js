import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PENDING_KEY,
  RESULT_KEY,
  pendingKey,
  resultKey,
  isM3u8Url,
  watchM3u8Requests,
  runPlayerCapture,
  capturePlaylist,
} from '../src/capture.js';
import { locatePlaylist } from '../src/page.js';
import { captureTabUrl, captureIdFromUrl, resolveCaptureId, bridgeCaptureId } from '../src/capture-context.js';

const M3U8 = 'https://resourcese.pku.edu.cn/play/abc/playlist.m3u8?t=SECRET';
const WATCH = 'https://course.pku.edu.cn/webapps/v/playVideo.action?token=x';

/** 模拟多个标签页共享的 GM storage：set 时通知其它“标签页”的监听者。 */
function fakeKv() {
  const data = new Map();
  const listeners = new Map();
  let nextId = 0;
  return {
    data,
    get: (k, d) => (data.has(k) ? data.get(k) : d),
    set(k, v) {
      data.set(k, v);
      for (const l of listeners.values()) if (l.k === k) queueMicrotask(() => l.cb(v));
    },
    delete: (k) => data.delete(k),
    onChange(k, cb) {
      const id = ++nextId;
      listeners.set(id, { k, cb });
      return () => listeners.delete(id);
    },
    listenerCount: () => listeners.size,
  };
}

function fakePerf(initial = []) {
  const entries = initial.map((name) => ({ name }));
  let observerCb = null;
  const perf = {
    getEntriesByType: (t) => (t === 'resource' ? entries.slice() : []),
    setResourceTimingBufferSize() {},
    add(name) {
      entries.push({ name });
      if (observerCb) observerCb({ getEntries: () => [{ name }] });
    },
  };
  class Observer {
    constructor(cb) {
      observerCb = cb;
    }
    observe(opts) {
      assert.deepEqual(opts, { type: 'resource', buffered: true });
    }
    disconnect() {
      observerCb = null;
    }
  }
  return { perf, Observer, observing: () => observerCb !== null };
}

test('isM3u8Url', () => {
  assert.equal(isM3u8Url(M3U8), true);
  assert.equal(isM3u8Url('https://a.pku.edu.cn/x/index.m3u8'), true);
  assert.equal(isM3u8Url('https://a.pku.edu.cn/x/index.m3u8#t'), true);
  assert.equal(isM3u8Url('https://a.pku.edu.cn/x/seg.ts'), false);
  assert.equal(isM3u8Url('https://a.pku.edu.cn/x/a.m3u8x'), false);
  assert.equal(isM3u8Url('blob:https://a/x.m3u8'), false);
  assert.equal(isM3u8Url(null), false);
});

test('watchM3u8Requests：已有条目（getEntriesByType）与 PerformanceObserver 新条目，去重，stop 后停止', () => {
  const { perf, Observer, observing } = fakePerf(['https://a.pku.edu.cn/player.js', M3U8]);
  const found = [];
  const stop = watchM3u8Requests((u) => found.push(u), { perf, Observer, pollMs: 10000 });
  assert.deepEqual(found, [M3U8]);
  perf.add('https://a.pku.edu.cn/seg_0.ts');
  perf.add('https://a.pku.edu.cn/v/index.m3u8');
  perf.add(M3U8); // 重复
  assert.deepEqual(found, [M3U8, 'https://a.pku.edu.cn/v/index.m3u8']);
  stop();
  assert.equal(observing(), false);
});

test('watchM3u8Requests：没有 PerformanceObserver 时靠轮询发现', async () => {
  const { perf } = fakePerf();
  const found = [];
  const stop = watchM3u8Requests((u) => found.push(u), { perf, Observer: undefined, pollMs: 5 });
  perf.add(M3U8);
  await new Promise((r) => setTimeout(r, 30));
  stop();
  assert.deepEqual(found, [M3U8]);
});

test('runPlayerCapture：没有 pending 或已过期时什么都不做', async () => {
  const kv = fakeKv();
  let watched = false;
  const watch = () => {
    watched = true;
    return () => {};
  };
  assert.equal(await runPlayerCapture({ kv, watch, captureId: 'old' }), false);
  kv.set(pendingKey('old'), { id: 'old', expires: Date.now() - 1 });
  assert.equal(await runPlayerCapture({ kv, watch, captureId: 'old' }), false);
  assert.equal(watched, false);
});

test('capturePlaylist + runPlayerCapture：打开临时页 → 播放器页捕获 → 回传 URL → 关闭临时页并清理 storage', async () => {
  const kv = fakeKv();
  const tabs = [];
  const openTab = (url) => {
    const tab = { url, closed: false, close() { this.closed = true; } };
    tabs.push(tab);
    // 模拟新标签页：播放器 iframe 中 userscript 启动，稍后播放器请求 m3u8
    setTimeout(() => {
      const { perf, Observer } = fakePerf(['https://onlineroomse.pku.edu.cn/player.js']);
      runPlayerCapture({
        kv,
        captureId: captureIdFromUrl(url),
        host: 'onlineroomse.pku.edu.cn',
        watch: (cb) => watchM3u8Requests(cb, { perf, Observer, pollMs: 10000 }),
        nudgeAfterMs: 10000,
      });
      setTimeout(() => perf.add(M3U8), 10);
    }, 5);
    return tab;
  };
  const url = await capturePlaylist({ watchUrl: WATCH, kv, openTab, timeoutMs: 2000 });
  assert.equal(url, M3U8);
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].url.split('#')[0], WATCH);
  assert.equal(tabs[0].closed, true);
  assert.equal(kv.data.size, 0, '捕获记录读取后立即删除');
  assert.equal(kv.listenerCount(), 0);
});

test('capturePlaylist：pending 中只有 id 和过期时间，不含观看链接', async () => {
  const kv = fakeKv();
  let pending = null;
  const openTab = (url) => {
    pending = kv.get(pendingKey(captureIdFromUrl(url)));
    setTimeout(() => kv.set(resultKey(pending.id), { id: pending.id, url: M3U8 }), 5);
    return { close() {} };
  };
  await capturePlaylist({ watchUrl: WATCH, kv, openTab, timeoutMs: 2000 });
  assert.deepEqual(Object.keys(pending).sort(), ['expires', 'id']);
  assert.ok(pending.expires > Date.now());
});

test('capturePlaylist：忽略其它 capture id 的结果', async () => {
  const kv = fakeKv();
  const openTab = (url) => {
    const id = captureIdFromUrl(url);
    setTimeout(() => kv.set(resultKey(id), { id: 'someone-else', url: 'https://x.pku.edu.cn/wrong.m3u8' }), 5);
    setTimeout(() => kv.set(resultKey(id), { id, url: M3U8 }), 20);
    return { close() {} };
  };
  assert.equal(await capturePlaylist({ watchUrl: WATCH, kv, openTab, timeoutMs: 2000 }), M3U8);
});

test('capturePlaylist：值变化监听不可用时靠轮询读取结果', async () => {
  const kv = fakeKv();
  kv.onChange = () => () => {};
  const openTab = (url) => {
    const id = captureIdFromUrl(url);
    setTimeout(() => kv.data.set(resultKey(id), { id, url: M3U8 }), 5);
    return { close() {} };
  };
  assert.equal(await capturePlaylist({ watchUrl: WATCH, kv, openTab, timeoutMs: 2000, pollMs: 10 }), M3U8);
});

test('capturePlaylist：超时 → CaptureTimeout，关闭临时页并清理', async () => {
  const kv = fakeKv();
  const tab = { closed: false, close() { this.closed = true; } };
  await assert.rejects(
    capturePlaylist({ watchUrl: WATCH, kv, openTab: () => tab, timeoutMs: 30 }),
    (e) => e.name === 'CaptureTimeout' && /超时/.test(e.message),
  );
  assert.equal(tab.closed, true);
  assert.equal(kv.data.size, 0);
});

test('capturePlaylist：取消 → AbortError，关闭临时页', async () => {
  const kv = fakeKv();
  const ctrl = new AbortController();
  const tab = { closed: false, close() { this.closed = true; } };
  setTimeout(() => ctrl.abort(), 10);
  await assert.rejects(
    capturePlaylist({ watchUrl: WATCH, kv, openTab: () => tab, timeoutMs: 5000, signal: ctrl.signal }),
    (e) => e.name === 'AbortError',
  );
  assert.equal(tab.closed, true);
  assert.equal(kv.data.size, 0);
});

test('locatePlaylist：捕获成功时不弹出手动输入', async () => {
  let asked = false;
  const url = await locatePlaylist(WATCH, {
    capture: async ({ watchUrl }) => (watchUrl === WATCH ? M3U8 : null),
    ask: () => {
      asked = true;
    },
  });
  assert.equal(url, M3U8);
  assert.equal(asked, false);
});

test('locatePlaylist：只有超时才退回手动输入；其它错误直接抛出', async () => {
  const timeout = Object.assign(new Error('自动捕获播放列表超时（20 秒）'), { name: 'CaptureTimeout' });
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const url = await locatePlaylist(WATCH, {
      capture: async () => {
        throw timeout;
      },
      ask: () => 'https://resourcese.pku.edu.cn/manual/playlist.m3u8',
    });
    assert.equal(url, 'https://resourcese.pku.edu.cn/manual/playlist.m3u8');
  } finally {
    console.warn = origWarn;
  }
  const abort = Object.assign(new Error('已取消'), { name: 'AbortError' });
  await assert.rejects(
    locatePlaylist(WATCH, {
      capture: async () => {
        throw abort;
      },
      ask: () => assert.fail('不应弹出手动输入'),
    }),
    (e) => e === abort,
  );
});

test('并发 capture：乱序回传、超时和取消仅清理自身任务，迟到结果不会串片', async () => {
  const kv = fakeKv();
  const tabs = new Map();
  const callbacks = new Map();
  const controllers = new Map();
  const start = (id, timeoutMs = 500) => {
    const controller = new AbortController(); controllers.set(id, controller);
    return capturePlaylist({
      watchUrl: WATCH, kv, signal: controller.signal, newId: () => id, timeoutMs,
      openTab(url) {
        assert.equal(captureIdFromUrl(url), id);
        const tab = { closed: false, close() { this.closed = true; } }; tabs.set(id, tab);
        runPlayerCapture({ kv, captureId: id, watch(cb) { callbacks.set(id, cb); return () => {}; } });
        return tab;
      },
    });
  };
  const a = start('a'), b = start('b'), c = start('c'), timeout = start('timeout', 10);
  const cancelled = assert.rejects(c, { name: 'AbortError' });
  const timedOut = assert.rejects(timeout, { name: 'CaptureTimeout' });
  callbacks.get('b')('https://r.pku.edu.cn/b/playlist.m3u8');
  assert.equal(await b, 'https://r.pku.edu.cn/b/playlist.m3u8');
  assert.ok(kv.get(pendingKey('a'))); assert.ok(kv.get(pendingKey('c')));
  controllers.get('c').abort(); await cancelled;
  callbacks.get('c')('https://r.pku.edu.cn/wrong/playlist.m3u8');
  assert.equal(kv.get(resultKey('c')), undefined);
  await timedOut;
  callbacks.get('timeout')('https://r.pku.edu.cn/stale/playlist.m3u8');
  assert.equal(kv.get(resultKey('timeout')), undefined);
  callbacks.get('a')(M3U8);
  assert.equal(await a, M3U8);
  assert.equal(kv.data.size, 0); assert.equal(kv.listenerCount(), 0);
  assert.ok([...tabs.values()].every((tab) => tab.closed));
});

test('普通播放页不领取正在执行的捕获；批量捕获超时不触发手动弹窗', async () => {
  const kv = fakeKv();
  kv.set(PENDING_KEY, { id: 'legacy', expires: Date.now() + 1000 });
  kv.set(pendingKey('active'), { id: 'active', expires: Date.now() + 1000 });
  const ordinary = fakeWindow(WATCH);
  assert.equal(await runPlayerCapture({ kv, win: ordinary, watch() { assert.fail('普通播放页不能捕获'); } }), false);
  const error = Object.assign(new Error('timeout'), { name: 'CaptureTimeout' });
  await assert.rejects(locatePlaylist(WATCH, {
    allowManual: false, capture: async () => { throw error; }, ask: () => assert.fail('批量不能弹窗'),
  }), (e) => e === error);
});

function fakeWindow(url) {
  const listeners = new Map();
  const win = {
    location: { href: url }, frames: [],
    addEventListener(type, cb) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(cb); },
    removeEventListener(type, cb) { listeners.get(type)?.delete(cb); },
    emit(type, event) { for (const cb of [...(listeners.get(type) || [])]) cb(event); },
    count() { return [...listeners.values()].reduce((sum, group) => sum + group.size, 0); },
  };
  win.parent = win;
  return win;
}
function connect(parent, child) {
  const parentProxy = { postMessage(data) { parent.emit('message', { source: childProxy, data, origin: new URL(child.location.href).origin }); } };
  const childProxy = { postMessage(data) { child.emit('message', { source: parentProxy, data, origin: new URL(parent.location.href).origin }); } };
  parent.frames.push(childProxy);
  child.parent = parentProxy;
}

test('capture 身份从 fragment 经跨域父子握手传到多层 iframe，保留原 URL 参数', async () => {
  const url = captureTabUrl(`${WATCH}#tab=video`, 'task-id');
  assert.equal(url.split('#')[0], WATCH);
  assert.match(url, /#tab=video&course-fetch-capture=task-id$/);
  const top = fakeWindow(url), frame = fakeWindow('https://onlineroomse.pku.edu.cn/player'), leaf = fakeWindow('https://r.pku.edu.cn/nested');
  connect(top, frame); connect(frame, leaf);
  const id = await resolveCaptureId(top);
  const stopTop = bridgeCaptureId(top, id, () => true);
  assert.equal(await resolveCaptureId(frame), 'task-id');
  const stopFrame = bridgeCaptureId(frame, id, () => true);
  assert.equal(await resolveCaptureId(leaf), 'task-id');
  stopFrame(); stopTop();
  assert.equal(top.count() + frame.count() + leaf.count(), 0);
});

test('frame 忽略非父窗口回复；bridge 拒绝非直属 frame 和已失效任务', async () => {
  const top = fakeWindow(captureTabUrl(WATCH, 'id')), frame = fakeWindow('https://r.pku.edu.cn/player');
  connect(top, frame);
  const found = resolveCaptureId(frame, 10);
  frame.emit('message', { source: {}, data: { type: 'course-fetch:capture-context-response', id: 'wrong' } });
  assert.equal(await found, null);
  let responses = 0;
  const stop = bridgeCaptureId(top, 'id', () => true);
  top.emit('message', { source: { postMessage() { responses++; } }, data: { type: 'course-fetch:capture-context-request' } });
  assert.equal(responses, 0); stop();
  const stopExpired = bridgeCaptureId(top, 'id', () => false);
  assert.equal(await resolveCaptureId(frame, 10), null);
  stopExpired(); assert.equal(frame.count() + top.count(), 0);
});
