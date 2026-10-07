// MPEG-TS 解复用：188 字节包、PAT/PMT、PES 组装。按任意大小的块增量输入，只缓存跨块的半个包和未结束的 PES。

export const PACKET = 188;

/** PMT stream_type → 说明。只有 H.264 和 ADTS AAC 可以无损放进本工具生成的 MP4。 */
export const STREAM_TYPE_NAMES = {
  0x01: 'MPEG-1 视频',
  0x02: 'MPEG-2 视频',
  0x03: 'MPEG-1 音频（MP3）',
  0x04: 'MPEG-2 音频（MP3）',
  0x06: '私有 PES 数据（可能是 AC-3 或字幕）',
  0x0f: 'AAC（ADTS）',
  0x10: 'MPEG-4 Part 2 视频',
  0x11: 'AAC（LATM）',
  0x1b: 'H.264/AVC',
  0x24: 'H.265/HEVC',
  0x42: 'AVS 视频',
  0x81: 'AC-3',
  0x87: 'E-AC-3',
  0xea: 'VC-1',
};
export const SUPPORTED_STREAM_TYPES = { 0x1b: 'video', 0x0f: 'audio' };
// 私有 section、ID3 时间元数据、SCTE-35 不含音视频，丢弃不影响画面和声音。
export const IGNORED_STREAM_TYPES = new Set([0x05, 0x15, 0x86]);

export const streamTypeName = (type) => STREAM_TYPE_NAMES[type] || `未知类型 0x${type.toString(16).padStart(2, '0')}`;

function concat(parts, size) {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 33 位 PTS/DTS（90 kHz）。 */
function readTimestamp(b, o) {
  return (b[o] & 0x0e) * 536870912 + b[o + 1] * 4194304 + (b[o + 2] & 0xfe) * 16384 + b[o + 3] * 128 + (b[o + 4] >> 1);
}

export class TsDemuxer {
  constructor() {
    this.carry = null; // 跨块的半个包
    this.pmtPid = -1;
    this.streams = null; // [{ pid, type, kind }]，kind: 'video' | 'audio' | 'ignored' | 'unsupported'
    this.signature = '';
    this.kinds = new Map(); // pid -> 'video' | 'audio'
    this.sections = new Map();
    this.pes = new Map();
    this.packets = 0;
    this.resyncs = 0;
    this.errors = 0;
  }

  /** 输入一块 TS 字节，返回在这块中结束的 PES：[{ pid, kind, pts, dts, data }]。 */
  push(chunk) {
    const out = [];
    let i = 0;
    if (this.carry) {
      const need = PACKET - this.carry.length;
      if (chunk.length < need) {
        this.carry = concat([this.carry, chunk], this.carry.length + chunk.length);
        return out;
      }
      const packet = concat([this.carry, chunk.subarray(0, need)], PACKET);
      this.carry = null;
      if (chunk.length === need || chunk[need] === 0x47) {
        this.packet(packet, 0, out);
        i = need;
      } else {
        this.resyncs++; // 拼出的包后面不是同步字节，丢弃该包并重新寻找同步
      }
    }
    const n = chunk.length;
    while (i < n) {
      if (chunk[i] !== 0x47) {
        const j = this.resync(chunk, i);
        if (j < 0) break;
        i = j;
      }
      if (i + PACKET > n) {
        this.carry = chunk.slice(i);
        break;
      }
      this.packet(chunk, i, out);
      i += PACKET;
    }
    return out;
  }

  /** 输入结束：输出所有未结束的 PES。 */
  flush() {
    const out = [];
    for (const [pid, s] of this.pes) this.emit(pid, s, out);
    this.pes.clear();
    this.carry = null;
    return out;
  }

  resync(chunk, i) {
    this.resyncs++;
    for (let j = i + 1; j < chunk.length; j++) {
      if (chunk[j] === 0x47 && (j + PACKET >= chunk.length || chunk[j + PACKET] === 0x47)) return j;
    }
    return -1;
  }

  packet(d, off, out) {
    this.packets++;
    if (d[off + 1] & 0x80) {
      this.errors++; // transport_error_indicator
      return;
    }
    const pusi = (d[off + 1] & 0x40) !== 0;
    const pid = ((d[off + 1] & 0x1f) << 8) | d[off + 2];
    const afc = (d[off + 3] >> 4) & 3;
    let p = off + 4;
    if (afc & 2) p += 1 + d[off + 4];
    if (!(afc & 1) || p >= off + PACKET) return;
    const payload = d.subarray(p, off + PACKET);
    if (pid === 0) this.section(pid, pusi, payload, (s) => this.parsePat(s));
    else if (pid === this.pmtPid) this.section(pid, pusi, payload, (s) => this.parsePmt(s));
    else if (this.kinds.has(pid)) this.pesPacket(pid, pusi, payload, out);
  }

  section(pid, pusi, payload, onSection) {
    let s = this.sections.get(pid);
    if (pusi) {
      const start = 1 + payload[0];
      if (start >= payload.length) return;
      s = { parts: [payload.subarray(start)], size: payload.length - start };
    } else if (s) {
      s.parts.push(payload);
      s.size += payload.length;
    } else {
      return;
    }
    const buf = concat(s.parts, s.size);
    if (buf.length >= 3) {
      const len = 3 + (((buf[1] & 0x0f) << 8) | buf[2]);
      if (buf.length >= len) {
        this.sections.delete(pid);
        onSection(buf.subarray(0, len));
        return;
      }
    }
    this.sections.set(pid, { parts: [buf], size: buf.length });
  }

  parsePat(s) {
    if (s[0] !== 0x00) return;
    for (let o = 8; o + 4 <= s.length - 4; o += 4) {
      const program = (s[o] << 8) | s[o + 1];
      if (program === 0) continue; // network PID
      this.pmtPid = ((s[o + 2] & 0x1f) << 8) | s[o + 3];
      return;
    }
  }

  parsePmt(s) {
    if (s[0] !== 0x02) return;
    const end = s.length - 4;
    const streams = [];
    for (let o = 12 + (((s[10] & 0x0f) << 8) | s[11]); o + 5 <= end; ) {
      const type = s[o];
      const pid = ((s[o + 1] & 0x1f) << 8) | s[o + 2];
      const kind = SUPPORTED_STREAM_TYPES[type] || (IGNORED_STREAM_TYPES.has(type) ? 'ignored' : 'unsupported');
      streams.push({ pid, type, kind });
      o += 5 + (((s[o + 3] & 0x0f) << 8) | s[o + 4]);
    }
    const signature = streams.map((x) => `${x.pid}:${x.type}`).join(',');
    if (this.streams) {
      if (signature !== this.signature) {
        const err = new Error('录像中途改变了音视频流结构（PMT），无法无损封装为单个 MP4');
        err.fatal = true;
        throw err;
      }
      return;
    }
    this.streams = streams;
    this.signature = signature;
    for (const x of streams) if (x.kind === 'video' || x.kind === 'audio') this.kinds.set(x.pid, x.kind);
  }

  pesPacket(pid, pusi, payload, out) {
    let s = this.pes.get(pid);
    if (pusi) {
      if (s) this.emit(pid, s, out);
      const len = payload.length >= 6 ? (payload[4] << 8) | payload[5] : 0;
      s = { parts: [], size: 0, expected: len ? len + 6 : 0 };
      this.pes.set(pid, s);
    } else if (!s) {
      return; // 没有起点的 PES 片段（例如从流中间开始）
    }
    s.parts.push(payload);
    s.size += payload.length;
    if (s.expected && s.size >= s.expected) {
      this.pes.delete(pid);
      this.emit(pid, s, out);
    }
  }

  emit(pid, s, out) {
    if (!s.size) return;
    // 音频 PES 有固定长度，视频 PES 长度为 0（到下一个 PES 起点结束）。跨块的部分是对输入块的引用，最多保留一个块。
    const buf = concat(s.parts, s.size);
    if (buf.length < 9 || buf[0] !== 0 || buf[1] !== 0 || buf[2] !== 1) {
      this.errors++;
      return;
    }
    const flags = buf[7];
    const pts = flags & 0x80 ? readTimestamp(buf, 9) : null;
    const dts = flags & 0x40 ? readTimestamp(buf, 14) : pts;
    const end = s.expected ? Math.min(s.expected, buf.length) : buf.length;
    out.push({ pid, kind: this.kinds.get(pid), pts, dts, data: buf.subarray(9 + buf[8], end) });
  }
}
