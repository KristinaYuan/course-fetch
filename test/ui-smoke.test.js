import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { build } from '../build.mjs';
import { uiDocument } from './ui-dom.js';
import { h } from './mini-dom.js';
import { makeTs } from './ts-fixture.js';
import { readMp4 } from './mp4-reader.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 300; i++) { if (fn()) return; await delay(5); }
  assert.fail('打包脚本冒烟等待超时');
}

test('打包脚本 UI 冒烟：默认 MP4、单条/批量都选目录直接写盘、批次结束确认恢复、独立取消、整个批次取消、API 不支持、内存回退、切换 TS、HEVC 回退', async () => {
  const row = (i) => h('tr', {},
    h('th', { scope: 'row' }, `2026-09-${20 + i}第3-4节`),
    h('td', {}, h('span', { class: 'table-data-cell-value' }, `2026-09-${20 + i} 10:10:00`)),
    h('td', {}, h('span', { class: 'table-data-cell-value' }, '王老师')),
    h('td', {}, h('span', { class: 'table-data-cell-value' }, h('a', { href: `playVideo.action?token=${i}` }, '观看'))));
  const document = uiDocument([h('table', {}, row(0), row(1), row(2))]);
  const values = new Map(), listeners = new Map(), tabs = [], files = new Map();
  const timers = new Set();
  const timeout = (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); return timer; };
  let nextListener = 0, picks = 0, saves = 0, hang = null;
  const blobs = [];
  class TestURL extends URL {
    static createObjectURL(blob) { blobs.push(blob); return `blob:test/${blobs.length}`; }
    static revokeObjectURL() {}
  }
  const key = Buffer.alloc(16, 3), segments = 8;
  const source = makeTs({ segments, framesPerSegment: 3 });
  const hevcSource = makeTs({ segments, framesPerSegment: 3, videoType: 0x24 });
  let hevc = false;
  const setValue = (k, value) => {
    values.set(k, value);
    for (const listener of listeners.values()) if (listener.k === k) queueMicrotask(() => listener.cb(k, undefined, value));
  };
  const makeStream = (name) => {
    const file = { chunks: [], closed: false, frames: 0 };
    files.set(name, file);
    return {
      async write(arg) {
        await delay(2);
        if (arg instanceof Uint8Array) return file.chunks.push(Buffer.from(arg));
        assert.equal(arg.type, 'write');
        const all = Buffer.concat(file.chunks);
        all.set(arg.data, arg.position);
        file.chunks = [all];
      },
      async close() {
        file.closed = true;
        file.bytes = Buffer.concat(file.chunks);
        if (name.endsWith('.mp4')) file.frames = readMp4(new Uint8Array(file.bytes)).tracks[0].samples.length;
      },
      async abort() { file.chunks = []; },
    };
  };
  const window = {
    addEventListener() {},
    async showSaveFilePicker({ suggestedName }) { saves++; return { createWritable: async () => makeStream(suggestedName) }; },
    async showDirectoryPicker() {
      picks++;
      return {
        async getFileHandle(name, options) {
          if (!options && !files.has(name)) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
          return { createWritable: async () => makeStream(name) };
        },
        async removeEntry(name) { files.delete(name); },
      };
    },
  };
  window.parent = window.top = window;
  const context = {
    window, document, location: { href: 'https://course.pku.edu.cn/webapps/videoList.action?course_id=x' },
    URL: TestURL, URLSearchParams, AbortController, Uint8Array, Blob, crypto: crypto.webcrypto,
    setTimeout: timeout, clearTimeout, setInterval, clearInterval, confirm: () => true,
    CSS: { escape: (s) => s }, console: { info() {}, warn() {} },
    GM_getValue: (k, fallback) => values.has(k) ? values.get(k) : fallback,
    GM_setValue: setValue, GM_deleteValue: (k) => values.delete(k),
    GM_addValueChangeListener(k, cb) { const id = ++nextListener; listeners.set(id, { k, cb }); return id; },
    GM_removeValueChangeListener: (id) => listeners.delete(id),
    GM_openInTab(url) {
      const u = new URL(url), id = new URLSearchParams(u.hash.slice(1)).get('course-fetch-capture');
      const tab = { closed: false, close() { this.closed = true; } }; tabs.push(tab);
      timeout(() => { if (!tab.closed) setValue(`capture:result:${id}`, { id, url: `https://r.pku.edu.cn/${u.searchParams.get('token')}/playlist.m3u8` }); }, 5);
      return tab;
    },
    GM_xmlhttpRequest(options) {
      const u = new URL(options.url), [id, name] = u.pathname.slice(1).split('/');
      let cancelled = false;
      timeout(() => {
        if (cancelled || (id === hang && name.endsWith('.ts'))) return;
        let data;
        if (name === 'playlist.m3u8') {
          data = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n';
          for (let i = 0; i < segments; i++) data += `#EXTINF:1,\n${i}.ts\n`;
          data += '#EXT-X-ENDLIST';
        } else if (name === 'key') data = key;
        else {
          const index = Number(name.replace('.ts', '')), plain = Buffer.from((hevc ? hevcSource : source).segments[index]);
          const iv = Buffer.alloc(16); iv.writeUInt32BE(index, 12);
          const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
          data = Buffer.concat([cipher.update(plain), cipher.final()]);
        }
        options.onload({ status: 200, finalUrl: options.url, responseText: typeof data === 'string' ? data : undefined,
          response: typeof data === 'string' ? undefined : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
      }, 2);
      return { abort() { cancelled = true; options.onabort(); } };
    },
  };
  try {
    vm.runInNewContext(await build({ write: false }), context);
    const root = document.shadowRoot, $ = (s) => root.querySelector(s);
    const rows = () => root.querySelectorAll('tbody tr');
    await until(() => /3 条录像/.test($('.status').textContent));
    const taskStates = () => rows().map((r) => r.querySelector('.task-state').textContent);

    // 单条：与批量相同，选一次目录后直接写盘，不弹另存为、不在内存合并。
    rows()[0].querySelector('[data-row="download"]').click();
    await until(() => /已完成：/.test($('.status').textContent));
    assert.equal(picks, 1); assert.equal(saves, 0); assert.equal(blobs.length, 0);
    assert.deepEqual([...files.keys()], ['L01-2026-09-20-第3-4节.mp4']);
    assert.ok([...files.values()][0].closed);
    assert.equal([...files.values()][0].frames, segments * 3);
    assert.match($('.status').textContent, /已完成：L01-2026-09-20-第3-4节\.mp4/);
    assert.ok($('.dl').hidden);
    files.clear();
    const statusBeforeBatch = $('.status').textContent;

    $('[data-act="all"]').click(); hang = '1';
    $('[data-act="download"]').click();
    await until(() => taskStates()[0].includes('已完成') && taskStates()[2].includes('已完成'));
    assert.match($('.count').textContent, /批量 .*2\/3/);
    assert.match(taskStates()[1], /下载中/);
    rows()[1].querySelector('[data-row="batch-cancel"]').click();
    await until(() => /批次结束：成功 2，失败 0，取消 1/.test($('.status').textContent));
    assert.equal(picks, 2); assert.equal(files.size, 2);
    assert.ok([...files.values()].every((f) => f.closed && f.frames === segments * 3));
    assert.ok([...files.keys()].every((name) => name.endsWith('.mp4')));
    assert.ok(!rows()[1].querySelector('[data-row="download"]').disabled);
    // 批次结束：进度区保留结果并等待确认
    assert.ok(!$('.dl').hidden);
    assert.equal($('.dl-cancel').textContent, '确定');
    assert.ok(!$('.dl-cancel').disabled);
    assert.match($('.dl-l1').textContent, /批量下载已结束：成功 2 · 失败 0 · 取消 1/);
    assert.match($('.count').textContent, /批量结束 · 成功 2\/3/);

    // 未确认时也可以直接开始下一批
    $('[data-act="download"]').click();
    await until(() => rows().some((r) => /自动捕获/.test(r.querySelector('.task-state').textContent)));
    $('.dl-cancel').click();
    await until(() => /批次结束：成功 0，失败 0，取消 3/.test($('.status').textContent));
    assert.equal(picks, 3); assert.equal(files.size, 2);
    assert.ok(tabs.every((tab) => tab.closed));
    assert.equal([...values.keys()].filter((k) => k.startsWith('capture:')).length, 0);
    assert.equal(listeners.size, 0);
    // 点「确定」：清除结果，恢复下载前的列表和状态
    $('.dl-cancel').click();
    assert.ok($('.dl').hidden);
    assert.equal($('.status').textContent, statusBeforeBatch);
    assert.equal($('.count').textContent, '3 条');
    assert.ok(taskStates().every((t) => t === ''));

    // 取消目录选择：什么都没开始，直接恢复，不需要确认
    const picker = window.showDirectoryPicker;
    window.showDirectoryPicker = async () => { throw Object.assign(new Error('cancel'), { name: 'AbortError' }); };
    $('[data-act="download"]').click();
    await until(() => /已取消批量下载（未选择目录）/.test($('.status').textContent));
    assert.ok($('.dl').hidden);
    assert.ok(taskStates().every((t) => t === ''));

    // 浏览器不支持目录写入（也无 OPFS）：批量改走内存合并、逐条保存，而不是失败。
    delete window.showDirectoryPicker;
    hang = null;
    $('[data-act="download"]').click();
    await until(() => /批次结束：成功 3，失败 0，取消 0/.test($('.status').textContent));
    assert.ok(taskStates().every((t) => /已完成/.test(t)));
    assert.equal(picks, 3); assert.equal(saves, 0);
    assert.equal(blobs.length, 3);
    $('.dl-cancel').click();
    assert.ok($('.dl').hidden);

    // 浏览器不支持目录写入：单条退回内存合并，并明确显示原因；取消后不保存
    $('[data-act="none"]').click();
    hang = '0';
    rows()[0].querySelector('[data-row="download"]').click();
    await until(() => /不支持目录写入.*改为在内存中合并/.test($('.dl-note').textContent) && !$('.dl-note').hidden);
    $('.dl-cancel').click();
    await until(() => /已取消下载/.test($('.status').textContent));
    assert.equal(blobs.length, 3);
    hang = null;
    rows()[0].querySelector('[data-row="download"]').click();
    await until(() => /已完成：/.test($('.status').textContent));
    assert.equal(blobs.length, 4);
    assert.equal(blobs[3].type, 'video/mp4');
    assert.equal(readMp4(new Uint8Array(await blobs[3].arrayBuffer())).tracks[0].samples.length, segments * 3);
    window.showDirectoryPicker = picker;

    // 切换为 TS：文件名和保存内容都是原始解密 TS；选择会被记住。
    $('.fmt').value = 'ts'; $('.fmt').dispatch('change');
    assert.equal(values.get('format'), 'ts');
    assert.match(rows()[0].querySelector('.fn').textContent, /\.ts$/);
    files.clear();
    rows()[0].querySelector('[data-row="download"]').click();
    await until(() => /已完成：L01-2026-09-20-第3-4节\.ts/.test($('.status').textContent));
    assert.ok(files.get('L01-2026-09-20-第3-4节.ts').bytes.equals(Buffer.concat(source.segments)));

    // 单条 MP4 遇到 HEVC：与批量相同，删除 .mp4 并在同一目录改存原始 TS，不重新编码。
    $('.fmt').value = 'mp4'; $('.fmt').dispatch('change');
    hevc = true; files.clear();
    rows()[0].querySelector('[data-row="download"]').click();
    await until(() => /已改存为 TS|下载失败/.test($('.status').textContent));
    assert.match($('.status').textContent, /已完成：L01-2026-09-20-第3-4节\.ts.*H\.265\/HEVC.*无法无损转为 MP4，已改存为 TS/);
    assert.deepEqual([...files.keys()], ['L01-2026-09-20-第3-4节.ts']);
    assert.ok(files.get('L01-2026-09-20-第3-4节.ts').bytes.equals(Buffer.concat(hevcSource.segments)));
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
});
