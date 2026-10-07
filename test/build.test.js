import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { build } from '../build.mjs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('build：产物以 userscript metadata header 开头，版本号来自 package.json', async () => {
  const code = await build({ write: false });
  assert.ok(code.startsWith('// ==UserScript==\n'));
  const header = code.slice(0, code.indexOf('// ==/UserScript==') + '// ==/UserScript=='.length);
  assert.match(header, new RegExp(`^// @version\\s+${pkg.version.replace(/\./g, '\\.')}$`, 'm'));
  const grants = [
    'GM_getValue',
    'GM_setValue',
    'GM_deleteValue',
    'GM_addValueChangeListener',
    'GM_removeValueChangeListener',
    'GM_setClipboard',
    'GM_openInTab',
    'GM_xmlhttpRequest',
  ];
  for (const grant of grants) assert.match(header, new RegExp(`^// @grant\\s+${grant}$`, 'm'));
  assert.equal(header.match(/^\/\/ @grant/gm).length, grants.length, '不多申请 grant');
  assert.match(header, /^\/\/ @connect\s+pku\.edu\.cn$/m);
  assert.deepEqual(header.match(/^\/\/ @match\s+(\S+)$/gm).map((l) => l.split(/\s+/).pop()), [
    '*://*.pku.edu.cn/*videoList.action*',
    '*://*.pku.edu.cn/*playVideo.action*',
    '*://onlineroomse.pku.edu.cn/*',
  ]);
  assert.ok(!code.includes('{{version}}'));
  assert.ok(!code.includes('__CF_VERSION__'));
});

test('build：产物是单个经典脚本（无 import/export），可被解析', async () => {
  const code = await build({ write: false });
  assert.doesNotThrow(() => new vm.Script(code, { filename: 'course-fetch.user.js' }));
  assert.ok(!/^\s*(import|export)\s/m.test(code));
});

test('build：在非课堂实录页面运行时不做任何事', async () => {
  const code = await build({ write: false });
  const logs = [];
  const context = {
    console: { info: (...a) => logs.push(a.join(' ')), warn() {} },
    location: { href: 'https://course.pku.edu.cn/webapps/portal/frameset.jsp' },
    document: {},
    window: {},
  };
  vm.runInNewContext(code, context);
  assert.deepEqual(logs, []);
  assert.equal(context.window.__courseFetchLoaded, undefined);
});
