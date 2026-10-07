// 离线转换：把已经下载的 .ts 无损转封装为 .mp4，使用与 userscript 相同的流式 remux 模块。
// 用法：node tools/ts2mp4.mjs input.ts [output.mp4] [--chunk=字节数]
// 按块读取、直接写盘，内存占用与文件大小无关；--chunk 可模拟不同的分片大小（默认 2 MB）。
import fs from 'node:fs/promises';
import { createMp4Remuxer } from '../src/remux.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const chunkArg = process.argv.find((a) => a.startsWith('--chunk='));
const chunkSize = chunkArg ? Number(chunkArg.slice(8)) : 2 * 1024 * 1024;
const [input, output = input.replace(/\.ts$/i, '') + '.mp4'] = args;
if (!input) {
  console.error('用法：node tools/ts2mp4.mjs input.ts [output.mp4]');
  process.exit(2);
}

const src = await fs.open(input, 'r');
const dst = await fs.open(output, 'wx');
let position = 0;
const started = Date.now();
try {
  const remuxer = createMp4Remuxer({
    write: async (data) => {
      await dst.write(data, 0, data.length, position);
      position += data.length;
    },
    writeAt: (at, data) => dst.write(data, 0, data.length, at),
  });
  for (let offset = 0; ; ) {
    const buf = new Uint8Array(chunkSize);
    const { bytesRead } = await src.read(buf, 0, chunkSize, offset);
    if (!bytesRead) break;
    offset += bytesRead;
    await remuxer.push(buf.subarray(0, bytesRead));
  }
  const result = await remuxer.finish();
  console.log(JSON.stringify({ output, seconds: (Date.now() - started) / 1000, peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024), ...result }, null, 2));
  await dst.close();
} catch (error) {
  await dst.close();
  await fs.rm(output, { force: true });
  console.error(`转换失败：${error.message}`);
  process.exitCode = 1;
} finally {
  await src.close();
}
