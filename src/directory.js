// 选目录后直接写盘：批量只有磁盘流，不允许退回 Blob；单条在浏览器不支持目录写入时才退回内存合并。
// 同名文件自动加后缀，避免覆盖；取消或失败时删除未完成的文件。
import { abortError, memorySink } from './downloader.js';

export async function pickDownloadDirectory(win = window) {
  if (typeof win.showDirectoryPicker !== 'function') {
    throw new Error('批量下载需要支持目录写入的 Chrome / Edge，请在独立的 HTTPS 课堂实录页面中使用');
  }
  return win.showDirectoryPicker({ mode: 'readwrite' });
}

export function createDirectorySinkFactory(directory) {
  const reserved = new Set();
  return async (filename, signal) => {
    const [, base, ext] = /^(.*?)(\.[^.]*)?$/.exec(filename);
    let name;
    for (let suffix = 0; ; suffix++) {
      if (signal?.aborted) throw abortError();
      name = suffix ? `${base} (${suffix + 1})${ext || ''}` : filename;
      const canonical = name.toLowerCase();
      if (reserved.has(canonical)) continue;
      reserved.add(canonical); // 在 await 前预留，防止同批任务选择同一文件名。
      try {
        await directory.getFileHandle(name); // 不传 create：已有文件不能覆盖。
      } catch (error) {
        if (error.name === 'NotFoundError') break;
        if (error.name !== 'TypeMismatchError') throw error; // 同名目录也视为占用。
      }
    }
    if (signal?.aborted) throw abortError();
    const handle = await directory.getFileHandle(name, { create: true });
    let writable;
    try {
      if (signal?.aborted) throw abortError();
      writable = await handle.createWritable();
      if (signal?.aborted) throw abortError();
    } catch (error) {
      if (writable) await writable.abort();
      await directory.removeEntry(name).catch(() => {});
      throw error;
    }
    return {
      kind: 'file', filename: name,
      write: (data) => writable.write(data),
      writeAt: (position, data) => writable.write({ type: 'write', position, data }),
      close: () => writable.close(),
      abort: async () => {
        await writable.abort();
        await directory.removeEntry(name);
      },
    };
  };
}

/**
 * 单条下载的保存位置：与批量相同，选一次目录后直接写盘。必须在点击后的第一个 await 调用（需要用户手势）。
 * 返回 { kind: 'file' | 'memory', reason, open(filename, signal) => sink }。
 * 只有浏览器没有目录写入 API（如 Firefox），或页面不允许（如跨域 iframe 中的 SecurityError）时才退回内存合并，并给出原因。
 * 用户取消选择时抛出 AbortError。
 */
export async function pickSingleTarget(win = window) {
  let reason = '当前浏览器不支持目录写入（需要 Chrome / Edge）';
  if (typeof win.showDirectoryPicker === 'function') {
    try {
      const directory = await win.showDirectoryPicker({ mode: 'readwrite' });
      return { kind: 'file', reason: '', open: createDirectorySinkFactory(directory) };
    } catch (error) {
      if (error.name !== 'SecurityError') throw error; // AbortError：用户取消；其它错误直接显示
      reason = '当前页面不允许目录写入（可能在跨域 iframe 中，可右键「在新标签页中打开框架」）';
    }
  }
  return { kind: 'memory', reason, open: async (filename) => Object.assign(memorySink(filename), { filename }) };
}
