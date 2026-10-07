// 测试用 MP4 读取：解析 box 树和样本表，按 stco/stsc/stsz 还原每个样本的字节，用于校验转封装结果。

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf']);

export function readBoxes(buf, start = 0, end = buf.length) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const boxes = [];
  for (let o = start; o < end; ) {
    let size = view.getUint32(o);
    const type = String.fromCharCode(...buf.subarray(o + 4, o + 8));
    let header = 8;
    if (size === 1) {
      size = view.getUint32(o + 8) * 2 ** 32 + view.getUint32(o + 12);
      header = 16;
    }
    if (size < header || o + size > end) throw new Error(`box ${type} 大小无效：${size}`);
    const b = { type, start: o, size, body: buf.subarray(o + header, o + size) };
    if (CONTAINERS.has(type)) b.children = readBoxes(buf, o + header, o + size);
    boxes.push(b);
    o += size;
  }
  return boxes;
}

export const find = (boxes, path) => {
  let list = boxes;
  let found = null;
  for (const type of path.split('/')) {
    found = list.find((b) => b.type === type);
    if (!found) return null;
    list = found.children || [];
  }
  return found;
};

const u32 = (b, o) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o);
const i32 = (b, o) => new DataView(b.buffer, b.byteOffset, b.byteLength).getInt32(o);

function table(box, width, offset = 8) {
  if (!box) return null;
  const n = u32(box.body, 4);
  const out = [];
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let j = 0; j < width; j++) row.push(u32(box.body, offset + (i * width + j) * 4));
    out.push(row);
  }
  return out;
}

export function readTrack(file, trak) {
  const stbl = find(trak.children, 'mdia/minf/stbl');
  const get = (t) => stbl.children.find((b) => b.type === t);
  const mdhd = find(trak.children, 'mdia/mdhd').body;
  const handler = String.fromCharCode(...find(trak.children, 'mdia/hdlr').body.subarray(8, 12));
  const stsz = get('stsz').body;
  const sizes = [];
  for (let i = 0; i < u32(stsz, 8); i++) sizes.push(u32(stsz, 12 + i * 4));
  const durations = table(get('stts'), 2).flatMap(([n, d]) => Array(n).fill(d));
  const ctts = get('ctts') ? table(get('ctts'), 2).flatMap(([n, d]) => Array(n).fill(d)) : sizes.map(() => 0);
  const stss = get('stss') ? table(get('stss'), 1).map(([n]) => n) : null;
  let offsets;
  if (get('co64')) {
    const b = get('co64').body;
    offsets = [];
    for (let i = 0; i < u32(b, 4); i++) offsets.push(u32(b, 8 + i * 8) * 2 ** 32 + u32(b, 12 + i * 8));
  } else offsets = table(get('stco'), 1).map(([o]) => o);
  const stsc = table(get('stsc'), 3);
  const samples = [];
  let s = 0;
  offsets.forEach((offset, i) => {
    const chunk = i + 1;
    const entry = [...stsc].reverse().find(([first]) => first <= chunk);
    let o = offset;
    for (let k = 0; k < entry[1]; k++, s++) {
      samples.push(file.subarray(o, o + sizes[s]));
      o += sizes[s];
    }
  });
  const elstBox = find(trak.children, 'edts/elst');
  const elst = [];
  if (elstBox) for (let i = 0; i < u32(elstBox.body, 4); i++) elst.push([u32(elstBox.body, 8 + i * 12), i32(elstBox.body, 12 + i * 12)]);
  const entry = get('stsd').children ? null : get('stsd').body.subarray(8);
  const version = mdhd[0];
  return {
    handler,
    timescale: u32(mdhd, version ? 20 : 12),
    duration: version ? u32(mdhd, 24) * 2 ** 32 + u32(mdhd, 28) : u32(mdhd, 16),
    sizes, durations, ctts, stss, offsets, samples, elst,
    sampleEntry: entry,
    co64: !!get('co64'),
  };
}

export function readMp4(file) {
  const boxes = readBoxes(file);
  const moov = find(boxes, 'moov');
  return {
    boxes,
    types: boxes.map((b) => b.type),
    mdat: boxes.find((b) => b.type === 'mdat'),
    tracks: moov.children.filter((b) => b.type === 'trak').map((t) => readTrack(file, t)),
  };
}

/** 把 AVCC（4 字节长度前缀）样本拆成 NAL 列表。 */
export function avccNals(sample) {
  const out = [];
  for (let o = 0; o < sample.length; ) {
    const n = u32(sample, o);
    out.push(sample.subarray(o + 4, o + 4 + n));
    o += 4 + n;
  }
  return out;
}

export const indexOfBytes = (hay, needle) => {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
};
