import test from 'node:test';
import assert from 'node:assert/strict';
import { splitAnnexB, parseSps, parseAdtsHeader, audioSpecificConfig } from '../src/codecs.js';
import { TsDemuxer } from '../src/ts-demux.js';
import { Track, buildMoov, mdatHeader } from '../src/mp4-mux.js';
import { createMp4Remuxer, createOutput, RemuxError } from '../src/remux.js';
import { memorySink } from '../src/downloader.js';
import { makeTs, rechunk, memoryFile, SPS, PPS, SPS_CHANGED } from './ts-fixture.js';
import { readMp4, avccNals, readBoxes, find, indexOfBytes } from './mp4-reader.js';

async function remux(chunks) {
  const file = memoryFile();
  const remuxer = createMp4Remuxer({ write: (d) => file.write(d), writeAt: (p, d) => file.writeAt(p, d) });
  for (const c of chunks) await remuxer.push(c);
  const result = await remuxer.finish();
  return { result, bytes: file.bytes, mp4: readMp4(file.bytes), writes: file.writes };
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

test('codecs：真实 SPS 解析为 1920×1080 High@4.0；Annex B 3/4 字节起始码；ADTS 头与 AudioSpecificConfig', () => {
  const sps = parseSps(SPS);
  assert.deepEqual(
    [sps.profileIdc, sps.levelIdc, sps.width, sps.height, sps.chromaFormatIdc, sps.bitDepthLuma, sps.highProfile],
    [100, 40, 1920, 1080, 1, 8, true],
  );
  const nals = splitAnnexB(Uint8Array.from([0, 0, 0, 1, 9, 0xf0, 0, 0, 1, 0x67, 1, 2, 0, 0, 0, 1, 0x65, 7]));
  assert.deepEqual(nals.map((n) => [...n]), [[9, 0xf0], [0x67, 1, 2], [0x65, 7]]);
  const h = parseAdtsHeader(Uint8Array.from([0xff, 0xf1, 0x4c, 0x80, 0x05, 0x1f, 0xfc]), 0);
  assert.deepEqual([h.objectType, h.sampleRate, h.channelConfig, h.headerLength, h.frameLength], [2, 48000, 2, 7, 40]);
  assert.equal(parseAdtsHeader(Uint8Array.from([0x47, 0, 0, 0, 0, 0, 0]), 0), null);
  assert.deepEqual([...audioSpecificConfig(h)], [0x11, 0x90]);
});

test('TS 解复用：任意切块（含 1 字节、跨包、跨 PES）结果与整体输入一致', () => {
  const { segments } = makeTs({ segments: 2, framesPerSegment: 5 });
  const collect = (chunks) => {
    const d = new TsDemuxer();
    const units = chunks.flatMap((c) => d.push(c)).concat(d.flush());
    return { streams: d.streams, units: units.map((u) => [u.kind, u.pts, u.dts, [...u.data].join(',')]) };
  };
  const whole = collect(segments);
  assert.deepEqual(whole.streams.map((s) => [s.type, s.kind]), [[0x1b, 'video'], [0x0f, 'audio']]);
  assert.equal(whole.units.filter((u) => u[0] === 'video').length, 10);
  for (const sizes of [[1], [187], [189, 7, 1000], [4096]]) assert.deepEqual(collect(rechunk(segments, sizes)), whole, `sizes ${sizes}`);
});

test('TS → MP4：样本字节、B 帧 CTS、关键帧、时长、音画偏移和 avcC/esds 全部无损保留', async () => {
  const src = makeTs({ segments: 4, framesPerSegment: 6 });
  const { result, bytes, mp4 } = await remux(rechunk(src.segments, [1000, 1777, 188 * 9]));
  assert.deepEqual(mp4.types, ['ftyp', 'mdat', 'moov']);
  assert.equal(mp4.mdat.size, mp4.mdat.body.length + 16);
  assert.equal(result.bytes, bytes.length);
  assert.deepEqual(result.warnings, { timestamps: 0, droppedFrames: 0, corrupt: 0 });
  const [video, audio] = mp4.tracks;
  assert.equal(video.handler, 'vide');
  assert.equal(audio.handler, 'soun');

  // 视频：去掉 AUD，其余 NAL 原样保留
  assert.equal(video.samples.length, src.video.length);
  video.samples.forEach((sample, i) => {
    const nals = avccNals(sample);
    assert.equal(nals.length, src.video[i].nals.length);
    nals.forEach((nal, j) => assert.ok(same(nal, src.video[i].nals[j]), `帧 ${i} NAL ${j}`));
  });
  assert.ok(video.durations.every((d) => d === 3600));
  assert.deepEqual(video.ctts, src.video.map((f) => f.pts - f.dts));
  assert.deepEqual(video.stss, [1, 7, 13, 19]);
  assert.equal(video.timescale, 90000);
  // 视频首帧显示时间比音频晚 17 ms：空白编辑 17 ms + 从首帧 CTS 开始
  assert.deepEqual(video.elst[0], [17, -1]);
  assert.equal(video.elst[1][1], src.video[0].pts - src.video[0].dts);
  const avcC = video.sampleEntry.subarray(indexOfBytes(video.sampleEntry, Uint8Array.from([0x61, 0x76, 0x63, 0x43])) + 4);
  assert.deepEqual([...avcC.subarray(0, 6)], [1, 100, 0, 40, 0xff, 0xe1]);
  assert.ok(indexOfBytes(avcC, SPS) > 0 && indexOfBytes(avcC, PPS) > 0);
  assert.ok(indexOfBytes(video.sampleEntry, Uint8Array.from([0x07, 0x80, 0x04, 0x38])) > 0, '1920×1080');

  // 音频：去掉 ADTS 头，每帧 1024 个采样
  assert.equal(audio.timescale, 48000);
  assert.equal(audio.samples.length, src.audio.length);
  audio.samples.forEach((s, i) => assert.ok(same(s, src.audio[i].data), `音频帧 ${i}`));
  assert.ok(audio.durations.every((d) => d === 1024));
  assert.equal(audio.elst.length, 1);
  assert.ok(indexOfBytes(audio.sampleEntry, Uint8Array.from([0x05, 0x02, 0x11, 0x90])) > 0, 'AudioSpecificConfig');
  assert.equal(result.video.frames, 24);
  assert.equal(result.audio.frames, src.audio.length);
  // 每个分片的音视频各写成一个 chunk，偏移落在 mdat 内
  assert.ok(video.offsets.every((o) => o >= mp4.mdat.start + 16 && o < mp4.mdat.start + mp4.mdat.size));
});

test('有界写入：每次 push 只写出本块的样本，写盘次数随分片数而不是帧数增长', async () => {
  const src = makeTs({ segments: 6, framesPerSegment: 9 });
  const file = memoryFile();
  let maxWrite = 0;
  const remuxer = createMp4Remuxer({
    write: (d) => { maxWrite = Math.max(maxWrite, d.length); file.write(d); },
    writeAt: (p, d) => file.writeAt(p, d),
  });
  const largest = Math.max(...src.segments.map((s) => s.length));
  for (const s of src.segments) await remuxer.push(s);
  await remuxer.finish();
  // 6 个分片 + finish 时的最后一帧（视频 PES 无长度，要等下一个 PES 起点或输入结束）+ moov
  assert.equal(file.writes, 6 + 2);
  assert.ok(maxWrite <= largest, `单次写入 ${maxWrite} 不超过一个分片 ${largest}`);
});

test('33 位 PTS 回绕：时间轴连续，无警告', async () => {
  const src = makeTs({ segments: 3, framesPerSegment: 6, startPts: 2 ** 33 - 5 * 3600 });
  const { result, mp4 } = await remux(src.segments);
  assert.equal(result.warnings.timestamps, 0);
  assert.ok(mp4.tracks[0].durations.every((d) => d === 3600));
  assert.ok(mp4.tracks[1].durations.every((d) => d === 1024));
});

test('时间戳断点（中途回退）：按帧长接续并给出警告，样本不丢失', async () => {
  const src = makeTs({ segments: 3, framesPerSegment: 6, dtsOffset: (s) => (s === 2 ? -500000 : 0) });
  const { result, mp4 } = await remux(src.segments);
  assert.ok(result.warnings.timestamps >= 2);
  assert.equal(mp4.tracks[0].samples.length, 18);
  assert.ok(mp4.tracks[0].durations.every((d) => d === 3600));
  assert.equal(mp4.tracks[1].samples.length, src.audio.length);
});

test('无音频的录像也能生成只含视频轨的 MP4', async () => {
  const { mp4 } = await remux(makeTs({ segments: 2, audio: false }).segments);
  assert.deepEqual(mp4.tracks.map((t) => t.handler), ['vide']);
  assert.deepEqual(mp4.tracks[0].elst, [[480, 3600]]);
});

test('HEVC / MP3 / AC-3：明确识别为不可无损封装，未写出任何字节', async () => {
  for (const [opts, name] of [[{ videoType: 0x24 }, 'H.265/HEVC'], [{ audioType: 0x03 }, 'MP3'], [{ audioType: 0x81 }, 'AC-3']]) {
    const file = memoryFile();
    const remuxer = createMp4Remuxer({ write: (d) => file.write(d), writeAt: () => {} });
    await assert.rejects(remuxer.push(makeTs(opts).segments[0]), (e) => {
      assert.ok(e instanceof RemuxError && e.unsupported && e.fatal);
      assert.ok(e.message.includes(name) && e.message.includes('无法无损封装为 MP4'), e.message);
      return true;
    });
    assert.equal(file.writes, 0);
  }
});

test('解密错误产生的非 TS 数据：报错但不当作“编码不支持”（不能回退保存垃圾数据）', async () => {
  const garbage = new Uint8Array(400000).map((_, i) => (i * 7 + 3) % 256 || 1);
  const remuxer = createMp4Remuxer({ write: () => {}, writeAt: () => {} });
  await assert.rejects(remuxer.push(garbage), (e) => e instanceof RemuxError && !e.unsupported && /不是有效的 MPEG-TS/.test(e.message));
});

test('写出数据后 SPS 改变：致命错误，不能再回退为 TS', async () => {
  const src = makeTs({ segments: 3, spsAt: (s) => (s === 2 ? SPS_CHANGED : SPS) });
  const remuxer = createMp4Remuxer({ write: () => {}, writeAt: () => {} });
  await remuxer.push(src.segments[0]);
  await remuxer.push(src.segments[1]);
  await assert.rejects(remuxer.push(src.segments[2]), (e) => !e.unsupported && /中途改变/.test(e.message));
});

test('createOutput：.ts 原样透传；.mp4 无回退时报错；有回退时把已输入的 TS 原样写入新文件', async () => {
  const ts = memoryFile();
  const passthrough = createOutput({ filename: 'a.ts', sink: ts });
  await passthrough.write(Uint8Array.of(0x47, 1));
  assert.deepEqual(await passthrough.finish(), { format: 'ts' });
  assert.deepEqual([...ts.bytes], [0x47, 1]);

  const hevc = makeTs({ videoType: 0x24, segments: 2 }).segments;
  const strict = createOutput({ filename: 'a.mp4', sink: memoryFile() });
  await assert.rejects(strict.write(hevc[0]), (e) => e.unsupported);

  const first = memoryFile(), second = memoryFile();
  let reason = '';
  const output = createOutput({
    filename: 'a.mp4', sink: first,
    onFallback: async (e) => { reason = e.reason; return second; },
  });
  // 小块输入：PMT 之前的字节也必须写进回退文件
  for (const c of rechunk(hevc, [100, 50000])) await output.write(c);
  const result = await output.finish();
  assert.equal(result.format, 'ts');
  assert.equal(output.format, 'ts');
  assert.match(reason, /HEVC/);
  assert.equal(first.writes, 0);
  assert.ok(same(second.bytes, Uint8Array.from(Buffer.concat(hevc))));
});

test('memorySink：writeAt 回填已写入块中的文件头，生成完整 MP4 Blob', async () => {
  let saved;
  const sink = memorySink('a.mp4', (blob, name) => { saved = { blob, name }; });
  const output = createOutput({ filename: 'a.mp4', sink });
  for (const s of makeTs({ segments: 2 }).segments) await output.write(s);
  await output.finish();
  sink.close();
  assert.equal(saved.name, 'a.mp4');
  assert.equal(saved.blob.type, 'video/mp4');
  const mp4 = readMp4(new Uint8Array(await saved.blob.arrayBuffer()));
  assert.equal(mp4.tracks[0].samples.length, 12);
  assert.throws(() => sink.writeAt(1e9, Uint8Array.of(1)), /位置无效/);
});

test('超过 4 GB：mdat 使用 64 位大小，chunk 偏移使用 co64', () => {
  const header = mdatHeader(5 * 2 ** 30);
  assert.equal(header.length, 16);
  assert.deepEqual([...header.subarray(0, 8)], [0, 0, 0, 1, 0x6d, 0x64, 0x61, 0x74]);
  assert.equal(new DataView(header.buffer).getBigUint64(8), BigInt(5 * 2 ** 30 + 16));
  const track = new Track('audio', 48000);
  track.addSample(10, 0, 0, true);
  track.addChunk(48, 1);
  track.addSample(10, 1024, 0, true);
  track.addChunk(2 ** 32 + 100, 1);
  track.close(1024);
  Object.assign(track, { id: 1, emptyEdit: 0, mediaTime: 0, codec: { config: Uint8Array.of(0x11, 0x90), channels: 2, sampleRate: 48000, bitrate: 0 } });
  const boxes = readBoxes(buildMoov([track]));
  const stbl = find(boxes, 'moov/trak/mdia/minf/stbl');
  assert.ok(stbl.children.some((b) => b.type === 'co64'));
  assert.ok(!stbl.children.some((b) => b.type === 'stco'));
});
