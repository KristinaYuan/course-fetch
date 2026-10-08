// 优先选目录直接写盘；Safari / Firefox 使用 OPFS 临时文件或内存合并，再交给浏览器保存。
// 同名文件自动加后缀，避免覆盖；取消或失败时删除未完成的文件。
import { abortError, memorySink, saveBlob } from './downloader.js';

export async function pickDownloadDirectory(win = window) {
  if (typeof win.showDirectoryPicker !== 'function') {
    throw new Error('当前浏览器不支持选择本地下载目录');
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
        try { await writable.abort(); }
        finally { await directory.removeEntry(name); }
      },
    };
  };
}

/** 临时文件保留至下载 URL 释放，避免浏览器尚未读取时删除；失败/取消则立即清理。 */
export function createOpfsSinkFactory(directory, save = saveBlob) {
  return async (filename, signal) => {
    if (signal?.aborted) throw abortError();
    const name = `${crypto.randomUUID()}.tmp`;
    const handle = await directory.getFileHandle(name, { create: true });
    const remove = () => directory.removeEntry(name);
    let writable, closed = false;
    try {
      if (signal?.aborted) throw abortError();
      writable = await handle.createWritable();
      if (signal?.aborted) throw abortError();
    } catch (error) {
      if (writable) await Promise.resolve().then(() => writable.abort()).catch(() => {});
      await remove().catch(() => {});
      throw error;
    }
    return {
      kind: 'opfs', filename,
      write: (data) => writable.write(data),
      writeAt: (position, data) => writable.write({ type: 'write', position, data }),
      close: async () => {
        if (signal?.aborted) throw abortError();
        await writable.close();
        closed = true;
        const file = await handle.getFile();
        if (signal?.aborted) throw abortError();
        await save(file, filename, remove);
      },
      abort: async () => {
        try { if (!closed) await writable.abort(); }
        finally { await remove(); }
      },
    };
  };
}

/**
 * 单条和批量共用保存位置，必须在点击后的第一个 await 调用（目录选择需要用户手势）。
 * 用户取消选择或拒绝授权时直接抛出；仅缺少目录 API 或 SecurityError 时进入浏览器保存模式。
 * 返回 { kind: 'file' | 'opfs' | 'memory', reason, open(filename, signal) => sink }。
 */
export async function pickDownloadTarget(win = window, save = saveBlob) {
  let reason = '当前浏览器不支持目录写入';
  if (typeof win.showDirectoryPicker === 'function') {
    try {
      const directory = await pickDownloadDirectory(win);
      return { kind: 'file', reason: '', open: createDirectorySinkFactory(directory) };
    } catch (error) {
      if (error.name !== 'SecurityError') throw error; // AbortError：用户取消；其它错误直接显示
      reason = '当前页面不允许目录写入（可能在跨域 iframe 中，可右键「在新标签页中打开框架」）';
    }
  }
  const storage = win.navigator?.storage;
  if (typeof storage?.getDirectory === 'function' && typeof win.FileSystemFileHandle?.prototype?.createWritable === 'function') {
    try {
      const root = await storage.getDirectory();
      const directory = await root.getDirectoryHandle('course-fetch', { create: true });
      return { kind: 'opfs', reason, open: createOpfsSinkFactory(directory, save) };
    } catch (error) {
      // 临时存储不可用（例如页面限制）时才退回内存；配额/磁盘错误不能悄悄绕过。
      if (!['SecurityError', 'NotAllowedError', 'NotSupportedError'].includes(error.name)) throw error;
      reason += '，浏览器临时存储不可用';
    }
  }
  return { kind: 'memory', reason, open: async (filename, signal) => {
    if (signal?.aborted) throw abortError();
    return Object.assign(memorySink(filename, save), { filename });
  } };
}
