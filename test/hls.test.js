import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import * as hls from '../src/hls.js';
import * as downloader from '../src/downloader.js';
import { toTsFilename } from '../src/parser.js';

const Hls = { ...hls, ...downloader, toTsFilename };

const BASE = 'https://resourcese.pku.edu.cn/play/abc/playlist.m3u8?t=1';
const KEY = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const KEY_URI = 'https://resourcese.pku.edu.cn/taskflow/harpocrates/rose/key1';

// 用 node:crypto（与脚本使用的 WebCrypto 相互独立）生成 AES-128-CBC + PKCS#7 密文
function encrypt(plain, key, iv) {
  const c = nodeCrypto.createCipheriv('aes-128-cbc', key, Buffer.from(iv));
  return Buffer.concat([c.update(plain), c.final()]);
}
const toBuf = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
const arrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const SAMPLE = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-KEY:METHOD=AES-128,URI="${KEY_URI}"
#EXTINF:12.24,
segment_0.ts
#EXTINF:8.76,
segment_1.ts
#EXT-X-ENDLIST
`;

// ---- m3u8 解析 -----------------------------------------------------------------
test('parseM3U8：示例 media playlist', () => {
  const pl = Hls.parseM3U8(SAMPLE, BASE);
  assert.equal(pl.type, 'media');
  assert.equal(pl.mediaSequence, 0);
  assert.equal(pl.endList, true);
  assert.deepEqual(
    pl.segments.map((s) => [s.uri, s.duration, s.seq]),
    [
      ['https://resourcese.pku.edu.cn/play/abc/segment_0.ts', 12.24, 0],
      ['https://resourcese.pku.edu.cn/play/abc/segment_1.ts', 8.76, 1],
    ],
  );
  assert.deepEqual(pl.segments[0].key, { method: 'AES-128', uri: KEY_URI, iv: null, keyformat: 'identity' });
});

test('parseM3U8：CRLF、MEDIA-SEQUENCE 偏移、显式 IV、key 切换、METHOD=NONE', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-MEDIA-SEQUENCE:100',
    '#EXT-X-KEY:METHOD=AES-128,URI="k1",IV=0x0000000000000000000000000000ABCD',
    '#EXTINF:10,',
    'a.ts',
    '#EXT-X-KEY:METHOD=AES-128,URI="k2"',
    '#EXTINF:10,',
    'b.ts',
    '#EXT-X-KEY:METHOD=NONE',
    '#EXTINF:5,',
    'c.ts',
  ].join('\r\n');
  const pl = Hls.parseM3U8(text, BASE);
  assert.deepEqual(pl.segments.map((s) => s.seq), [100, 101, 102]);
  assert.equal(pl.segments[0].key.uri, 'https://resourcese.pku.edu.cn/play/abc/k1');
  assert.equal(Buffer.from(pl.segments[0].key.iv).toString('hex'), '0000000000000000000000000000abcd');
  assert.equal(pl.segments[1].key.uri, 'https://resourcese.pku.edu.cn/play/abc/k2');
  assert.equal(pl.segments[1].key.iv, null);
  assert.equal(pl.segments[2].key, null);
});

test('parseM3U8：master playlist 与选择最高码率', () => {
  const text = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
high/index.m3u8`;
  const pl = Hls.parseM3U8(text, BASE);
  assert.equal(pl.type, 'master');
  assert.equal(pl.variants.length, 2);
  assert.deepEqual(Hls.pickVariant(pl.variants), {
    bandwidth: 2500000,
    resolution: '1280x720',
    uri: 'https://resourcese.pku.edu.cn/play/abc/high/index.m3u8',
  });
});

test('parseM3U8：非 m3u8 内容（例如登录页）报错', () => {
  assert.throws(() => Hls.parseM3U8('<html>请登录</html>', BASE), /不是有效的 m3u8/);
});

test('parseAttributes：引号内的逗号', () => {
  assert.deepEqual(Hls.parseAttributes('METHOD=AES-128,URI="https://a/k?x=1,2",IV=0x01'), {
    METHOD: 'AES-128',
    URI: 'https://a/k?x=1,2',
    IV: '0x01',
  });
});

test('assertSupported：拒绝 SAMPLE-AES 与非 identity KEYFORMAT', () => {
  const seg = (key) => [{ key }];
  assert.doesNotThrow(() => Hls.assertSupported(seg(null)));
  assert.doesNotThrow(() => Hls.assertSupported(seg({ method: 'AES-128', uri: 'k', keyformat: 'identity' })));
  assert.throws(() => Hls.assertSupported(seg({ method: 'SAMPLE-AES', uri: 'k', keyformat: 'identity' })), /不支持的加密方式 SAMPLE-AES/);
  assert.throws(
    () => Hls.assertSupported(seg({ method: 'AES-128', uri: 'k', keyformat: 'com.apple.streamingkeydelivery' })),
    /DRM/,
  );
  assert.throws(() => Hls.assertSupported(seg({ method: 'AES-128', uri: null, keyformat: 'identity' })), /缺少 URI/);
});

// ---- IV ----------------------------------------------------------------------
test('ivForSequence：128-bit big-endian', () => {
  const hex = (n) => Buffer.from(Hls.ivForSequence(n)).toString('hex');
  assert.equal(hex(0), '00000000000000000000000000000000');
  assert.equal(hex(1), '00000000000000000000000000000001');
  assert.equal(hex(256), '00000000000000000000000000000100');
  assert.equal(hex(0x12345678), '00000000000000000000000012345678');
  assert.equal(hex(2 ** 53), '00000000000000000020000000000000');
});

test('parseHexIV：补零与非法值', () => {
  assert.equal(Buffer.from(Hls.parseHexIV('0x1')).toString('hex'), '00000000000000000000000000000001');
  assert.equal(Buffer.from(Hls.parseHexIV('0XFFEEDDCCBBAA99887766554433221100')).toString('hex'), 'ffeeddccbbaa99887766554433221100');
  assert.throws(() => Hls.parseHexIV('0xZZ'), /无效的 IV/);
});

// ---- AES 解密 ------------------------------------------------------------------
test('decryptAes128：显式 IV 与序号 IV 均可还原明文（去除 PKCS#7 padding）', async () => {
  const cryptoKey = await Hls.importAesKey(new Uint8Array(KEY));
  const plain = Buffer.from('TS payload 中文 '.repeat(50)); // 非 16 字节整数倍
  const iv1 = Hls.parseHexIV('0x000102030405060708090a0b0c0d0e0f');
  assert.deepEqual(toBuf(await Hls.decryptAes128(encrypt(plain, KEY, iv1), cryptoKey, iv1)), plain);
  const iv2 = Hls.ivForSequence(7);
  assert.deepEqual(toBuf(await Hls.decryptAes128(encrypt(plain, KEY, iv2), cryptoKey, iv2)), plain);
  // 错误 IV：只有第一个块被破坏，因此长度相同但内容不同
  const wrong = await Hls.decryptAes128(encrypt(plain, KEY, iv2), cryptoKey, Hls.ivForSequence(8));
  assert.notDeepEqual(toBuf(wrong), plain);
});

test('importAesKey：key 长度必须为 16 字节', () => {
  assert.throws(() => Hls.importAesKey(new Uint8Array(15)), /16 字节/);
});

// ---- 按序并发 --------------------------------------------------------------------
test('fetchInOrder：乱序完成、按序输出、并发不超过上限', async () => {
  const delays = [30, 5, 20, 1, 15, 2, 25, 3, 10, 0];
  let active = 0;
  let maxActive = 0;
  const out = [];
  await Hls.fetchInOrder(delays.length, {
    concurrency: 3,
    fetchOne: async (i) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, delays[i]));
      active--;
      return i;
    },
    onData: (i, d) => {
      assert.equal(i, d);
      out.push(d);
    },
  });
  assert.deepEqual(out, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(maxActive <= 3, `maxActive=${maxActive}`);
});

test('fetchInOrder：取消', async () => {
  const ctrl = new AbortController();
  const out = [];
  await assert.rejects(
    Hls.fetchInOrder(5, {
      concurrency: 2,
      signal: ctrl.signal,
      fetchOne: async (i) => i,
      onData: (i) => {
        out.push(i);
        if (i === 1) ctrl.abort();
      },
    }),
    (e) => e.name === 'AbortError',
  );
  assert.deepEqual(out, [0, 1]);
});

test('fetchInOrder：请求卡住时取消也能立即结束', async () => {
  const ctrl = new AbortController();
  const never = new Promise(() => {});
  const t0 = Date.now();
  setTimeout(() => ctrl.abort(), 20);
  await assert.rejects(
    Hls.fetchInOrder(3, { concurrency: 2, signal: ctrl.signal, fetchOne: () => never, onData: () => {} }),
    (e) => e.name === 'AbortError',
  );
  assert.ok(Date.now() - t0 < 500);
});

test('fetchInOrder：首分片卡住或写盘卡住时不越过固定窗口预取', async () => {
  const ctrl = new AbortController();
  let releaseFirst, releaseWrite;
  const first = new Promise((r) => { releaseFirst = r; });
  const write = new Promise((r) => { releaseWrite = r; });
  const fetched = [];
  let writing = false;
  const run = Hls.fetchInOrder(10000, {
    concurrency: 4, signal: ctrl.signal,
    fetchOne(i) { fetched.push(i); return i === 0 ? first : i; },
    async onData() { writing = true; await Hls.abortable(write, ctrl.signal); },
  });
  const rejected = assert.rejects(run, { name: 'AbortError' });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(fetched, [0, 1, 2, 3]); assert.equal(writing, false);
  releaseFirst(0); await new Promise((r) => setImmediate(r));
  assert.equal(writing, true); assert.deepEqual(fetched, [0, 1, 2, 3]);
  ctrl.abort(); releaseWrite(); await rejected;
  assert.deepEqual(fetched, [0, 1, 2, 3]);
});

test('fetchInOrder：后续分片先失败，立即结束，不等待卡住的首分片', async () => {
  await assert.rejects(Hls.fetchInOrder(10, {
    concurrency: 3,
    fetchOne(i) { if (i === 0) return new Promise(() => {}); if (i === 1) throw new Error('segment failed'); return i; },
    onData() { assert.fail('首分片未完成不能写入'); },
  }), /segment failed/);
});

test('withRetry：等待重试期间取消立即结束，且不再重试', async () => {
  const ctrl = new AbortController();
  let calls = 0;
  const t0 = Date.now();
  setTimeout(() => ctrl.abort(), 20);
  await assert.rejects(
    Hls.withRetry(
      async () => {
        calls++;
        throw new Error('网络错误');
      },
      { delayMs: 10000, signal: ctrl.signal },
    ),
    (e) => e.name === 'AbortError',
  );
  assert.equal(calls, 1);
  assert.ok(Date.now() - t0 < 500);
});

test('looksLikeTs', () => {
  const ts = new Uint8Array(376);
  ts[0] = 0x47;
  ts[188] = 0x47;
  assert.equal(Hls.looksLikeTs(ts), true);
  assert.equal(Hls.looksLikeTs(new Uint8Array([0x47])), true);
  assert.equal(Hls.looksLikeTs(new Uint8Array(376)), false);
  const broken = ts.slice();
  broken[188] = 0;
  assert.equal(Hls.looksLikeTs(broken), false);
});

// ---- downloadHls 端到端（假网络） ---------------------------------------------------
function makeServer({ segments = 6, mediaSequence = 3, master = false, overrides = {} } = {}) {
  const plains = [];
  const routes = {};
  const counts = {};
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`, `#EXT-X-KEY:METHOD=AES-128,URI="${KEY_URI}"`];
  for (let i = 0; i < segments; i++) {
    const plain = Buffer.from(`<segment ${i}>`.repeat(10 + i));
    plains.push(plain);
    lines.push('#EXTINF:10.0,', `segment_${i}.ts`);
    routes[`https://resourcese.pku.edu.cn/play/abc/segment_${i}.ts`] = arrayBuffer(
      encrypt(plain, KEY, Hls.ivForSequence(mediaSequence + i)),
    );
  }
  lines.push('#EXT-X-ENDLIST');
  routes[KEY_URI] = arrayBuffer(KEY);
  const mediaUrl = 'https://resourcese.pku.edu.cn/play/abc/playlist.m3u8?t=1';
  routes[mediaUrl] = lines.join('\n');
  const entryUrl = master ? 'https://resourcese.pku.edu.cn/play/master.m3u8' : mediaUrl;
  if (master) routes[entryUrl] = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nabc/playlist.m3u8?t=1\n';
  Object.assign(routes, overrides);

  const request = async (url) => {
    counts[url] = (counts[url] || 0) + 1;
    await new Promise((r) => setTimeout(r, Math.random() * 5)); // 乱序返回
    const v = routes[url];
    if (v === undefined) throw new Hls.HttpError(404);
    if (typeof v === 'number') throw new Hls.HttpError(v);
    if (v instanceof Error) throw v;
    return { data: v, finalUrl: url };
  };
  return { request, plains, counts, entryUrl, mediaUrl };
}

test('downloadHls：master → media，解密并按 playlist 顺序合并，key 只请求一次', async () => {
  const srv = makeServer({ master: true });
  const chunks = [];
  const progress = [];
  const r = await Hls.downloadHls({
    playlistUrl: srv.entryUrl,
    request: srv.request,
    write: (d) => chunks.push(toBuf(d)),
    onProgress: (p) => progress.push(p),
    concurrency: 3,
  });
  const totalBytes = Buffer.concat(srv.plains).length;
  assert.deepEqual(r, { segments: 6, duration: 60, bytes: totalBytes, badTs: 6 }); // 测试明文不是 TS
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat(srv.plains));
  assert.equal(srv.counts[KEY_URI], 1);
  assert.deepEqual(progress.map((p) => `${p.done}/${p.total}`), ['0/6', '1/6', '2/6', '3/6', '4/6', '5/6', '6/6']);
  assert.deepEqual(progress.map((p) => p.seconds), [0, 10, 20, 30, 40, 50, 60]);
  assert.equal(progress[6].bytes, totalBytes);
  assert.equal(progress[0].totalSeconds, 60);
});

test('downloadHls：真实 TS 分片 badTs 为 0', async () => {
  const ts = Buffer.alloc(188 * 3);
  for (let k = 0; k < 3; k++) ts[k * 188] = 0x47;
  const seg = 'https://resourcese.pku.edu.cn/play/abc/segment_0.ts';
  const srv = makeServer({ segments: 1, mediaSequence: 0, overrides: { [seg]: arrayBuffer(encrypt(ts, KEY, Hls.ivForSequence(0))) } });
  const r = await Hls.downloadHls({ playlistUrl: srv.entryUrl, request: srv.request, write: () => {} });
  assert.equal(r.badTs, 0);
});

test('downloadHls：下载中取消 → 立即 AbortError，并把 signal 传给 request', async () => {
  const srv = makeServer({ segments: 20 });
  const ctrl = new AbortController();
  const seen = [];
  let started = 0;
  const slow = (url, type, signal) => {
    seen.push(signal);
    if (url.endsWith('.ts') && ++started > 3) return new Promise(() => {}); // 之后的分片永远不返回
    return srv.request(url, type);
  };
  const written = [];
  const t0 = Date.now();
  const run = Hls.downloadHls({
    playlistUrl: srv.entryUrl,
    request: slow,
    write: (d) => written.push(d),
    signal: ctrl.signal,
    onProgress: (p) => {
      if (p.done === 2) setTimeout(() => ctrl.abort(), 10);
    },
  });
  await assert.rejects(run, (e) => e.name === 'AbortError' && e.message === '已取消');
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(written.length >= 2 && written.length < 20);
  assert.ok(seen.every((s) => s === ctrl.signal));
});

test('downloadHls：分片 403 直接失败且不重试', async () => {
  const seg = 'https://resourcese.pku.edu.cn/play/abc/segment_2.ts';
  const srv = makeServer({ overrides: { [seg]: 403 } });
  await assert.rejects(
    Hls.downloadHls({ playlistUrl: srv.entryUrl, request: srv.request, write: () => {}, retryDelayMs: 0 }),
    (e) => e.status === 403 && /第 3 \/ 6 个分片：无权限访问（HTTP 403）/.test(e.message),
  );
  assert.equal(srv.counts[seg], 1);
});

test('downloadHls：key 请求 401 直接失败', async () => {
  const srv = makeServer({ overrides: { [KEY_URI]: 401 } });
  await assert.rejects(
    Hls.downloadHls({ playlistUrl: srv.entryUrl, request: srv.request, write: () => {}, retryDelayMs: 0 }),
    /无权限访问（HTTP 401）/,
  );
});

test('downloadHls：网络错误会重试', async () => {
  const seg = 'https://resourcese.pku.edu.cn/play/abc/segment_1.ts';
  const srv = makeServer();
  const real = srv.request;
  let failures = 2;
  const flaky = (url, type) => (url === seg && failures-- > 0 ? Promise.reject(new Error('网络错误')) : real(url, type));
  const chunks = [];
  await Hls.downloadHls({ playlistUrl: srv.entryUrl, request: flaky, write: (d) => chunks.push(toBuf(d)), retryDelayMs: 0 });
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat(srv.plains));
});

test('downloadHls：key 错误时给出解密失败', async () => {
  const srv = makeServer({ overrides: { [KEY_URI]: arrayBuffer(Buffer.alloc(16, 0xff)) } });
  await assert.rejects(
    Hls.downloadHls({ playlistUrl: srv.entryUrl, request: srv.request, write: () => {}, retryDelayMs: 0 }),
    /解密失败/,
  );
});

// ---- 文件名 ---------------------------------------------------------------------
test('toTsFilename', () => {
  assert.equal(Hls.toTsFilename('L01-2026-09-30-第3-4节.mp4'), 'L01-2026-09-30-第3-4节.ts');
  assert.equal(Hls.toTsFilename('L01-无扩展名'), 'L01-无扩展名.ts');
});
