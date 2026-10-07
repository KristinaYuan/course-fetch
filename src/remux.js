// TS → MP4 无损转封装：边下载边把 H.264 / AAC 样本写入 mdat，完成后写 moov 并回填 mdat 大小。不重新编码。
// 有界内存：只缓存当前块的样本、跨块的半帧和样本表；编码不能无损放入 MP4 时明确报错（可选回退为 TS）。

import { TsDemuxer, streamTypeName, PACKET } from './ts-demux.js';
import { splitAnnexB, parseSps, ppsId, parseAdtsHeader, audioSpecificConfig } from './codecs.js';
import { Track, FTYP, MDAT_HEADER_SIZE, mdatHeader, buildMoov } from './mp4-mux.js';

const WRAP = 2 ** 33; // PTS/DTS 为 33 位
const HALF_WRAP = 2 ** 32;
const MAX_STEP = 10 * 90000; // 相邻帧间隔超过 10 秒视为时间戳断点
const PMT_DEADLINE = PACKET * 1024; // 约 188 KB 内必须出现 PAT/PMT
const CHANNELS = [0, 1, 2, 3, 4, 5, 6, 8];

export class RemuxError extends Error {
  /** unsupported：编码无法无损放进 MP4，且尚未写出任何字节，调用方可以改存为 TS。 */
  constructor(message, { unsupported = false, reason = message } = {}) {
    super(message);
    this.name = 'RemuxError';
    this.fatal = true;
    this.unsupported = unsupported;
    this.reason = reason;
  }
}

const unwrap = (ts, ref) => {
  if (ref === null) return ts;
  while (ts - ref > HALF_WRAP) ts -= WRAP;
  while (ref - ts > HALF_WRAP) ts += WRAP;
  return ts;
};

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * write(Uint8Array) 顺序写入；writeAt(position, Uint8Array) 回填文件头（只在 finish 最后调用一次）。
 * 返回 { push(tsBytes), finish(), started }。push/finish 都等待写盘完成，保持下载的背压。
 */
export function createMp4Remuxer({ write, writeAt }) {
  const demux = new TsDemuxer();
  const warnings = { timestamps: 0, droppedFrames: 0, corrupt: 0 };
  let started = false; // 已写出 ftyp / mdat 头
  let checked = false; // 已确认 PMT 中的编码可以封装
  let bytesIn = 0;
  let offset = FTYP.length + MDAT_HEADER_SIZE; // 下一个样本的文件偏移
  let dataBytes = 0;

  const video = { track: null, sps: null, info: null, pps: new Map(), keyed: false, lastRaw: null, lastT: null, shift: 0, firstPts: 0, firstCts: 0 };
  const audio = { track: null, codec: null, rest: null, lastRaw: null, lastT: null, base: 0, shift: 0, bytes: 0 };
  // 当前块待写的样本：视频为 NAL 列表（写出时加 4 字节长度），音频为去掉 ADTS 头的原始帧。
  let chunk = { videoNals: [], videoSamples: 0, videoBytes: 0, audioFrames: [], audioBytes: 0 };

  const fail = (reason) => {
    throw new RemuxError(`${reason}，无法无损封装为 MP4`, { unsupported: !started, reason });
  };

  function checkStreams() {
    if (checked) return;
    if (!demux.streams) {
      if (bytesIn < PMT_DEADLINE) return;
      if (demux.packets * PACKET < bytesIn / 2) {
        throw new RemuxError('解密后的数据不是有效的 MPEG-TS（key 或 IV 可能不对），无法转封装');
      }
      fail('没有在录像开头找到 TS 节目表（PAT/PMT）');
    }
    const bad = demux.streams.filter((s) => s.kind === 'unsupported');
    if (bad.length) fail(`录像包含 ${bad.map((s) => streamTypeName(s.type)).join('、')} 流`);
    const count = (kind) => demux.streams.filter((s) => s.kind === kind).length;
    if (count('video') > 1 || count('audio') > 1) fail('录像包含多条视频或音频流');
    if (!count('video') && !count('audio')) fail('录像中没有音视频流');
    checked = true;
  }

  function onParameterSet(nal, type) {
    if (type === 7) {
      if (!video.sps) {
        try {
          video.info = parseSps(nal);
        } catch (e) {
          fail(`无法解析 H.264 SPS（${e.message}）`);
        }
        video.sps = nal.slice();
      } else if (!sameBytes(video.sps, nal)) {
        fail('视频参数（分辨率或编码配置）在录像中途改变');
      }
    } else {
      const id = ppsId(nal);
      const prev = video.pps.get(id);
      if (!prev) video.pps.set(id, nal.slice());
      else if (!sameBytes(prev, nal)) fail('视频 PPS 参数在录像中途改变');
    }
  }

  function onVideo(unit) {
    const keep = [];
    let size = 0;
    let key = false;
    for (const nal of splitAnnexB(unit.data)) {
      const type = nal[0] & 0x1f;
      if (type === 9) continue; // AUD 在 MP4 中没有意义
      if (type === 7 || type === 8) onParameterSet(nal, type);
      else if (type === 5) key = true;
      keep.push(nal);
      size += 4 + nal.length;
    }
    if (!keep.length) return;
    if (unit.pts === null) {
      // 没有 PTS 的 PES 是同一帧的续段；只能并入本块中尚未写出的上一帧。
      if (chunk.videoSamples) {
        chunk.videoNals.push(...keep);
        chunk.videoBytes += size;
        video.track.growLast(size);
      } else warnings.droppedFrames++;
      return;
    }
    if (!video.keyed && !key) {
      warnings.droppedFrames++; // 第一个关键帧之前的帧无法解码
      return;
    }
    video.keyed = true;
    const dts = unwrap(unit.dts, video.lastRaw);
    const pts = unwrap(unit.pts, dts);
    let cts = pts - dts;
    if (cts < 0) {
      cts = 0;
      warnings.timestamps++;
    }
    let t;
    if (video.lastT === null) {
      video.track = new Track('video', 90000);
      video.shift = dts;
      video.firstPts = pts;
      video.firstCts = cts;
      t = 0;
    } else {
      t = dts - video.shift;
      const step = t - video.lastT;
      if (step <= 0 || step > MAX_STEP) {
        // 时间戳断点：按上一帧时长接续，保持时间轴连续
        const nominal = video.track.lastDuration || 3600;
        video.shift += step - nominal;
        t = video.lastT + nominal;
        warnings.timestamps++;
      }
    }
    video.lastRaw = dts;
    video.lastT = t;
    video.track.addSample(size, t, cts, key);
    chunk.videoNals.push(...keep);
    chunk.videoSamples++;
    chunk.videoBytes += size;
  }

  function onAudio(unit) {
    const restLength = audio.rest ? audio.rest.length : 0;
    let data = unit.data;
    if (audio.rest) {
      data = new Uint8Array(restLength + unit.data.length);
      data.set(audio.rest);
      data.set(unit.data, restLength);
      audio.rest = null;
    }
    const raw = unit.pts === null ? null : unwrap(unit.pts, audio.lastRaw);
    if (raw !== null) audio.lastRaw = raw;
    let o = 0;
    let index = 0; // 本 PES 中起始的第几帧
    let lost = false;
    while (o + 7 <= data.length) {
      const h = parseAdtsHeader(data, o);
      if (!h) {
        if (!lost) warnings.corrupt++;
        lost = true;
        o++;
        continue;
      }
      lost = false;
      if (h.frameLength < h.headerLength) {
        warnings.corrupt++;
        o++;
        continue;
      }
      if (o + h.frameLength > data.length) break;
      if (!audio.codec) {
        if (!h.sampleRate || !h.channelConfig) fail('AAC 的采样率或声道配置无法写入 MP4');
        if (h.rawBlocks) fail('AAC ADTS 帧包含多个 raw data block');
        audio.codec = h;
        audio.track = new Track('audio', h.sampleRate);
      } else if (h.sampleRate !== audio.codec.sampleRate || h.channelConfig !== audio.codec.channelConfig || h.objectType !== audio.codec.objectType) {
        fail('音频参数（采样率、声道或 AAC 类型）在录像中途改变');
      } else if (h.rawBlocks) {
        fail('AAC ADTS 帧包含多个 raw data block');
      }
      const sr = audio.codec.sampleRate;
      const ownPts = o >= restLength && raw !== null;
      const framePts = ownPts ? raw + (index * 1024 * 90000) / sr : null;
      if (o >= restLength) index++;
      let t;
      if (audio.lastT === null) {
        if (framePts === null) {
          o += h.frameLength; // 第一帧没有时间戳，无法和视频对齐
          warnings.droppedFrames++;
          continue;
        }
        audio.base = framePts;
        t = 0;
      } else {
        const expected = audio.lastT + 1024;
        t = expected;
        if (framePts !== null) {
          const gap = Math.round(((framePts - audio.base) * sr) / 90000) - audio.shift - expected;
          if (gap > sr * 0.1 && gap <= sr * 10) {
            t = expected + gap; // 源中真实缺失的音频，保留空白以维持音画同步
            warnings.timestamps++;
          } else if (Math.abs(gap) > sr * 0.1) {
            audio.shift += gap; // 断点：接续时间轴
            warnings.timestamps++;
          }
        }
      }
      audio.lastT = t;
      const frame = data.subarray(o + h.headerLength, o + h.frameLength);
      audio.track.addSample(frame.length, t, 0, true);
      chunk.audioFrames.push(frame);
      chunk.audioBytes += frame.length;
      audio.bytes += frame.length;
      o += h.frameLength;
    }
    if (o < data.length) audio.rest = data.slice(o);
  }

  function onUnits(units) {
    for (const unit of units) {
      if (unit.kind === 'video') onVideo(unit);
      else onAudio(unit);
    }
  }

  async function flushChunk() {
    const c = chunk;
    if (!c.videoSamples && !c.audioFrames.length) return;
    chunk = { videoNals: [], videoSamples: 0, videoBytes: 0, audioFrames: [], audioBytes: 0 };
    const head = started ? 0 : FTYP.length + MDAT_HEADER_SIZE;
    const buf = new Uint8Array(head + c.videoBytes + c.audioBytes);
    const view = new DataView(buf.buffer);
    let o = 0;
    if (!started) {
      buf.set(FTYP, 0);
      buf.set(mdatHeader(0), FTYP.length); // 大小在 finish 时回填
      o = head;
      started = true;
    }
    for (const nal of c.videoNals) {
      view.setUint32(o, nal.length);
      buf.set(nal, o + 4);
      o += 4 + nal.length;
    }
    for (const frame of c.audioFrames) {
      buf.set(frame, o);
      o += frame.length;
    }
    if (c.videoSamples) video.track.addChunk(offset, c.videoSamples);
    if (c.audioFrames.length) audio.track.addChunk(offset + c.videoBytes, c.audioFrames.length);
    offset += c.videoBytes + c.audioBytes;
    dataBytes += c.videoBytes + c.audioBytes;
    await write(buf);
  }

  return {
    get started() {
      return started;
    },
    warnings,
    async push(data) {
      bytesIn += data.length;
      const units = demux.push(data);
      checkStreams();
      if (!checked) return;
      onUnits(units);
      await flushChunk();
    },
    async finish() {
      const units = demux.flush();
      bytesIn = Math.max(bytesIn, PMT_DEADLINE);
      checkStreams();
      onUnits(units);
      await flushChunk();
      if (!started) throw new RemuxError('没有解析到任何音视频帧，无法生成 MP4');
      warnings.corrupt += demux.errors + demux.resyncs;
      const tracks = [];
      if (video.track) {
        if (!video.sps || !video.pps.size) throw new RemuxError('视频流中没有 SPS/PPS 参数集，无法生成 MP4');
        video.track.close(3600);
        video.track.codec = { sps: video.sps, pps: [...video.pps.values()], info: video.info };
        video.track.mediaTime = video.firstCts;
        tracks.push({ track: video.track, start: video.firstPts });
      }
      if (audio.track) {
        audio.track.close(1024);
        const { sampleRate, channelConfig } = audio.codec;
        const seconds = audio.track.duration / sampleRate;
        audio.track.codec = {
          config: audioSpecificConfig(audio.codec),
          channels: CHANNELS[channelConfig],
          sampleRate,
          bitrate: seconds ? Math.round((audio.bytes * 8) / seconds) : 0,
        };
        audio.track.mediaTime = 0;
        tracks.push({ track: audio.track, start: audio.base });
      }
      // 各轨道首帧的显示时间相对最早一条轨道的偏移，用 elst 空白编辑保持音画同步。
      const t0 = Math.min(...tracks.map((t) => t.start));
      tracks.forEach(({ track, start }, i) => {
        track.id = i + 1;
        track.emptyEdit = Math.round(((start - t0) * track.timescale) / 90000);
      });
      const moov = buildMoov(tracks.map((t) => t.track));
      await write(moov);
      await writeAt(FTYP.length, mdatHeader(dataBytes));
      const duration = Math.max(...tracks.map(({ track }) => (track.emptyEdit + track.duration) / track.timescale));
      return {
        format: 'mp4',
        bytes: FTYP.length + MDAT_HEADER_SIZE + dataBytes + moov.length,
        duration,
        video: video.track ? { frames: video.track.count, width: video.info.width, height: video.info.height } : null,
        audio: audio.track ? { frames: audio.track.count, sampleRate: audio.codec.sampleRate, channels: CHANNELS[audio.codec.channelConfig] } : null,
        warnings: { ...warnings },
      };
    },
  };
}

export const isMp4Filename = (name) => /\.mp4$/i.test(String(name));

/**
 * 按文件名选择输出方式：.mp4 转封装，其它保持原始 TS。
 * onFallback(error) => Promise<sink>：编码无法无损封装时提供一个新的 TS 文件流（批量模式）；不提供则直接报错。
 * 返回 { write(tsBytes), finish() => { format, ... }, format }。
 */
export function createOutput({ filename, sink, onFallback }) {
  if (!isMp4Filename(filename)) {
    return { format: 'ts', write: (data) => sink.write(data), finish: async () => ({ format: 'ts' }) };
  }
  let target = sink;
  let fallback = null;
  let pending = []; // 编码确认前已输入的 TS（最多约 1 个分片），回退时原样写入新文件
  const remuxer = createMp4Remuxer({ write: (d) => target.write(d), writeAt: (p, d) => target.writeAt(p, d) });
  return {
    get format() {
      return fallback ? 'ts' : 'mp4';
    },
    async write(data) {
      if (fallback) return target.write(data);
      try {
        await remuxer.push(data);
        if (remuxer.started) pending = null;
        else pending.push(data);
      } catch (error) {
        if (!error.unsupported || !onFallback) throw error;
        target = await onFallback(error);
        fallback = error;
        for (const d of [...pending, data]) await target.write(d);
        pending = null;
      }
    },
    async finish() {
      if (fallback) return { format: 'ts', fallback };
      try {
        return await remuxer.finish();
      } catch (error) {
        if (!error.unsupported || !onFallback || !pending) throw error;
        target = await onFallback(error);
        fallback = error;
        for (const d of pending) await target.write(d);
        pending = null;
        return { format: 'ts', fallback };
      }
    },
  };
}
