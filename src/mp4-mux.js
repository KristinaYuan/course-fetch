// MP4（ISO BMFF）封装：普通 MP4，mdat 在前、moov 在末尾。只在内存中保留样本表（大小/时长/关键帧/chunk 偏移），
// 样本数据由调用方直接写盘。2 小时 1080p 录像约 50 万个样本，样本表约数 MB。

const UINT32 = 0x100000000;

// ---- 字节工具 ---------------------------------------------------------------------

/** 按需扩容的 Uint32 数组。 */
export class GrowU32 {
  constructor(capacity = 1024) {
    this.data = new Uint32Array(capacity);
    this.length = 0;
  }
  push(v) {
    if (this.length === this.data.length) {
      const next = new Uint32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
  get last() {
    return this.data[this.length - 1];
  }
  set last(v) {
    this.data[this.length - 1] = v;
  }
}

/** 游程编码表：[(count, value)]，用于 stts / ctts / stsc。 */
class RunTable {
  constructor() {
    this.counts = new GrowU32(64);
    this.values = new GrowU32(64);
  }
  add(value, count = 1) {
    if (this.counts.length && this.values.last === value >>> 0) this.counts.last += count;
    else {
      this.counts.push(count);
      this.values.push(value >>> 0);
    }
  }
  get length() {
    return this.counts.length;
  }
}

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function bytes(...fields) {
  // fields: [bits, value]，bits ∈ 8/16/24/32/64
  const size = fields.reduce((n, [bits]) => n + bits / 8, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let o = 0;
  for (const [bits, value] of fields) {
    if (bits === 8) view.setUint8(o, value);
    else if (bits === 16) view.setUint16(o, value);
    else if (bits === 24) {
      view.setUint8(o, (value >>> 16) & 0xff);
      view.setUint16(o + 1, value & 0xffff);
    } else if (bits === 32) view.setUint32(o, value >>> 0);
    else {
      view.setUint32(o, Math.floor(value / UINT32));
      view.setUint32(o + 4, value % UINT32);
    }
    o += bits / 8;
  }
  return out;
}
const u32 = (...values) => bytes(...values.map((v) => [32, v]));

export function box(type, ...parts) {
  const size = parts.reduce((n, p) => n + p.length, 8);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  out.set(ascii(type), 4);
  let o = 8;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const fullBox = (type, version, flags, ...parts) => box(type, bytes([8, version], [24, flags]), ...parts);

/** 把 GrowU32 的前 n 项按大端序写成字节。 */
function u32Array(...arrays) {
  const n = arrays[0].length;
  const out = new Uint8Array(n * 4 * arrays.length);
  const view = new DataView(out.buffer);
  let o = 0;
  for (let i = 0; i < n; i++) {
    for (const a of arrays) {
      view.setUint32(o, a.data[i]);
      o += 4;
    }
  }
  return out;
}

const MATRIX = u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);

// ---- 文件头 ------------------------------------------------------------------------

export const FTYP = box('ftyp', ascii('isom'), u32(0x200), ascii('isomiso2avc1mp41'));
export const MDAT_HEADER_SIZE = 16;

/** 64 位 mdat 头（size=1 + largesize），可容纳超过 4 GB 的录像。 */
export function mdatHeader(payloadSize) {
  return concatBytes(u32(1), ascii('mdat'), bytes([64, payloadSize + MDAT_HEADER_SIZE]));
}

function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---- 轨道 ------------------------------------------------------------------------

/**
 * 一条轨道的样本表。调用方保证 dts 严格递增（时间戳断点已在上层修正）。
 * kind: 'video' | 'audio'；timescale：视频 90000，音频为采样率。
 */
export class Track {
  constructor(kind, timescale) {
    this.kind = kind;
    this.timescale = timescale;
    this.sizes = new GrowU32();
    this.stts = new RunTable();
    this.ctts = new RunTable();
    this.hasCts = false;
    this.sync = new GrowU32(256);
    this.chunkOffsets = []; // 文件绝对偏移
    this.stsc = []; // [firstChunk, samplesPerChunk]
    this.lastDts = null;
    this.lastDuration = 0;
    this.duration = 0; // 媒体时长（timescale）
  }
  get count() {
    return this.sizes.length;
  }
  addSample(size, dts, cts, key) {
    if (this.lastDts !== null) {
      const d = dts - this.lastDts;
      if (!(d > 0)) throw new Error('内部错误：样本时间戳必须递增');
      this.stts.add(d);
      this.duration += d;
      this.lastDuration = d;
    }
    this.lastDts = dts;
    this.sizes.push(size);
    if (this.kind === 'video') {
      if (cts) this.hasCts = true;
      this.ctts.add(cts);
      if (key) this.sync.push(this.count);
    }
  }
  growLast(extra) {
    this.sizes.last += extra;
  }
  /** 一段连续写入的样本（本轨道上一次 addChunk 之后新增的样本）。 */
  addChunk(offset, samples) {
    if (!samples) return;
    this.chunkOffsets.push(offset);
    const last = this.stsc[this.stsc.length - 1];
    if (!last || last[1] !== samples) this.stsc.push([this.chunkOffsets.length, samples]);
  }
  /** 结束：最后一个样本沿用前一个时长（单样本时用 defaultDuration）。 */
  close(defaultDuration) {
    const d = this.lastDuration || defaultDuration;
    this.stts.add(d);
    this.duration += d;
  }
}

// ---- moov ----------------------------------------------------------------------

function sampleEntry(track) {
  if (track.kind === 'video') {
    const { sps, pps, info } = track.codec;
    const avcCParts = [
      bytes([8, 1], [8, info.profileIdc], [8, info.constraintFlags], [8, info.levelIdc], [8, 0xff], [8, 0xe0 | 1], [16, sps.length]),
      sps,
      bytes([8, pps.length]),
    ];
    for (const p of pps) avcCParts.push(bytes([16, p.length]), p);
    if (info.highProfile) {
      avcCParts.push(bytes([8, 0xfc | info.chromaFormatIdc], [8, 0xf8 | (info.bitDepthLuma - 8)], [8, 0xf8 | (info.bitDepthChroma - 8)], [8, 0]));
    }
    return box(
      'avc1',
      new Uint8Array(6),
      bytes([16, 1], [16, 0], [16, 0], [32, 0], [32, 0], [32, 0], [16, info.width], [16, info.height]),
      u32(0x480000, 0x480000, 0),
      bytes([16, 1]),
      new Uint8Array(32), // compressorname
      bytes([16, 0x18], [16, 0xffff]),
      box('avcC', ...avcCParts),
    );
  }
  const { config, channels, sampleRate } = track.codec;
  const descriptor = (tag, ...parts) => {
    const body = concatBytes(...parts);
    return concatBytes(bytes([8, tag], [8, body.length]), body);
  };
  const esds = fullBox(
    'esds', 0, 0,
    descriptor(
      0x03,
      bytes([16, track.id], [8, 0]),
      descriptor(0x04, bytes([8, 0x40], [8, 0x15], [24, 0], [32, track.codec.bitrate], [32, track.codec.bitrate]), descriptor(0x05, config)),
      descriptor(0x06, bytes([8, 0x02])),
    ),
  );
  return box(
    'mp4a',
    new Uint8Array(6),
    bytes([16, 1], [32, 0], [32, 0], [16, channels], [16, 16], [16, 0], [16, 0], [32, sampleRate <= 0xffff ? sampleRate * 0x10000 : 0]),
    esds,
  );
}

function sampleTable(track) {
  const parts = [fullBox('stsd', 0, 0, u32(1), sampleEntry(track)), fullBox('stts', 0, 0, u32(track.stts.length), u32Array(track.stts.counts, track.stts.values))];
  if (track.hasCts) parts.push(fullBox('ctts', 0, 0, u32(track.ctts.length), u32Array(track.ctts.counts, track.ctts.values)));
  if (track.kind === 'video' && track.sync.length < track.count) {
    parts.push(fullBox('stss', 0, 0, u32(track.sync.length), u32Array(track.sync)));
  }
  parts.push(fullBox('stsz', 0, 0, u32(0, track.count), u32Array(track.sizes)));
  parts.push(fullBox('stsc', 0, 0, u32(track.stsc.length), ...track.stsc.map(([first, n]) => u32(first, n, 1))));
  const offsets = track.chunkOffsets;
  if (offsets.length && offsets[offsets.length - 1] >= UINT32) {
    parts.push(fullBox('co64', 0, 0, u32(offsets.length), bytes(...offsets.map((o) => [64, o]))));
  } else {
    parts.push(fullBox('stco', 0, 0, u32(offsets.length, ...offsets)));
  }
  return box('stbl', ...parts);
}

/** 时长字段超过 32 位时用 version 1。 */
const timeFields = (duration) => (duration >= UINT32 ? [1, [64, 0], [64, 0]] : [0, [32, 0], [32, 0]]);
const durationField = (version, d) => (version ? [64, d] : [32, d]);

function trak(track, movieTimescale) {
  const movieDuration = Math.round(((track.emptyEdit + track.duration) / track.timescale) * movieTimescale);
  const [tv, ...tTimes] = timeFields(movieDuration);
  const tkhd = fullBox(
    'tkhd', tv, 3,
    bytes(...tTimes, [32, track.id], [32, 0], durationField(tv, movieDuration), [32, 0], [32, 0], [16, 0], [16, 0], [16, track.kind === 'audio' ? 0x100 : 0], [16, 0]),
    MATRIX,
    u32(track.kind === 'video' ? track.codec.info.width * 0x10000 : 0, track.kind === 'video' ? track.codec.info.height * 0x10000 : 0),
  );
  const edits = [];
  const empty = Math.round((track.emptyEdit / track.timescale) * movieTimescale);
  if (empty > 0) edits.push(u32(empty, 0xffffffff, 0x10000));
  edits.push(u32(Math.round((track.duration / track.timescale) * movieTimescale), track.mediaTime, 0x10000));
  const [mv, ...mTimes] = timeFields(track.duration);
  const mdhd = fullBox('mdhd', mv, 0, bytes(...mTimes, [32, track.timescale], durationField(mv, track.duration), [16, 0x55c4], [16, 0]));
  const handler = track.kind === 'video' ? ['vide', 'VideoHandler'] : ['soun', 'SoundHandler'];
  const hdlr = fullBox('hdlr', 0, 0, u32(0), ascii(handler[0]), u32(0, 0, 0), ascii(`${handler[1]}\0`));
  const mediaHeader = track.kind === 'video' ? fullBox('vmhd', 0, 1, new Uint8Array(8)) : fullBox('smhd', 0, 0, new Uint8Array(4));
  const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
  return box(
    'trak',
    tkhd,
    box('edts', fullBox('elst', 0, 0, u32(edits.length), ...edits)),
    box('mdia', mdhd, hdlr, box('minf', mediaHeader, dinf, sampleTable(track))),
  );
}

/**
 * tracks：带 id、codec、emptyEdit（轨道开始前的空白，单位为轨道 timescale）、mediaTime（elst 起点，视频为首帧 CTS）。
 */
export function buildMoov(tracks, movieTimescale = 1000) {
  const traks = tracks.map((t) => trak(t, movieTimescale));
  const duration = Math.max(...tracks.map((t) => Math.round(((t.emptyEdit + t.duration) / t.timescale) * movieTimescale)));
  const [v, ...times] = timeFields(duration);
  const mvhd = fullBox(
    'mvhd', v, 0,
    bytes(...times, [32, movieTimescale], durationField(v, duration), [32, 0x10000], [16, 0x100], [16, 0], [32, 0], [32, 0]),
    MATRIX,
    new Uint8Array(24),
    u32(Math.max(...tracks.map((t) => t.id)) + 1),
  );
  return box('moov', mvhd, ...traks);
}
