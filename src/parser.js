// metadata 解析：日期节次、排序去重、文件名、manifest。纯函数，不依赖浏览器 API。

export const DEFAULT_TEMPLATE = 'L{index:02d}-{date}-第{periodStart}-{periodEnd}节.mp4';

// 2026-09-30第3-4节 / 2026-09-30 第3节
const DATE_PERIOD_RE =
  /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\s*第\s*(\d{1,2})\s*(?:[-－–—~～至到]\s*(\d{1,2}))?\s*节/;
// 2026-09-30 10:10:00；通用文本中要求前缀“时间:”
const DATETIME_RE = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/;
const TIME_RE = new RegExp('时间\\s*[:：]\\s*' + DATETIME_RE.source);
// 教师: 陈向群 操作: 观看 / 预览
const TEACHER_RE = /教师\s*[:：]\s*(.*?)\s*(?:操作\s*[:：]|观看|预览|$)/;
// 2026-10-01 或 2026-10-01~2026-10-07（区间符已由 parseDateRanges 归一化为 ~）
const DATE_RANGE_RE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:~(\d{4})[-/.](\d{1,2})[-/.](\d{1,2}))?$/;

const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

export function normalizeText(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/** 解析“2026-09-30第3-4节”这类名称。返回 { ok, date, periodStart, periodEnd } 或 { ok: false, error }。 */
export function parseTitle(title) {
  const m = DATE_PERIOD_RE.exec(normalizeText(title));
  if (!m) return { ok: false, error: '无法解析日期/节次' };
  const periodStart = Number(m[4]);
  const periodEnd = m[5] ? Number(m[5]) : periodStart;
  if (periodEnd < periodStart) return { ok: false, error: '节次范围异常' };
  return { ok: true, date: ymd(m[1], m[2], m[3]), periodStart, periodEnd };
}

function formatDateTime(m) {
  return m ? `${ymd(m[1], m[2], m[3])} ${pad2(m[4])}:${m[5]}:${m[6] || '00'}` : null;
}

/** 分列解析：{ title, startTime, teacher } 均为字符串。日期/节次只从 title 解析。 */
export function parseStructuredRow({ title, startTime, teacher }) {
  const text = [title, startTime, teacher].map(normalizeText).join(' | ');
  const p = parseTitle(title);
  if (!p.ok) return { ok: false, error: p.error, text };
  return {
    ok: true,
    entry: {
      date: p.date,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      startTime: formatDateTime(DATETIME_RE.exec(normalizeText(startTime))),
      teacher: normalizeText(teacher),
    },
  };
}

/** 通用 fallback：解析整行文本。返回 { ok: true, entry } 或 { ok: false, error, text }。 */
export function parseRowText(raw) {
  const text = normalizeText(raw);
  const p = parseTitle(text);
  if (!p.ok) return { ok: false, error: p.error, text };
  const tm = TEACHER_RE.exec(text);
  return {
    ok: true,
    entry: {
      date: p.date,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      startTime: formatDateTime(TIME_RE.exec(text)),
      teacher: tm ? tm[1].trim() : '',
    },
  };
}

/** rows: [{ cols?: { title, startTime, teacher }, text?, watchUrl, page }] -> { entries, failures } */
export function parseRows(rows) {
  const entries = [];
  const failures = [];
  for (const row of rows) {
    const r = row.cols ? parseStructuredRow(row.cols) : parseRowText(row.text);
    if (r.ok) entries.push({ ...r.entry, watchUrl: row.watchUrl || null, page: row.page });
    else failures.push({ error: r.error, text: r.text, page: row.page });
  }
  return { entries, failures };
}

export function entryKey(e) {
  return `${e.date}|${e.periodStart}-${e.periodEnd}|${e.startTime || ''}`;
}

function compareEntries(a, b) {
  // 没有 startTime 的排在当天最后（'~' 大于数字）
  const ka = a.startTime || `${a.date} ~`;
  const kb = b.startTime || `${b.date} ~`;
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.periodStart - b.periodStart;
}

/** 去重（保留首次出现）、按 startTime 升序、重新编号 index（从 1 开始）。 */
export function dedupeAndSort(entries) {
  const seen = new Map();
  const duplicates = [];
  for (const e of entries) {
    const k = entryKey(e);
    if (seen.has(k)) duplicates.push(e);
    else seen.set(k, e);
  }
  const sorted = [...seen.values()].sort(compareEntries).map((e, i) => ({ ...e, index: i + 1 }));
  return { entries: sorted, duplicates };
}

const EMPTY_SET = new Set();

/**
 * 标记被排除的条目并重算序号：排除项 excluded=true、index=null（保留原序号在 origIndex），
 * 其余从 1 连续编号。用于「放假等空回放不占号」。
 */
export function applyExclusions(entries, excludedKeys = EMPTY_SET) {
  let n = 0;
  return entries.map((e) => {
    const excluded = excludedKeys.has(entryKey(e));
    // origIndex 只在首次标注时记录：重复调用（排除集合变化）不能把它改成重排后的序号
    return { ...e, excluded, origIndex: e.origIndex ?? e.index, index: excluded ? null : ++n };
  });
}

/** 解析「2026-10-01, 2026-10-05~2026-10-07」这类输入。返回 { ranges, invalid }。 */
export function parseDateRanges(text) {
  const ranges = [];
  const invalid = [];
  // 先把区间符统一成 ~（含两侧空白），否则「2026-10-05 至 2026-10-07」会被空白拆成三个 token
  const normalized = String(text == null ? '' : text).replace(/\s*(?:~|～|至|到|\.\.)\s*/g, '~');
  for (const token of normalized.split(/[,，、;；\s]+/).filter(Boolean)) {
    const m = DATE_RANGE_RE.exec(token);
    if (!m) {
      invalid.push(token);
      continue;
    }
    const from = ymd(m[1], m[2], m[3]);
    const to = m[4] ? ymd(m[4], m[5], m[6]) : from;
    if (to < from) {
      invalid.push(token);
      continue;
    }
    ranges.push({ from, to });
  }
  return { ranges, invalid };
}

/** ISO 日期可字典序比较，直接判断是否落在该区间内（含端点）。 */
export function inRange(date, range) {
  return date >= range.from && date <= range.to;
}

/** 是否落在任一区间内（含端点）。 */
export function matchesDateRanges(date, ranges) {
  return ranges.some((r) => inRange(date, r));
}

/**
 * 展开启用的节假日标签：holidays = [{ name, ranges, enabled }] → [{ from, to, name }]。
 * 停用（enabled === false）的标签不展开。
 */
export function holidayRanges(holidays = []) {
  const out = [];
  for (const h of holidays) {
    if (!h || h.enabled === false) continue;
    for (const r of h.ranges || []) out.push({ from: r.from, to: r.to, name: h.name });
  }
  return out;
}

/**
 * 计算排除项：手动排除 ∪ 命中节假日标签的条目。
 * 返回 Map<entryKey, 标签名>（手动排除的标签名为 ''），键集就是排除集合。
 */
export function collectExclusions(entries, manualKeys = EMPTY_SET, ranges = []) {
  const out = new Map();
  for (const e of entries) {
    const key = entryKey(e);
    if (manualKeys.has(key)) out.set(key, '');
    else if (ranges.length) {
      const hit = ranges.find((r) => inRange(e.date, r));
      if (hit) out.set(key, hit.name || '');
    }
  }
  return out;
}

export function sanitizeFilename(name) {
  const s = String(name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return s || 'untitled';
}

/** 只拆分末尾的“(24-25学年第1学期)”，保留课程名中其它括号；兼容中文括号和四位年份。 */
export function parseCourseName(course) {
  const text = normalizeText(course);
  const m = /^(.*?)\s*[(（]\s*(\d{2}(?:\d{2})?)\s*[-－–—]\s*(\d{2}(?:\d{2})?)\s*学年\s*第\s*(\d+)\s*学期\s*[)）]$/.exec(text);
  if (!m) return { courseName: text, academicYear: '', semester: '' };
  return { courseName: m[1].trim(), academicYear: `${m[2]}-${m[3]}`, semester: m[4] };
}

/**
 * 模板变量：{index} {date} {periodStart} {periodEnd} {teacher} {course} {time}(HHmm) {startTime}
 * 日期拆分：{YYYY} {YY} {MM} {DD}，如 2026-09-15 → 2026 / 26 / 09 / 15，便于拼成 260915、0915 等。
 * 课程拆分：{courseName} {academicYear} {semester}，如 计算概论（B）上机(24-25学年第1学期)
 * → 计算概论（B）上机 / 24-25 / 1；{course} 保留完整名称。
 * 数字补零：{index:02d}、{index:3d} 均按零填充到指定宽度。未知变量原样保留。
 */
export function formatFilename(template, entry, ctx = {}) {
  const date = entry.date || '';
  const vars = {
    index: entry.index,
    date: entry.date,
    YYYY: date.slice(0, 4),
    YY: date.slice(2, 4),
    MM: date.slice(5, 7),
    DD: date.slice(8, 10),
    periodStart: entry.periodStart,
    periodEnd: entry.periodEnd,
    teacher: entry.teacher || '',
    course: ctx.course || '',
    ...parseCourseName(ctx.course),
    startTime: entry.startTime || '',
    time: entry.startTime ? entry.startTime.slice(11, 16).replace(':', '') : '',
  };
  const out = String(template || DEFAULT_TEMPLATE).replace(/\{(\w+)(?::0?(\d+)d)?\}/g, (all, name, width) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return all;
    const v = String(vars[name] == null ? '' : vars[name]);
    return width ? v.padStart(Number(width), '0') : v;
  });
  return sanitizeFilename(out);
}

export const OUTPUT_FORMATS = ['mp4', 'ts'];

/** 把模板生成的视频扩展名换成实际输出格式（mp4 / ts）。 */
export function withExtension(name, format) {
  return `${String(name).replace(/\.(mp4|ts|mkv|flv|mov)$/i, '')}.${format}`;
}

export const toTsFilename = (name) => withExtension(name, 'ts');

export function parseCourseId(url) {
  const m = /[?&]course_id=([^&#]+)/.exec(String(url || ''));
  return m ? decodeURIComponent(m[1]) : '';
}

/** manifest 只包含白名单字段，绝不包含 watchUrl。 */
export function buildManifest({ course, courseId, template, entries, generatedAt }) {
  const tpl = template || DEFAULT_TEMPLATE;
  return {
    schema: 'course-fetch.manifest/v1',
    generatedAt: generatedAt || new Date().toISOString(),
    course: { name: course || '', id: courseId || '' },
    template: tpl,
    count: entries.length,
    lectures: entries.map((e) => ({
      index: e.index,
      date: e.date,
      periodStart: e.periodStart,
      periodEnd: e.periodEnd,
      startTime: e.startTime,
      teacher: e.teacher,
      filename: formatFilename(tpl, e, { course }),
    })),
  };
}

/** 纯文本清单（制表符分隔，可直接粘到表格）。不含 URL。 */
export function buildListText({ course, template, entries }) {
  const lines = [`# ${course || '未命名课程'}（${entries.length} 条）`];
  for (const e of entries) {
    lines.push([formatFilename(template, e, { course }), e.startTime || e.date, e.teacher].join('\t'));
  }
  return lines.join('\n');
}

// 旧版 Prototype.js 会定义 Array.prototype.toJSON，导致 JSON.stringify 把数组输出成字符串
export function safeStringify(value) {
  const saved = Array.prototype.toJSON;
  if (saved) delete Array.prototype.toJSON;
  try {
    return JSON.stringify(value, null, 2);
  } finally {
    if (saved) Array.prototype.toJSON = saved; // eslint-disable-line no-extend-native
  }
}
