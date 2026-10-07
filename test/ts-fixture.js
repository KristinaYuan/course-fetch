// 测试用合成 MPEG-TS：PAT/PMT + H.264（真实 1080p SPS/PPS、B 帧重排序）+ ADTS AAC-LC 48 kHz 立体声。
// 帧内容是带编号的假数据，只用于验证转封装（不解码）。

const hex = (s) => Uint8Array.from(s.match(/../g), (b) => parseInt(b, 16));
// 取自真实课堂录像（H.264 High@4.0，1920×1080）
export const SPS = hex('67640028acec0780227e5840000003004000000ca3c60c4e');
export const PPS = hex('68efbcb0');
// 与 SPS 字节不同（只用于验证“参数集中途改变”的检测，不会被解析）
export const SPS_CHANGED = Uint8Array.from([...SPS.subarray(0, -1), 0x4d]);
const AUD = hex('09f0');

const VIDEO_PID = 0x100;
const AUDIO_PID = 0x101;
const PMT_PID = 0x1000;
const WRAP = 2 ** 33;

let CRC_TABLE;
function crc32mpeg(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i << 24;
      for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
      CRC_TABLE[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  return crc;
}

function section(body) {
  const crc = crc32mpeg(body);
  return Uint8Array.from([...body, crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff]);
}

function pat() {
  const len = 13;
  return section([0x00, 0xb0, len, 0x00, 0x01, 0xc1, 0, 0, 0x00, 0x01, 0xe0 | (PMT_PID >> 8), PMT_PID & 0xff]);
}

function pmt(streams) {
  const es = streams.flatMap(([type, pid]) => [type, 0xe0 | (pid >> 8), pid & 0xff, 0xf0, 0x00]);
  const len = 9 + es.length + 4;
  return section([0x02, 0xb0, len, 0x00, 0x01, 0xc1, 0, 0, 0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 0xff, 0xf0, 0x00, ...es]);
}

function timestamp(prefix, ts) {
  ts = ((ts % WRAP) + WRAP) % WRAP;
  const hi = Math.floor(ts / 2 ** 30) & 7;
  const lo = ts % 2 ** 30;
  return [(prefix << 4) | (hi << 1) | 1, (lo >>> 22) & 0xff, (((lo >>> 15) & 0x7f) << 1) | 1, (lo >>> 7) & 0xff, ((lo & 0x7f) << 1) | 1];
}

function pes(streamId, payload, pts, dts, bounded) {
  const ts = dts !== undefined && dts !== pts ? [...timestamp(3, pts), ...timestamp(1, dts)] : timestamp(2, pts);
  const flags = ts.length === 10 ? 0xc0 : 0x80;
  const headerRest = 3 + ts.length;
  const len = bounded ? headerRest + payload.length : 0;
  const out = new Uint8Array(9 + ts.length + payload.length);
  out.set([0, 0, 1, streamId, len >> 8, len & 0xff, 0x80, flags, ts.length, ...ts]);
  out.set(payload, 9 + ts.length);
  return out;
}

class Packetizer {
  constructor() {
    this.cc = new Map();
    this.packets = [];
  }
  put(pid, data, isSection) {
    if (isSection) data = Uint8Array.from([0, ...data]); // pointer_field
    for (let o = 0, first = true; o < data.length || first; first = false) {
      const pkt = new Uint8Array(188).fill(0xff);
      const cc = this.cc.get(pid) || 0;
      this.cc.set(pid, (cc + 1) & 15);
      pkt[0] = 0x47;
      pkt[1] = (first ? 0x40 : 0) | (pid >> 8);
      pkt[2] = pid & 0xff;
      const remaining = data.length - o;
      if (remaining >= 184 || isSection) {
        pkt[3] = 0x10 | cc;
        const n = Math.min(184, remaining);
        pkt.set(data.subarray(o, o + n), 4);
        o += n;
      } else {
        pkt[3] = 0x30 | cc; // adaptation field 填充
        const af = 183 - remaining;
        pkt[4] = af;
        if (af > 0) pkt[5] = 0x00;
        pkt.set(data.subarray(o), 5 + af);
        o = data.length;
      }
      this.packets.push(pkt);
    }
  }
  take() {
    const out = new Uint8Array(this.packets.length * 188);
    this.packets.forEach((p, i) => out.set(p, i * 188));
    this.packets = [];
    return out;
  }
}

function adts(payload, { sampleRateIndex = 3, channels = 2 } = {}) {
  const len = payload.length + 7;
  const out = new Uint8Array(len);
  out.set([0xff, 0xf1, (1 << 6) | (sampleRateIndex << 2) | (channels >> 2), ((channels & 3) << 6) | (len >> 11), (len >> 3) & 0xff, ((len & 7) << 5) | 0x1f, 0xfc]);
  out.set(payload, 7);
  return out;
}

/** 带编号的假帧负载：第一个字节为 NAL 头，之后 4 字节编码帧号（每字节最高位为 1，不含 0），长度随帧号变化。 */
function framePayload(nalHeader, id, size) {
  const out = new Uint8Array(size);
  out[0] = nalHeader;
  for (let j = 0; j < 4; j++) out[1 + j] = ((id >> (7 * j)) & 0x7f) | 0x80;
  for (let i = 5; i < size; i++) out[i] = (id * 31 + i) % 251 + 1; // 不含 0，避免伪起始码
  return out;
}

/**
 * 生成 HLS 风格的分片：每个分片以 PAT/PMT + IDR 开头。
 * 返回 { segments: Uint8Array[], video: [{ nals, pts, dts, key }], audio: [{ data, pts }] }，video/audio 为期望的输出帧。
 */
export function makeTs({
  segments = 3,
  framesPerSegment = 6,
  videoType = 0x1b,
  audioType = 0x0f,
  audio = true,
  startPts = 126000,
  audioLead = 1530, // 音频比视频早 17 ms，与真实录像一致
  sps = SPS,
  spsAt = () => sps,
  dtsOffset = () => 0,
} = {}) {
  const pk = new Packetizer();
  const out = { segments: [], video: [], audio: [] };
  const streams = [[videoType, VIDEO_PID]];
  if (audio) streams.push([audioType, AUDIO_PID]);
  const order = [0, 2, 1]; // 解码顺序中的显示序号偏移：I/P 在前，B 在后
  let audioIndex = 0;
  for (let s = 0; s < segments; s++) {
    pk.put(0, pat(), true);
    pk.put(PMT_PID, pmt(streams), true);
    for (let f = 0; f < framesPerSegment; f++) {
      const k = s * framesPerSegment + f;
      const g = Math.floor(f / 3) * 3 + order[f % 3];
      const dts = startPts - 3600 + k * 3600 + dtsOffset(s);
      const pts = startPts + (s * framesPerSegment + g) * 3600 + dtsOffset(s);
      const key = f === 0;
      const nals = key ? [spsAt(s), PPS, framePayload(0x65, k, 300 + k)] : [framePayload(0x41, k, 120 + (k % 7) * 10)];
      const annexB = [];
      for (const [i, nal] of [AUD, ...nals].entries()) annexB.push(...(i < 2 ? [0, 0, 0, 1] : [0, 0, 1]), ...nal);
      pk.put(VIDEO_PID, pes(0xe0, Uint8Array.from(annexB), pts, dts, false));
      out.video.push({ nals, pts, dts, key });
      if (audio) {
        // 每帧视频（40 ms）约 1.875 帧 AAC（21.33 ms）；按时间把音频交错写入
        const frames = [];
        while ((audioIndex * 1024 * 90000) / 48000 < (k + 1) * 3600) {
          const data = framePayload(0x21, 1e6 + audioIndex, 40 + (audioIndex % 5));
          frames.push(adts(data));
          out.audio.push({ data, pts: startPts - audioLead + (audioIndex * 1024 * 90000) / 48000 + dtsOffset(s) });
          audioIndex++;
        }
        if (frames.length) {
          const first = out.audio[out.audio.length - frames.length];
          const body = new Uint8Array(frames.reduce((n, a) => n + a.length, 0));
          let o = 0;
          for (const a of frames) {
            body.set(a, o);
            o += a.length;
          }
          pk.put(AUDIO_PID, pes(0xc0, body, Math.round(first.pts), undefined, true));
        }
      }
    }
    out.segments.push(pk.take());
  }
  return out;
}

/** 把字节流按给定大小序列切块（循环使用 sizes）。 */
export function rechunk(segments, sizes) {
  const all = new Uint8Array(segments.reduce((n, s) => n + s.length, 0));
  let o = 0;
  for (const s of segments) {
    all.set(s, o);
    o += s.length;
  }
  const out = [];
  for (let i = 0, k = 0; i < all.length; k++) {
    const n = sizes[k % sizes.length];
    out.push(all.slice(i, i + n));
    i += n;
  }
  return out;
}

/** 内存中的可回填文件：write 追加，writeAt 覆盖。 */
export function memoryFile() {
  let buf = new Uint8Array(1 << 16);
  let size = 0;
  const ensure = (n) => {
    if (n <= buf.length) return;
    const next = new Uint8Array(Math.max(n, buf.length * 2));
    next.set(buf.subarray(0, size));
    buf = next;
  };
  return {
    writes: 0,
    write(data) {
      this.writes++;
      ensure(size + data.length);
      buf.set(data, size);
      size += data.length;
    },
    writeAt(position, data) {
      if (position + data.length > size) throw new Error('writeAt 超出已写范围');
      buf.set(data, position);
    },
    get bytes() {
      return buf.slice(0, size);
    },
  };
}
