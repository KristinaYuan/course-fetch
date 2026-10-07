// FIFO 请求队列：排队不占请求槽；取消排队任务会立即移除。
import { abortError } from './downloader.js';

export function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} 必须是正整数`);
  return value;
}

export function createRequestLimiter(limit = 8) {
  positiveInteger(limit, '请求上限');
  let active = 0;
  const queue = [];
  function pump() {
    while (active < limit && queue.length) {
      const job = queue.shift();
      job.signal?.removeEventListener('abort', job.onAbort);
      if (job.signal?.aborted) {
        job.reject(abortError());
        continue;
      }
      active++;
      // 槽位覆盖完整响应体读取，直到底层请求结束才释放。
      Promise.resolve().then(() => {
        if (job.signal?.aborted) throw abortError();
        return job.fn();
      }).then(job.resolve, job.reject).finally(() => {
        active--;
        pump();
      });
    }
  }
  return {
    get active() { return active; },
    get queued() { return queue.length; },
    run(fn, signal) {
      if (signal?.aborted) return Promise.reject(abortError());
      return new Promise((resolve, reject) => {
        const job = { fn, signal, resolve, reject, onAbort: null };
        job.onAbort = () => {
          const index = queue.indexOf(job);
          if (index !== -1) queue.splice(index, 1);
          reject(abortError());
        };
        signal?.addEventListener('abort', job.onAbort, { once: true });
        queue.push(job);
        pump();
      });
    },
    wrap(request) {
      return (url, type, signal, resource) => this.run(() => request(url, type, signal, resource), signal);
    },
  };
}
