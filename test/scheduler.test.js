import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestLimiter } from '../src/scheduler.js';

const tick = () => new Promise((r) => setImmediate(r));
test('FIFO 请求队列：失败释放槽、取消排队移除、不提前启动', async () => {
  const limiter = createRequestLimiter(1);
  let release;
  const first = limiter.run(() => new Promise((r) => { release = r; }));
  const controller = new AbortController();
  const cancelled = limiter.run(() => assert.fail('取消任务不能执行'), controller.signal);
  const rejected = assert.rejects(cancelled, { name: 'AbortError' });
  const order = [];
  const failed = limiter.run(() => { order.push(1); throw new Error('network'); });
  const failedCheck = assert.rejects(failed, /network/);
  const last = limiter.run(() => order.push(2));
  await tick();
  assert.equal(limiter.active, 1); assert.equal(limiter.queued, 3);
  controller.abort(); await rejected;
  assert.equal(limiter.queued, 2);
  release();
  await Promise.all([first, failedCheck, last]); await tick();
  assert.deepEqual(order, [1, 2]);
  assert.equal(limiter.active, 0); assert.equal(limiter.queued, 0);
});

test('请求上限参数校验，已取消任务不入队', async () => {
  for (const n of [0, -1, 1.5, NaN]) assert.throws(() => createRequestLimiter(n), RangeError);
  const limiter = createRequestLimiter(2);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(limiter.run(() => assert.fail('不应运行'), controller.signal), { name: 'AbortError' });
  assert.equal(limiter.active, 0); assert.equal(limiter.queued, 0);
});
