// 界面：Shadow DOM 面板、列表渲染、下载进度、事件绑定。业务动作由 main.js 通过 actions 注入。

import { DEFAULT_TEMPLATE, entryKey, buildListText } from './parser.js';
import { store } from './storage.js';
import { batchProgress, isTaskFinished } from './batch.js';

const PANEL_CSS = `
  :host { all: initial; }
  .cf { font: 12px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: #222;
        background: #fff; border: 1px solid #ccc; border-radius: 6px; box-shadow: 0 2px 12px rgba(0,0,0,.15);
        width: 620px; max-width: calc(100vw - 32px); }
  .cf.collapsed { width: auto; }
  .hd { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; user-select: none;
        background: #f6f6f6; border-radius: 6px; }
  .cf:not(.collapsed) .hd { border-bottom: 1px solid #e5e5e5; border-radius: 6px 6px 0 0; }
  .hd b { font-weight: 600; } .hd .count { color: #666; } .hd .arrow { margin-left: auto; color: #999; }
  .bd { padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
  .collapsed .bd { display: none; }
  label { display: flex; align-items: center; gap: 6px; }
  label span { width: 56px; color: #555; flex: none; }
  select { font: inherit; padding: 1px 4px; border: 1px solid #ccc; border-radius: 3px; }
  input[type=text] { flex: 1; min-width: 0; font: inherit; padding: 2px 6px; border: 1px solid #ccc; border-radius: 3px; }
  .hint { color: #888; font-size: 11px; margin-left: 62px; }
  .bar { display: flex; flex-wrap: wrap; gap: 4px; }
  button { font: inherit; padding: 2px 8px; border: 1px solid #bbb; border-radius: 3px; background: #fafafa; cursor: pointer; }
  button:hover { background: #eee; } button:disabled { opacity: .5; cursor: default; }
  button.link { border: none; background: none; color: #1a5fb4; padding: 0 4px; }
  .status { color: #444; } .status.flash { color: #1a7f37; }
  details { color: #9a6700; } details ul { margin: 4px 0 0; padding-left: 18px; max-height: 100px; overflow: auto; }
  .tbl { max-height: 45vh; overflow: auto; border: 1px solid #eee; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 2px 6px; border-bottom: 1px solid #f0f0f0; text-align: left; white-space: nowrap; }
  th { position: sticky; top: 0; background: #fafafa; font-weight: 600; }
  td.fn { font-family: ui-monospace, Menlo, Consolas, monospace; white-space: normal; word-break: break-all; }
  .muted { color: #888; }
  .dl { border: 1px solid #cfe0f5; background: #f5f9ff; border-radius: 4px; padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; }
  .dl[hidden] { display: none; }
  .dl-top { display: flex; align-items: center; gap: 8px; }
  .dl-name { flex: 1; min-width: 0; font-family: ui-monospace, Menlo, Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dl-bar { height: 6px; background: #dde6f0; border-radius: 3px; overflow: hidden; position: relative; }
  .dl-fill { height: 100%; width: 0; background: #1a5fb4; transition: width .2s; }
  .dl-bar.indeterminate .dl-fill { width: 30%; position: absolute; animation: cf-slide 1.2s ease-in-out infinite; }
  @keyframes cf-slide { from { left: -30%; } to { left: 100%; } }
  .dl-l1 { color: #333; } .dl-l2 { color: #666; font-size: 11px; }
  .dl-warn { color: #b42318; font-size: 11px; }
  .dl-note { color: #9a6700; font-size: 11px; }
  .dl.done { border-color: #b7dfc3; background: #f3fbf5; }
  .dl.done .dl-cancel { font-weight: 600; }
  .task-state { display: block; color: #555; white-space: normal; max-width: 220px; }
  .task-state[data-status="failed"] { color: #b42318; }
  .task-state .notice { color: #9a6700; }
`;

const PANEL_HTML = `
  <style>${PANEL_CSS}</style>
  <div class="cf">
    <div class="hd"><b>Course Fetch</b><span class="count"></span><span class="arrow"></span></div>
    <div class="bd">
      <label><span>课程</span><input type="text" class="course"></label>
      <label><span>命名模板</span><input type="text" class="tpl"><button class="reset-tpl">重置</button></label>
      <div class="hint">变量：{index:02d} {date} {periodStart} {periodEnd} {teacher} {course} {time}</div>
      <label><span>输出格式</span><select class="fmt"><option value="mp4">MP4（无损转封装，推荐）</option><option value="ts">TS（原始流）</option></select></label>
      <div class="bar">
        <button data-act="scan">重新扫描</button>
        <button data-act="all">全选</button>
        <button data-act="none">全不选</button>
        <button data-act="open">打开选中</button>
        <button data-act="download">下载选中</button>
        <button data-act="copy">复制清单</button>
        <button data-act="export">导出 JSON</button>
      </div>
      <div class="dl" hidden>
        <div class="dl-top"><span class="dl-name"></span><button class="dl-cancel">取消</button></div>
        <div class="dl-bar"><div class="dl-fill"></div></div>
        <div class="dl-l1"></div>
        <div class="dl-l2"></div>
        <div class="dl-warn" hidden></div>
        <div class="dl-note" hidden></div>
      </div>
      <div class="status"></div>
      <details class="warn" hidden><summary></summary><ul></ul></details>
      <div class="tbl"><table>
        <thead><tr><th><input type="checkbox" class="chk-all"></th><th>#</th><th>文件名</th><th>开始时间</th><th>教师</th><th></th></tr></thead>
        <tbody></tbody>
      </table></div>
    </div>
  </div>`;

const PHASE_LABEL = {
  pick: '选择保存目录',
  locate: '打开播放页，自动捕获播放列表',
  download: '下载中',
  finish: '写入文件',
  file: '创建文件',
  queued: '排队中',
};

export function formatBytes(n) {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/**
 * 创建面板并挂到页面上。
 * actions: { scan, openEntries, exportManifest, downloadEntry, cancelDownload }
 * outputNameOf(entry)：带实际输出扩展名（.mp4 / .ts）的文件名
 * 返回 { render, setStatus, flash, updateDownloadUI }
 */
export function createUI({ state, courseId, filenameOf, outputNameOf = filenameOf, actions }) {
  const host = document.createElement('div');
  host.id = 'course-fetch-host';
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = PANEL_HTML;
  document.body.appendChild(host);

  const $ = (sel) => root.querySelector(sel);
  const ui = {
    panel: $('.cf'),
    count: $('.count'),
    arrow: $('.arrow'),
    course: $('.course'),
    tpl: $('.tpl'),
    fmt: $('.fmt'),
    status: $('.status'),
    warn: $('.warn'),
    tbody: $('tbody'),
    chkAll: $('.chk-all'),
    dl: {
      root: $('.dl'),
      name: $('.dl-name'),
      cancel: $('.dl-cancel'),
      bar: $('.dl-bar'),
      fill: $('.dl-fill'),
      l1: $('.dl-l1'),
      l2: $('.dl-l2'),
      warn: $('.dl-warn'),
      note: $('.dl-note'),
    },
  };

  const selectedEntries = () => state.entries.filter((e) => state.selected.has(entryKey(e)));

  let flashTimer = null;
  function setStatus(msg) {
    state.status = msg;
    render();
  }
  function flash(msg) {
    ui.status.textContent = msg;
    ui.status.classList.add('flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      ui.status.classList.remove('flash');
      ui.status.textContent = state.status;
    }, 2500);
  }

  async function copyText(text, okMsg) {
    try {
      if (typeof GM_setClipboard === 'function') GM_setClipboard(text, 'text');
      else await navigator.clipboard.writeText(text);
      flash(okMsg);
    } catch (e) {
      flash(`复制失败：${e.message}`);
    }
  }

  /** 面板折叠时标题栏也显示下载进度。 */
  function headerCount() {
    const d = state.download;
    if (d) return d.total ? `下载 ${Math.floor((d.done / d.total) * 100)}%` : '下载准备中…';
    if (state.batch) {
      const p = batchProgress(state.batch);
      if (!state.batch.running) return `批量结束 · 成功 ${p.completed}/${p.total}`;
      return `批量 ${Math.floor(p.percent)}% · ${p.settled}/${p.total}`;
    }
    return state.scanning ? '扫描中…' : `${state.entries.length} 条`;
  }

  function downloadButtonLabel(key) {
    const d = state.download;
    if (!d || d.key !== key) return '下载';
    if (d.aborting) return '取消中…';
    return d.total ? `${Math.floor((d.done / d.total) * 100)}%` : '准备中…';
  }

  /** 下载进度只更新下载面板和该行按钮，不重建表格。 */
  function updateDownloadUI() {
    const d = state.download;
    const box = ui.dl;
    box.root.hidden = !d && !state.batch;
    box.root.classList.toggle('done', !!state.batch && !state.batch.running);
    ui.count.textContent = headerCount();
    if (state.batch) {
      const batch = state.batch;
      const p = batchProgress(batch);
      box.name.textContent = `批量下载 · ${p.total} 条录像`;
      box.name.title = box.name.textContent;
      box.bar.classList.toggle('indeterminate', batch.phase === 'pick' && batch.running);
      box.fill.style.width = `${p.percent.toFixed(1)}%`;
      box.note.hidden = true;
      if (!batch.running) {
        // 批次结束：保留每条结果，等用户确认后恢复页面
        box.cancel.disabled = false;
        box.cancel.textContent = '确定';
        box.l1.textContent = `批量下载已结束：成功 ${p.completed} · 失败 ${p.failed} · 取消 ${p.cancelled}`;
        box.l2.textContent = `已写入 ${formatBytes(p.bytes)} · 每条结果见下表，点「确定」清除结果并恢复列表`;
      } else {
        box.cancel.disabled = batch.aborting;
        box.cancel.textContent = batch.aborting ? '取消中…' : '取消整个批次';
        box.l1.textContent = batch.phase === 'pick' ? '选择目标目录' :
          `已处理 ${p.settled} / ${p.total}（${p.percent.toFixed(0)}%）· 成功 ${p.completed} · 失败 ${p.failed} · 取消 ${p.cancelled}`;
        const batchSave = batch.sinkKind === 'file' ? '直接写入磁盘'
          : batch.sinkKind === 'opfs' ? '浏览器临时存储'
          : '内存合并，逐条保存';
        box.l2.textContent = `正在处理 ${p.active} · 排队 ${p.queued} · 已写入 ${formatBytes(p.bytes)} · ${batchSave}（总进度按录像等权，含失败/取消）`;
      }
      const notes = [];
      if (p.fallbacks) notes.push(`⚠ ${p.fallbacks} 条录像编码无法无损转为 MP4，已改存为 TS`);
      if (batch.sinkKind === 'opfs') notes.push(`⚠ ${batch.sinkNote || '当前浏览器不支持目录写入'}，使用浏览器临时存储，完成后保存`);
      else if (batch.sinkKind === 'memory') notes.push(`⚠ ${batch.sinkNote || '当前浏览器不支持目录写入'}，内存合并，逐条保存`);
      box.note.hidden = !notes.length;
      box.note.textContent = notes.join('；');
      box.warn.hidden = !p.badTs;
      box.warn.textContent = p.badTs ? `⚠ ${p.badTs} 个分片不是有效的 TS 数据，请检查对应录像` : '';
      for (const task of batch.tasks) {
        const row = ui.tbody.querySelector(`tr[data-key="${CSS.escape(task.key)}"]`);
        if (!row) continue;
        const label = row.querySelector('.task-state');
        label.dataset.status = task.status;
        const progress = task.total ? ` · ${task.done}/${task.total} 分片 · ${formatBytes(task.bytes)}` : '';
        label.textContent = (task.status === 'completed' ? '已完成' : task.status === 'failed' ? `失败：${task.error}` :
          task.status === 'cancelled' ? '已取消' : task.aborting ? '取消中…' : PHASE_LABEL[task.phase]) + progress +
          (task.badTs ? ` · ⚠ ${task.badTs} 个异常 TS 分片` : '');
        if (task.notice) label.appendChild(Object.assign(document.createElement('span'), { className: 'notice', textContent: ` · ⚠ ${task.notice}` }));
        label.title = `${task.filename}${task.error ? `：${task.error}` : ''}${task.notice ? `：${task.notice}` : ''}`;
        const cancel = row.querySelector('[data-row="batch-cancel"]');
        cancel.hidden = !batch.running || isTaskFinished(task);
        cancel.disabled = task.aborting;
      }
      return;
    }
    if (!d) return;

    const pct = d.total ? (d.done / d.total) * 100 : 0;
    box.name.textContent = d.filename;
    box.name.title = d.filename;
    box.bar.classList.toggle('indeterminate', !d.total);
    box.fill.style.width = d.total ? `${pct.toFixed(1)}%` : '';
    box.cancel.disabled = d.aborting;
    box.cancel.textContent = d.aborting ? '取消中…' : '取消';

    let line1 = PHASE_LABEL[d.phase] || d.phase;
    if (d.total) line1 += ` · 分片 ${d.done} / ${d.total}（${pct.toFixed(0)}%）`;
    box.l1.textContent = line1;

    const parts = [];
    if (d.total) {
      const elapsed = (Date.now() - d.startedAt) / 1000;
      parts.push(`已下载 ${formatBytes(d.bytes)}`);
      if (d.totalSeconds) parts.push(`视频 ${formatDuration(d.seconds)} / ${formatDuration(d.totalSeconds)}`);
      if (elapsed > 1 && d.bytes) {
        parts.push(`${formatBytes(d.bytes / elapsed)}/s`);
        if (d.done > 0 && d.done < d.total) parts.push(`剩余约 ${formatDuration((elapsed / d.done) * (d.total - d.done))}`);
      }
      parts.push(d.sinkKind === 'file' ? '直接写入磁盘' : d.sinkKind === 'opfs' ? '浏览器临时存储，完成后保存' : '内存中合并，完成后保存');
      if (/\.mp4$/i.test(d.filename)) parts.push('边下载边转封装 MP4');
    }
    box.l2.textContent = parts.join(' · ');
    box.warn.hidden = !d.badTs;
    box.warn.textContent = d.badTs
      ? `⚠ ${d.badTs} 个分片解密后不是有效的 TS 数据（key/IV 可能不对），建议取消后检查`
      : '';
    const note = [
      d.sinkKind === 'memory' && d.sinkNote ? `${d.sinkNote}，改为在内存中合并（占用内存约等于视频大小）` : '',
      d.sinkKind === 'opfs' ? `${d.sinkNote || '当前浏览器不支持目录写入'}，使用浏览器临时存储，完成后保存` : '',
      d.notice,
    ].filter(Boolean);
    box.note.hidden = !note.length;
    box.note.textContent = note.map((n) => `⚠ ${n}`).join('；');

    const btn = ui.tbody.querySelector(`tr[data-key="${CSS.escape(d.key)}"] button[data-row="download"]`);
    if (btn) btn.textContent = downloadButtonLabel(d.key);
  }

  function render() {
    ui.panel.classList.toggle('collapsed', state.collapsed);
    ui.arrow.textContent = state.collapsed ? '▴' : '▾';
    ui.count.textContent = headerCount();
    if (root.activeElement !== ui.course) ui.course.value = state.course;
    if (root.activeElement !== ui.tpl) ui.tpl.value = state.template;
    ui.fmt.value = state.format;
    if (!ui.status.classList.contains('flash')) ui.status.textContent = state.status;
    const busy = !!state.download || !!state.batch?.running;
    root.querySelectorAll('.bar button').forEach((b) => (b.disabled = state.scanning || (busy && ['scan', 'download'].includes(b.dataset.act))));
    ui.fmt.disabled = busy;

    ui.warn.hidden = !state.warnings.length;
    ui.warn.querySelector('summary').textContent = `${state.warnings.length} 条提示`;
    ui.warn.querySelector('ul').replaceChildren(
      ...state.warnings.map((w) => Object.assign(document.createElement('li'), { textContent: w })),
    );

    const frag = document.createDocumentFragment();
    for (const e of state.entries) {
      const key = entryKey(e);
      const tr = document.createElement('tr');
      tr.dataset.key = key;
      const cells = [
        Object.assign(document.createElement('input'), { type: 'checkbox', checked: state.selected.has(key) }),
        String(e.index),
        outputNameOf(e),
        e.startTime ? e.startTime.slice(0, 16) : e.date,
        e.teacher,
      ];
      cells.forEach((c, i) => {
        const td = document.createElement('td');
        if (i === 2) td.className = 'fn';
        if (typeof c === 'string') td.textContent = c;
        else td.appendChild(c);
        tr.appendChild(td);
      });
      const act = document.createElement('td');
      const otherDownload = (state.download && state.download.key !== key) || state.batch?.running;
      act.innerHTML =
        `<button class="link" data-row="open"${e.watchUrl ? '' : ' disabled title="无可用链接"'}>打开</button>` +
        '<button class="link" data-row="copy">复制名</button>' +
        `<button class="link" data-row="download"${!e.watchUrl || otherDownload ? ' disabled' : ''}` +
        `${state.download && !otherDownload ? ' title="点击取消"' : ''}></button>`;
      act.lastChild.textContent = downloadButtonLabel(key);
      const taskState = document.createElement('span');
      taskState.className = 'task-state';
      const cancel = document.createElement('button');
      cancel.className = 'link';
      cancel.dataset.row = 'batch-cancel';
      cancel.textContent = '取消此条';
      cancel.hidden = true;
      act.appendChild(taskState);
      act.appendChild(cancel);
      tr.appendChild(act);
      frag.appendChild(tr);
    }
    if (!state.entries.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="6" class="muted">${state.scanning ? '扫描中…' : '暂无条目'}</td>`;
      frag.appendChild(tr);
    }
    ui.tbody.replaceChildren(frag);
    ui.chkAll.checked = state.entries.length > 0 && state.selected.size === state.entries.length;
    updateDownloadUI();
  }

  // ---- 事件 ----------------------------------------------------------------------
  $('.hd').addEventListener('click', () => {
    state.collapsed = !state.collapsed;
    store.set('collapsed', state.collapsed);
    render();
  });

  ui.course.addEventListener('input', () => {
    state.course = ui.course.value.trim();
    store.set(`course:${courseId}`, state.course);
    render();
  });
  ui.tpl.addEventListener('input', () => {
    state.template = ui.tpl.value || DEFAULT_TEMPLATE;
    store.set('template', state.template);
    render();
  });
  ui.fmt.addEventListener('change', () => {
    state.format = ui.fmt.value === 'ts' ? 'ts' : 'mp4';
    store.set('format', state.format);
    render();
  });
  $('.reset-tpl').addEventListener('click', () => {
    state.template = DEFAULT_TEMPLATE;
    store.set('template', state.template);
    ui.tpl.value = state.template;
    render();
  });

  ui.chkAll.addEventListener('change', () => {
    state.selected = ui.chkAll.checked ? new Set(state.entries.map(entryKey)) : new Set();
    render();
  });

  $('.bar').addEventListener('click', (ev) => {
    const act = ev.target.dataset && ev.target.dataset.act;
    if (act === 'scan') actions.scan();
    else if (act === 'all') (state.selected = new Set(state.entries.map(entryKey))), render();
    else if (act === 'none') (state.selected = new Set()), render();
    else if (act === 'open') actions.openEntries(selectedEntries());
    else if (act === 'copy') {
      if (!state.entries.length) return flash('没有可复制的条目');
      const list = state.selected.size ? selectedEntries() : state.entries;
      copyText(
        buildListText({ course: state.course, template: state.template, entries: list }),
        `已复制 ${list.length} 条清单` + (state.selected.size ? '（仅选中）' : ''),
      );
    } else if (act === 'export') actions.exportManifest();
    else if (act === 'download') actions.downloadSelected(selectedEntries());
  });

  ui.tbody.addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr');
    const key = tr && tr.dataset.key;
    if (!key) return;
    const entry = state.entries.find((e) => entryKey(e) === key);
    if (ev.target.type === 'checkbox') {
      if (ev.target.checked) state.selected.add(key);
      else state.selected.delete(key);
      ui.chkAll.checked = state.selected.size === state.entries.length;
    } else if (ev.target.dataset.row === 'open') {
      actions.openEntries([entry]);
    } else if (ev.target.dataset.row === 'copy') {
      copyText(outputNameOf(entry), '已复制文件名');
    } else if (ev.target.dataset.row === 'download') {
      const d = state.download;
      if (d && d.key === key) {
        if (confirm(`取消下载 ${d.filename}？`)) actions.cancelDownload();
      } else {
        actions.downloadEntry(entry);
      }
    } else if (ev.target.dataset.row === 'batch-cancel') {
      actions.cancelTask(key);
    }
  });

  ui.dl.cancel.addEventListener('click', () => {
    if (state.batch?.running) return actions.cancelBatchDownload();
    if (state.batch) return actions.dismissBatch();
    const d = state.download;
    if (d && confirm(`取消下载 ${d.filename}？`)) actions.cancelDownload();
  });

  return { render, setStatus, flash, updateDownloadUI };
}
