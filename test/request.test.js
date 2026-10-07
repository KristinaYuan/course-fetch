import test from 'node:test';
import assert from 'node:assert/strict';
import { gmRequest, describeResource, downloadHls, HttpError } from '../src/downloader.js';

// 用假的 GM_xmlhttpRequest 和 console.warn 测试 gmRequest 的错误诊断
function withGM(handler, fn) {
  const warns = [];
  const origWarn = console.warn;
  globalThis.GM_xmlhttpRequest = (opts) => {
    setTimeout(() => handler(opts), 0);
    return { abort() {} };
  };
  console.warn = (...args) => warns.push(args);
  return Promise.resolve()
    .then(() => fn(warns))
    .finally(() => {
      delete globalThis.GM_xmlhttpRequest;
      console.warn = origWarn;
    });
}

const KEY_URL = 'https://resourcese.pku.edu.cn/taskflow/harpocrates/rose/key1';

test('describeResource', () => {
  assert.equal(describeResource({ kind: 'playVideo' }), 'playVideo 页面');
  assert.equal(describeResource({ kind: 'm3u8' }), 'm3u8 播放列表');
  assert.equal(describeResource({ kind: 'key' }), 'AES key');
  assert.equal(describeResource({ kind: 'segment', index: 3, total: 150 }), 'TS 分片 3/150');
  assert.equal(describeResource(undefined), '资源');
});

test('gmRequest onerror：错误信息指出资源和域名，Console 记录 URL、hostname、类型和完整错误对象', () =>
  withGM(
    (o) => o.onerror({ error: 'Refused to connect: URL is not permitted', status: 0, readyState: 4, finalUrl: o.url }),
    async (warns) => {
      await assert.rejects(gmRequest(KEY_URL, 'arraybuffer', undefined, { kind: 'key' }), (e) => {
        assert.equal(
          e.message,
          '请求 AES key 失败（resourcese.pku.edu.cn）：网络错误（Tampermonkey: Refused to connect: URL is not permitted）；如果 Tampermonkey 拦截了跨域请求，请允许该域名',
        );
        assert.equal(e.resource.name, 'AES key');
        assert.equal(e.resource.hostname, 'resourcese.pku.edu.cn');
        return true;
      });
      assert.equal(warns.length, 1);
      const [line, info] = warns[0];
      assert.equal(line, `[Course Fetch] request failed: ${KEY_URL}`);
      assert.equal(info.resource, 'AES key');
      assert.equal(info.hostname, 'resourcese.pku.edu.cn');
      assert.equal(info.type, 'arraybuffer');
      assert.equal(info.via, 'GM_xmlhttpRequest');
      assert.deepEqual(info.detail, { error: 'Refused to connect: URL is not permitted', status: 0, readyState: 4, finalUrl: KEY_URL });
    },
  ));

test('gmRequest onerror：非 pku.edu.cn 域名时提示添加 @connect', () =>
  withGM(
    (o) => o.onerror({}),
    async () => {
      await assert.rejects(
        gmRequest('https://cdn.example.com/a/segment_2.ts', 'arraybuffer', undefined, { kind: 'segment', index: 3, total: 150 }),
        /^Error: 请求 TS 分片 3\/150 失败（cdn\.example\.com）：网络错误（Tampermonkey 未返回详细原因）；cdn\.example\.com 不在 @connect 列表中.*\/\/ @connect cdn\.example\.com$/,
      );
    },
  ));

test('gmRequest：HTTP 403 仍是 HttpError（status 不变，不重试），信息指出资源', () =>
  withGM(
    (o) => o.onload({ status: 403, statusText: 'Forbidden', finalUrl: o.url, response: 'SECRET-BODY' }),
    async (warns) => {
      await assert.rejects(
        gmRequest('https://course.pku.edu.cn/webapps/v/playVideo.action?token=x', 'text', undefined, { kind: 'playVideo' }),
        (e) =>
          e instanceof HttpError &&
          e.status === 403 &&
          e.message === '请求 playVideo 页面失败（course.pku.edu.cn）：无权限访问（HTTP 403），请确认已登录且能在教学网正常播放该录像',
      );
      assert.equal(warns[0][1].status, 403);
      assert.ok(!JSON.stringify(warns[0][1]).includes('SECRET-BODY'), '不记录响应内容');
    },
  ));

test('gmRequest：超时', () =>
  withGM(
    (o) => o.ontimeout({}),
    async () => {
      await assert.rejects(gmRequest('https://resourcese.pku.edu.cn/p/playlist.m3u8', 'text', undefined, { kind: 'm3u8' }), /^Error: 请求 m3u8 播放列表失败（resourcese\.pku\.edu\.cn）：请求超时/);
    },
  ));

test('gmRequest：成功时不输出诊断', () =>
  withGM(
    (o) => o.onload({ status: 200, responseText: '#EXTM3U', finalUrl: o.url }),
    async (warns) => {
      const r = await gmRequest('https://resourcese.pku.edu.cn/p/playlist.m3u8', 'text', undefined, { kind: 'm3u8' });
      assert.equal(r.data, '#EXTM3U');
      assert.equal(warns.length, 0);
    },
  ));

test('downloadHls：向 request 传入资源类型', async () => {
  const kinds = [];
  const routes = {
    'https://r.pku.edu.cn/a/playlist.m3u8': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv/index.m3u8\n',
    'https://r.pku.edu.cn/a/v/index.m3u8': '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:1,\ns0.ts\n#EXTINF:1,\ns1.ts\n',
  };
  const request = async (url, type, signal, resource) => {
    kinds.push(resource && resource.kind === 'segment' ? `segment ${resource.index}/${resource.total}` : resource.kind);
    if (url in routes) return { data: routes[url], finalUrl: url };
    if (url.endsWith('/k')) throw Object.assign(new Error('请求 AES key 失败（r.pku.edu.cn）：网络错误'), { resource });
    return { data: new ArrayBuffer(16), finalUrl: url };
  };
  await assert.rejects(
    downloadHls({ playlistUrl: 'https://r.pku.edu.cn/a/playlist.m3u8', request, write: () => {}, retryDelayMs: 0, concurrency: 1 }),
    // 已带资源说明的错误不再被加上“第 N / M 个分片：”前缀
    (e) => e.message === '请求 AES key 失败（r.pku.edu.cn）：网络错误',
  );
  assert.deepEqual(kinds.slice(0, 4), ['m3u8', 'm3u8-variant', 'segment 1/2', 'key']);
});
