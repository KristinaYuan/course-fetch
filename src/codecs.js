// 编码层解析：H.264 Annex B / SPS、AAC ADTS。只读取封装 MP4 所需的参数，不解码画面或声音。纯函数。

/** 按起始码 00 00 01 / 00 00 00 01 切分 NAL，返回 subarray（不复制）。尾随的 0 字节属于下一个 4 字节起始码。 */
export function splitAnnexB(data) {
  const nals = [];
  const n = data.length;
  let start = -1;
  let i = 0;
  while (i + 2 < n) {
    if (data[i + 2] > 1) {
      i += 3;
    } else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) pushNal(nals, data, start, i);
      start = i + 3;
      i += 3;
    } else {
      i++;
    }
  }
  if (start >= 0) pushNal(nals, data, start, n);
  return nals;
}

function pushNal(nals, data, start, end) {
  while (end > start && data[end - 1] === 0) end--;
  if (end > start) nals.push(data.subarray(start, end));
}

/** 去掉防竞争字节（00 00 03 → 00 00），得到 RBSP。 */
function unescapeRbsp(nal) {
  const out = new Uint8Array(nal.length);
  let n = 0;
  let zeros = 0;
  for (let i = 0; i < nal.length; i++) {
    const byte = nal[i];
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out[n++] = byte;
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, n);
}

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }
  u(bits) {
    let v = 0;
    for (let i = 0; i < bits; i++) {
      const byte = this.bytes[this.pos >> 3];
      if (byte === undefined) throw new Error('SPS 数据不完整');
      v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
  ue() {
    let zeros = 0;
    while (this.u(1) === 0) if (++zeros > 31) throw new Error('SPS 中的 Exp-Golomb 数值无效');
    return 2 ** zeros - 1 + this.u(zeros);
  }
  se() {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -k / 2;
  }
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/** 解析 H.264 SPS（含 NAL 头）。返回 avcC 和 avc1 sample entry 需要的字段。 */
export function parseSps(nal) {
  const r = new BitReader(unescapeRbsp(nal.subarray(1)));
  const profileIdc = r.u(8);
  const constraintFlags = r.u(8);
  const levelIdc = r.u(8);
  r.ue(); // seq_parameter_set_id
  let chromaFormatIdc = 1;
  let separateColourPlane = 0;
  let bitDepthLuma = 8;
  let bitDepthChroma = 8;
  if (HIGH_PROFILES.has(profileIdc)) {
    chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) separateColourPlane = r.u(1);
    bitDepthLuma = r.ue() + 8;
    bitDepthChroma = r.ue() + 8;
    r.u(1); // qpprime_y_zero_transform_bypass_flag
    if (r.u(1)) {
      for (let i = 0; i < (chromaFormatIdc !== 3 ? 8 : 12); i++) {
        if (!r.u(1)) continue;
        const size = i < 6 ? 16 : 64;
        let last = 8;
        let next = 8;
        for (let j = 0; j < size; j++) {
          if (next !== 0) next = (last + r.se() + 256) % 256;
          last = next === 0 ? last : next;
        }
      }
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) {
    r.u(1);
    r.se();
    r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.u(1); // gaps_in_frame_num_value_allowed_flag
  const widthMbs = r.ue() + 1;
  const heightMapUnits = r.ue() + 1;
  const frameMbsOnly = r.u(1);
  if (!frameMbsOnly) r.u(1); // mb_adaptive_frame_field_flag
  r.u(1); // direct_8x8_inference_flag
  let crop = [0, 0, 0, 0];
  if (r.u(1)) crop = [r.ue(), r.ue(), r.ue(), r.ue()];
  const chroma = separateColourPlane ? 0 : chromaFormatIdc;
  const cropX = chroma === 1 || chroma === 2 ? 2 : 1;
  const cropY = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
  return {
    profileIdc,
    constraintFlags,
    levelIdc,
    chromaFormatIdc,
    bitDepthLuma,
    bitDepthChroma,
    highProfile: HIGH_PROFILES.has(profileIdc),
    width: widthMbs * 16 - cropX * (crop[0] + crop[1]),
    height: (2 - frameMbsOnly) * heightMapUnits * 16 - cropY * (crop[2] + crop[3]),
  };
}

/** PPS 的 pic_parameter_set_id（用于判断同一 id 的 PPS 是否在中途改变）。 */
export function ppsId(nal) {
  return new BitReader(unescapeRbsp(nal.subarray(1, 8))).ue();
}

export const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** 解析 offset 处的 ADTS 头；不是 ADTS 同步字时返回 null。 */
export function parseAdtsHeader(b, o) {
  if (o + 7 > b.length || b[o] !== 0xff || (b[o + 1] & 0xf6) !== 0xf0) return null;
  const sampleRateIndex = (b[o + 2] >> 2) & 0x0f;
  return {
    headerLength: b[o + 1] & 1 ? 7 : 9,
    frameLength: ((b[o + 3] & 0x03) << 11) | (b[o + 4] << 3) | (b[o + 5] >> 5),
    objectType: (b[o + 2] >> 6) + 1,
    sampleRateIndex,
    sampleRate: AAC_SAMPLE_RATES[sampleRateIndex] || 0,
    channelConfig: ((b[o + 2] & 0x01) << 2) | (b[o + 3] >> 6),
    rawBlocks: b[o + 6] & 0x03,
  };
}

/** MPEG-4 AudioSpecificConfig（esds 中的 DecoderSpecificInfo）。 */
export function audioSpecificConfig({ objectType, sampleRateIndex, channelConfig }) {
  return new Uint8Array([(objectType << 3) | (sampleRateIndex >> 1), ((sampleRateIndex & 1) << 7) | (channelConfig << 3)]);
}
