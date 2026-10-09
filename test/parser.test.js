import test from 'node:test';
import assert from 'node:assert/strict';
import * as parser from '../src/parser.js';
import * as page from '../src/page.js';
import { h, doc as mkDoc } from './mini-dom.js';

const P = { ...parser, ...page };

const ROW = '2026-09-30第3-4节 时间: 2026-09-30 10:10:00 教师: 陈向群 操作: 观看';

test('parseRowText: 标准行', () => {
  const r = P.parseRowText(ROW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.entry, {
    date: '2026-09-30',
    periodStart: 3,
    periodEnd: 4,
    startTime: '2026-09-30 10:10:00',
    teacher: '陈向群',
  });
});

test('parseRowText: 单元格之间无空格、全角冒号、nbsp', () => {
  const r = P.parseRowText('2026-09-30 第 3 - 4 节时间：2026-09-30 10:10教师：陈向群操作：观看');
  assert.equal(r.ok, true);
  assert.equal(r.entry.periodStart, 3);
  assert.equal(r.entry.periodEnd, 4);
  assert.equal(r.entry.startTime, '2026-09-30 10:10:00');
  assert.equal(r.entry.teacher, '陈向群');
});

test('parseRowText: 单节、个位数月日、缺少教师和时间', () => {
  const r = P.parseRowText('2026-9-1第5节 操作: 观看');
  assert.equal(r.ok, true);
  assert.deepEqual(r.entry, { date: '2026-09-01', periodStart: 5, periodEnd: 5, startTime: null, teacher: '' });
});

test('parseRowText: 多位教师', () => {
  const r = P.parseRowText('2026-09-30第1-2节 时间: 2026-09-30 08:00:00 教师: 张三,李四 操作: 观看');
  assert.equal(r.entry.teacher, '张三,李四');
});

test('parseRowText: 无法解析时返回错误', () => {
  const r = P.parseRowText('暂无录像 观看');
  assert.equal(r.ok, false);
  assert.match(r.error, /日期/);
  assert.equal(P.parseRowText('2026-09-30第4-3节').ok, false);
});

test('parseRows: 区分成功与失败并保留页码', () => {
  const { entries, failures } = P.parseRows([
    { text: ROW, watchUrl: 'https://x/watch?token=1', page: 1 },
    { text: 'garbage', page: 2 },
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].watchUrl, 'https://x/watch?token=1');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].page, 2);
});

test('dedupeAndSort: 去重、按 startTime 升序、index 从 1 开始', () => {
  const mk = (date, ps, pe, time) => ({ date, periodStart: ps, periodEnd: pe, startTime: time, teacher: 'T' });
  const input = [
    mk('2026-09-30', 3, 4, '2026-09-30 10:10:00'),
    mk('2026-09-23', 3, 4, '2026-09-23 10:10:00'),
    mk('2026-09-30', 3, 4, '2026-09-30 10:10:00'), // 重复
    mk('2026-09-23', 1, 2, '2026-09-23 08:00:00'),
    mk('2026-09-23', 7, 8, null), // 无时间，排在当天最后
  ];
  const { entries, duplicates } = P.dedupeAndSort(input);
  assert.equal(duplicates.length, 1);
  assert.deepEqual(
    entries.map((e) => [e.index, e.date, e.periodStart]),
    [
      [1, '2026-09-23', 1],
      [2, '2026-09-23', 3],
      [3, '2026-09-23', 7],
      [4, '2026-09-30', 3],
    ],
  );
});

test('applyExclusions: 排除项不占号，序号连续，origIndex 保留原序号', () => {
  const mk = (date, ps, pe, time) => ({ date, periodStart: ps, periodEnd: pe, startTime: time, teacher: 'T' });
  const { entries } = P.dedupeAndSort([
    mk('2026-09-30', 3, 4, '2026-09-30 10:10:00'),
    mk('2026-09-23', 3, 4, '2026-09-23 10:10:00'),
    mk('2026-09-23', 1, 2, '2026-09-23 08:00:00'),
  ]);
  const holiday = P.entryKey(entries[1]); // 中间那条是放假空回放
  const out = P.applyExclusions(entries, new Set([holiday]));
  assert.deepEqual(out.map((e) => [e.index, e.excluded, e.origIndex]), [
    [1, false, 1],
    [null, true, 2],
    [2, false, 3],
  ]);
  // 空集合等价于原样编号
  assert.deepEqual(P.applyExclusions(entries).map((e) => e.index), [1, 2, 3]);
  // 重复调用（排除集合变化）不能把 origIndex 改成重排后的序号
  const again = P.applyExclusions(P.applyExclusions(entries, new Set([holiday])), new Set([holiday, P.entryKey(entries[2])]));
  assert.deepEqual(again.map((e) => e.origIndex), [1, 2, 3]);
  assert.deepEqual(again.map((e) => e.index), [1, null, null]);
});

test('parseDateRanges: 单日期、区间、多种分隔符、非法输入', () => {
  assert.deepEqual(P.parseDateRanges('2026-10-01'), { ranges: [{ from: '2026-10-01', to: '2026-10-01' }], invalid: [] });
  assert.deepEqual(P.parseDateRanges('2026-10-05~2026-10-07'), { ranges: [{ from: '2026-10-05', to: '2026-10-07' }], invalid: [] });
  assert.deepEqual(P.parseDateRanges('2026-10-05 至 2026-10-07').ranges[0], { from: '2026-10-05', to: '2026-10-07' });
  assert.deepEqual(P.parseDateRanges('2026/10/05..2026/10/07').ranges[0], { from: '2026-10-05', to: '2026-10-07' });
  assert.deepEqual(P.parseDateRanges('2026.9.5').ranges[0], { from: '2026-09-05', to: '2026-09-05' }); // 个位数补零
  const multi = P.parseDateRanges('2026-10-01，2026-10-05~2026-10-07\n2026-11-02');
  assert.equal(multi.ranges.length, 3);
  assert.deepEqual(multi.invalid, []);
  // 非法 token 与起止颠倒
  const bad = P.parseDateRanges('放假 2026-10-07~2026-10-01');
  assert.deepEqual(bad.ranges, []);
  assert.deepEqual(bad.invalid, ['放假', '2026-10-07~2026-10-01']);
  assert.deepEqual(P.parseDateRanges(''), { ranges: [], invalid: [] });
});

test('matchesDateRanges: 含端点，区间外为假', () => {
  const { ranges } = P.parseDateRanges('2026-10-01~2026-10-07, 2026-11-02');
  assert.equal(P.matchesDateRanges('2026-10-01', ranges), true);
  assert.equal(P.matchesDateRanges('2026-10-04', ranges), true);
  assert.equal(P.matchesDateRanges('2026-10-07', ranges), true);
  assert.equal(P.matchesDateRanges('2026-09-30', ranges), false);
  assert.equal(P.matchesDateRanges('2026-10-08', ranges), false);
  assert.equal(P.matchesDateRanges('2026-11-02', ranges), true);
  assert.equal(P.matchesDateRanges('', ranges), false);
});

test('holidayRanges / collectExclusions: 全局标签与手动排除合并，停用的标签不生效', () => {
  const holidays = [
    { name: '中秋节', ranges: [{ from: '2026-09-25', to: '2026-09-27' }], enabled: true },
    { name: '国庆节', ranges: [{ from: '2026-10-01', to: '2026-10-07' }], enabled: false },
  ];
  assert.deepEqual(P.holidayRanges(holidays), [{ from: '2026-09-25', to: '2026-09-27', name: '中秋节' }]);
  assert.deepEqual(P.holidayRanges(), []);

  const entries = [
    { date: '2026-09-20', periodStart: 3, periodEnd: 4, startTime: '2026-09-20 10:10:00' },
    { date: '2026-09-26', periodStart: 3, periodEnd: 4, startTime: '2026-09-26 10:10:00' },
    { date: '2026-10-01', periodStart: 3, periodEnd: 4, startTime: '2026-10-01 10:10:00' },
  ];
  const map = P.collectExclusions(entries, new Set([P.entryKey(entries[0])]), P.holidayRanges(holidays));
  assert.equal(map.size, 2); // 手动排除 1 条 + 中秋节命中 1 条
  assert.equal(map.get(P.entryKey(entries[0])), ''); // 手动排除没有标签名
  assert.equal(map.get(P.entryKey(entries[1])), '中秋节');
  assert.equal(map.has(P.entryKey(entries[2])), false); // 国庆节已停用

  assert.deepEqual(P.applyExclusions(entries, new Set(map.keys())).map((e) => e.index), [null, null, 1]);
});

test('formatFilename: 默认模板', () => {
  const e = { index: 3, date: '2026-09-30', periodStart: 3, periodEnd: 4, startTime: '2026-09-30 10:10:00', teacher: '陈向群' };
  assert.equal(P.formatFilename(P.DEFAULT_TEMPLATE, e), 'L03-2026-09-30-第3-4节.mp4');
});

test('formatFilename: 自定义模板、补零、未知变量、非法字符', () => {
  const e = { index: 7, date: '2026-09-30', periodStart: 3, periodEnd: 4, startTime: '2026-09-30 10:10:00', teacher: '陈向群' };
  assert.equal(
    P.formatFilename('{course}/{index:03d}_{time}_{teacher}{unknown}.mp4', e, { course: '操作系统' }),
    '操作系统_007_1010_陈向群{unknown}.mp4',
  );
  assert.equal(P.formatFilename('{startTime}.mp4', e), '2026-09-30 10_10_00.mp4');
  assert.equal(P.formatFilename('', e), 'L07-2026-09-30-第3-4节.mp4');
});

test('formatFilename: 日期拆分变量 {YYYY} {YY} {MM} {DD}', () => {
  const e = { index: 3, date: '2026-09-15', periodStart: 3, periodEnd: 4, startTime: '', teacher: '' };
  assert.equal(P.formatFilename('{YYYY}{MM}{DD}.mp4', e), '20260915.mp4');
  assert.equal(P.formatFilename('{YY}{MM}{DD}.mp4', e), '260915.mp4');
  assert.equal(P.formatFilename('{MM}{DD}.mp4', e), '0915.mp4');
  assert.equal(P.formatFilename('L{index:02d}-{YY}{MM}{DD}.mp4', e), 'L03-260915.mp4');
  // 没有日期时拆分变量为空，不抛错
  assert.equal(P.formatFilename('{YYYY}{MM}{DD}.mp4', { index: 1, date: '' }), '.mp4');
});

test('parseCourseId', () => {
  assert.equal(P.parseCourseId('https://course.pku.edu.cn/webapps/x/videoList.action?course_id=_12345_1&foo=1'), '_12345_1');
  assert.equal(P.parseCourseId('https://course.pku.edu.cn/'), '');
});

test('buildManifest: 不包含 watchUrl / token', () => {
  const { entries } = P.dedupeAndSort(
    P.parseRows([{ text: ROW, watchUrl: 'https://x/watch?token=SECRET', page: 1 }]).entries,
  );
  const m = P.buildManifest({ course: '操作系统', courseId: '_1_1', entries, generatedAt: 'T' });
  assert.equal(m.count, 1);
  assert.deepEqual(m.lectures[0], {
    index: 1,
    date: '2026-09-30',
    periodStart: 3,
    periodEnd: 4,
    startTime: '2026-09-30 10:10:00',
    teacher: '陈向群',
    filename: 'L01-2026-09-30-第3-4节.mp4',
  });
  const json = JSON.stringify(m);
  assert.ok(!json.includes('SECRET'));
  assert.ok(!json.includes('watchUrl'));
});

test('buildListText: 不包含 URL', () => {
  const entries = [{ index: 1, date: '2026-09-30', periodStart: 3, periodEnd: 4, startTime: '2026-09-30 10:10:00', teacher: '陈向群', watchUrl: 'https://x?token=SECRET' }];
  const text = P.buildListText({ course: '操作系统', template: P.DEFAULT_TEMPLATE, entries });
  assert.equal(text, '# 操作系统（1 条）\nL01-2026-09-30-第3-4节.mp4\t2026-09-30 10:10:00\t陈向群');
});

test('resolveUrl', () => {
  const base = 'https://course.pku.edu.cn/webapps/v/videoList.action?course_id=1';
  assert.equal(P.resolveUrl('play.action?id=2', base), 'https://course.pku.edu.cn/webapps/v/play.action?id=2');
  assert.equal(P.resolveUrl('javascript:void(0)', base), null);
  assert.equal(P.resolveUrl('#', base), null);
  assert.equal(P.resolveUrl(null, base), null);
});

// ---- extractPage：用最小的假 DOM 对象 -------------------------------------------
function fakeAnchor(text, attrs, tr) {
  return {
    textContent: text,
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    closest: (sel) => (sel === 'tr' ? tr : null),
  };
}
function fakeRow(cellTexts) {
  return { cells: cellTexts.map((t) => ({ textContent: t })) };
}

test('extractPage: 收集观看行与前进链接', () => {
  const base = 'https://course.pku.edu.cn/webapps/v/videoList.action?course_id=1';
  const r1 = fakeRow(['2026-09-30第3-4节', '时间: 2026-09-30 10:10:00', '教师: 陈向群', '操作: 观看']);
  const r2 = fakeRow(['2026-09-23第3-4节', '时间: 2026-09-23 10:10:00', '教师: 陈向群', '操作: 观看']);
  const doc = {
    querySelectorAll: () => [
      fakeAnchor(' 观看 ', { href: 'play.action?id=1&token=a' }, r1),
      fakeAnchor('观看', { href: '#', onclick: "openVideo('play.action?id=2&token=b')" }, r2),
      fakeAnchor('观看', { href: 'x' }, null), // 不在行内
      fakeAnchor('前进', { href: 'videoList.action?course_id=1&page=2' }, null),
      fakeAnchor('其它', { href: 'y' }, null),
    ],
  };
  const page = P.extractPage(doc, base);
  assert.equal(page.rows.length, 2);
  assert.equal(page.rows[0].text, '2026-09-30第3-4节 时间: 2026-09-30 10:10:00 教师: 陈向群 操作: 观看');
  assert.equal(page.rows[0].watchUrl, 'https://course.pku.edu.cn/webapps/v/play.action?id=1&token=a');
  assert.equal(page.rows[1].watchUrl, 'https://course.pku.edu.cn/webapps/v/play.action?id=2&token=b');
  assert.equal(page.issues.length, 1);
  assert.equal(page.next.url, 'https://course.pku.edu.cn/webapps/v/videoList.action?course_id=1&page=2');
});

test('extractPage: 最后一页（前进无 href / 无前进）', () => {
  const noHref = { querySelectorAll: () => [fakeAnchor('前进', {}, null)] };
  const p1 = P.extractPage(noHref, 'https://a.pku.edu.cn/');
  assert.equal(p1.next.url, null);
  assert.equal(p1.next.hasHref, false);
  const none = { querySelectorAll: () => [] };
  assert.equal(P.extractPage(none, 'https://a.pku.edu.cn/').next, null);
});

// ---- 教学网真实 DOM 结构（v0.1.1 回归） -----------------------------------------

function realRow(i, title, time, teacher, href) {
  const cell = (label, ...value) =>
    h('td', { class: '', valign: 'top' },
      '\n        ', h('span', { class: 'mobile-table-label' }, label), '\n        ',
      h('span', { class: 'table-data-cell-value' }, ...value), '\n    ');
  return h('tr', { id: `listContainer_row:${i}`, class: '' },
    '\n    ', h('th', { scope: 'row', class: '', valign: 'top' }, `\n        ${title}\n    `),
    cell('时间: ', `\n            ${time}\n        `),
    cell('教师: ', `\n            ${teacher}\n        `),
    cell('操作: ', '\n            ',
      h('a', { class: 'inlineAction', target: '_blank', href }, '\n                观看\n            '),
      '\n        '),
  );
}

function realPage() {
  return mkDoc(h('table', {}, h('tbody', {},
    realRow(0, '2026-09-30第3-4节', '2026-09-30 10:10:00', '陈向群', 'playVideo.action?token=AAA'),
    realRow(1, '2026-09-23第3-4节', '2026-09-23 10:10:00', '陈向群', 'playVideo.action?token=BBB'),
  )), h('a', { href: 'videoList.action?course_id=_1_1&page=2' }, '前进'));
}

const BASE = 'https://course.pku.edu.cn/webapps/bb-streammedia-hqy-BBLEARN/videoList.action?course_id=_1_1';

test('真实 DOM：分列提取 th / table-data-cell-value / 观看链接', () => {
  const page = P.extractPage(realPage(), BASE);
  assert.equal(page.rows.length, 2);
  assert.deepEqual(page.rows[0].cols, { title: '2026-09-30第3-4节', startTime: '2026-09-30 10:10:00', teacher: '陈向群' });
  assert.equal(page.rows[0].watchUrl, 'https://course.pku.edu.cn/webapps/bb-streammedia-hqy-BBLEARN/playVideo.action?token=AAA');
  assert.ok(page.next.url.endsWith('videoList.action?course_id=_1_1&page=2'));
});

test('真实 DOM：完整解析 → 排序 → 文件名', () => {
  const page = P.extractPage(realPage(), BASE);
  const { entries, failures } = P.parseRows(page.rows.map((r) => ({ ...r, page: 1 })));
  assert.equal(failures.length, 0);
  const sorted = P.dedupeAndSort(entries).entries;
  assert.deepEqual(
    sorted.map((e) => [e.index, e.date, e.periodStart, e.periodEnd, e.startTime, e.teacher, P.formatFilename(P.DEFAULT_TEMPLATE, e)]),
    [
      [1, '2026-09-23', 3, 4, '2026-09-23 10:10:00', '陈向群', 'L01-2026-09-23-第3-4节.mp4'],
      [2, '2026-09-30', 3, 4, '2026-09-30 10:10:00', '陈向群', 'L02-2026-09-30-第3-4节.mp4'],
    ],
  );
});

test('真实 DOM：页面用 Prototype.js 覆盖 Array.from（忽略 mapFn）时仍能解析', () => {
  const original = Array.from;
  Array.from = function $A(iterable) {
    // Prototype.js 的 $A：只接受一个参数
    return Array.prototype.slice.call(iterable);
  };
  try {
    const page = P.extractPage(realPage(), BASE);
    const { entries, failures } = P.parseRows(page.rows);
    assert.equal(failures.length, 0);
    assert.equal(entries.length, 2);
    // fallback 路径同样不能把 Element 转成 "[object ...]"
    const tr = h('tr', {}, h('td', {}, '2026-09-30第3-4节'), h('td', {}, '时间: 2026-09-30 10:10:00'), h('td', {}, h('a', {}, '观看')));
    const fb = P.extractPage(mkDoc(h('table', {}, tr)), BASE);
    assert.equal(fb.rows[0].text, '2026-09-30第3-4节 时间: 2026-09-30 10:10:00 观看');
    assert.ok(!fb.rows[0].text.includes('[object'));
  } finally {
    Array.from = original;
  }
});

test('parseStructuredRow：日期/节次只从名称解析', () => {
  const ok = P.parseStructuredRow({ title: '2026-09-30第3-4节', startTime: '2026-09-30 10:10:00', teacher: ' 陈向群 ' });
  assert.equal(ok.ok, true);
  assert.equal(ok.entry.teacher, '陈向群');
  const bad = P.parseStructuredRow({ title: '期中复习', startTime: '2026-09-30第3-4节 2026-09-30 10:10:00', teacher: '陈向群' });
  assert.equal(bad.ok, false);
  assert.equal(bad.text, '期中复习 | 2026-09-30第3-4节 2026-09-30 10:10:00 | 陈向群');
  const noTime = P.parseStructuredRow({ title: '2026-09-30第3-4节', startTime: '', teacher: '' });
  assert.equal(noTime.entry.startTime, null);
});

test('非标准结构的行回退到通用文本解析', () => {
  const tr = h('tr', {}, h('td', {}, '2026-10-07第1-2节'), h('td', {}, '时间: 2026-10-07 08:00:00'), h('td', {}, '教师: 张三'), h('td', {}, h('a', { href: 'p.action?id=9' }, '观看')));
  const page = P.extractPage(mkDoc(h('table', {}, tr)), BASE);
  assert.equal(page.rows[0].cols, undefined);
  const { entries } = P.parseRows(page.rows);
  assert.deepEqual(
    [entries[0].date, entries[0].periodStart, entries[0].startTime, entries[0].teacher],
    ['2026-10-07', 1, '2026-10-07 08:00:00', '张三'],
  );
});

// ---- crawlCourse 分页（v0.1.2） ------------------------------------------------
function lectureRows(dates) {
  return dates.map((d, i) => realRow(i, `${d}第3-4节`, `${d} 10:10:00`, '陈向群', `playVideo.action?token=${d}`));
}
function listPage(dates, nextHref) {
  const kids = [h('table', {}, h('tbody', {}, ...lectureRows(dates)))];
  if (nextHref !== undefined) kids.push(h('a', nextHref === null ? {} : { href: nextHref }, '前进'));
  return mkDoc(...kids);
}
const EIGHT = ['2026-09-09', '2026-09-11', '2026-09-16', '2026-09-18', '2026-09-23', '2026-09-25', '2026-09-30', '2026-10-02'];
const url = (q) => `${BASE}${q}`;

function fakeFetch(pages) {
  const calls = [];
  const fn = async (u) => {
    calls.push(u);
    if (!(u in pages)) throw new Error('HTTP 500');
    return pages[u];
  };
  return { fn, calls };
}

test('crawlCourse：只有一页，末页“前进”返回相同 8 条 → 共 1 页，8 条录像，无警告', async () => {
  const next = url('&page=2');
  const f = fakeFetch({ [next]: listPage(EIGHT.slice().reverse(), next) });
  const r = await P.crawlCourse({ firstDoc: listPage(EIGHT.slice().reverse(), next), firstUrl: BASE, fetchDoc: f.fn });
  assert.equal(r.status, '共 1 页，8 条录像');
  assert.equal(r.pages, 1);
  assert.equal(r.entries.length, 8);
  assert.equal(r.duplicates.length, 0);
  assert.deepEqual(r.warnings, []);
  assert.equal(f.calls.length, 1);
  assert.equal(r.entries[0].date, '2026-09-09');
});

test('crawlCourse：两页，第 2 页的“前进”返回同一页 → 共 2 页', async () => {
  const p2 = url('&page=2');
  const p3 = url('&page=3');
  const f = fakeFetch({ [p2]: listPage(EIGHT.slice(0, 4), p3), [p3]: listPage(EIGHT.slice(0, 4), p3) });
  const r = await P.crawlCourse({ firstDoc: listPage(EIGHT.slice(4), p2), firstUrl: BASE, fetchDoc: f.fn });
  assert.equal(r.status, '共 2 页，8 条录像');
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.entries.map((e) => e.index), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('crawlCourse：最后一页的“前进”没有 href → 正常结束，不请求', async () => {
  const f = fakeFetch({});
  const r = await P.crawlCourse({ firstDoc: listPage(EIGHT, null), firstUrl: BASE, fetchDoc: f.fn });
  assert.equal(r.status, '共 1 页，8 条录像');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(r.warnings, []);
});

test('crawlCourse：真正的 URL 循环仍被 visited 拦截', async () => {
  const p2 = url('&page=2');
  // 第 2 页有新录像，但“前进”指回第 1 页
  const f = fakeFetch({ [p2]: listPage(EIGHT.slice(0, 4), BASE) });
  const r = await P.crawlCourse({ firstDoc: listPage(EIGHT.slice(4), p2), firstUrl: BASE, fetchDoc: f.fn });
  assert.equal(r.pages, 2);
  assert.equal(r.entries.length, 8);
  assert.deepEqual(r.warnings, ['“前进”链接指向已读取过的页面，停止翻页']);
});

test('crawlCourse：分页请求失败时保留已有结果', async () => {
  const f = fakeFetch({});
  const r = await P.crawlCourse({ firstDoc: listPage(EIGHT.slice(4), url('&page=2')), firstUrl: BASE, fetchDoc: f.fn });
  assert.equal(r.status, '共 1 页，4 条录像');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /读取第 2 页失败（HTTP 500）/);
});

test('crawlCourse：同一页内的重复录像仍会提示', async () => {
  const r = await P.crawlCourse({ firstDoc: listPage([...EIGHT, EIGHT[0]]), firstUrl: BASE, fetchDoc: async () => null });
  assert.equal(r.entries.length, 8);
  assert.deepEqual(r.warnings, ['发现 1 条重复录像，已合并']);
});
