// HLS 播放列表：m3u8 解析、EXT-X-KEY、IV、码率选择、加密方式检查。纯函数。

const tagValue = (line) => line.slice(line.indexOf(':') + 1);

export function parseAttributes(str) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) attrs[m[1]] = m[2].replace(/^"|"$/g, '');
  return attrs;
}

export function parseHexIV(hex) {
  const h = String(hex).replace(/^0x/i, '');
  if (!/^[0-9a-f]{1,32}$/i.test(h)) throw new Error(`无效的 IV：${hex}`);
  const padded = h.padStart(32, '0');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(padded.substr(i * 2, 2), 16);
  return out;
}

/** 无显式 IV 时：IV = 分片的 media sequence number，128-bit big-endian。 */
export function ivForSequence(seq) {
  const out = new Uint8Array(16);
  let n = BigInt(seq);
  for (let i = 15; i >= 0 && n > 0n; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/**
 * 解析 m3u8。
 * master：{ type: 'master', variants: [{ uri, bandwidth, resolution }] }
 * media： { type: 'media', mediaSequence, endList, segments: [{ uri, duration, seq, key }] }
 *         key = null | { method, uri, iv: Uint8Array | null, keyformat }
 */
export function parseM3U8(text, baseUrl) {
  const lines = String(text)
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('不是有效的 m3u8 播放列表（登录可能已失效）');

  let mediaSequence = 0;
  let key = null;
  let duration = null;
  let variant = null;
  let endList = false;
  const segments = [];
  const variants = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(tagValue(line), 10) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(tagValue(line));
      const method = (a.METHOD || 'NONE').toUpperCase();
      key =
        method === 'NONE'
          ? null
          : {
              method,
              uri: a.URI ? new URL(a.URI, baseUrl).href : null,
              iv: a.IV ? parseHexIV(a.IV) : null,
              keyformat: a.KEYFORMAT || 'identity',
            };
    } else if (line.startsWith('#EXTINF:')) {
      duration = parseFloat(tagValue(line));
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributes(tagValue(line));
      variant = { bandwidth: Number(a.BANDWIDTH) || 0, resolution: a.RESOLUTION || '' };
    } else if (line.startsWith('#EXT-X-BYTERANGE') || line.startsWith('#EXT-X-MAP')) {
      throw new Error(`暂不支持 ${line.split(':')[0]}`);
    } else if (line === '#EXT-X-ENDLIST') {
      endList = true;
    } else if (!line.startsWith('#')) {
      const uri = new URL(line, baseUrl).href;
      if (variant) {
        variants.push({ ...variant, uri });
        variant = null;
      } else {
        segments.push({ uri, duration, seq: mediaSequence + segments.length, key });
        duration = null;
      }
    }
  }
  if (variants.length) return { type: 'master', variants };
  return { type: 'media', mediaSequence, endList, segments };
}

export function pickVariant(variants) {
  return variants.reduce((best, v) => (v.bandwidth > best.bandwidth ? v : best), variants[0]);
}

/** 只接受标准 AES-128（identity key）；其它方案多为 DRM，不处理。 */
export function assertSupported(segments) {
  for (const seg of segments) {
    const k = seg.key;
    if (!k) continue;
    if (k.method !== 'AES-128' || String(k.keyformat).toLowerCase() !== 'identity') {
      throw new Error(
        `不支持的加密方式 ${k.method}${k.keyformat !== 'identity' ? ` / ${k.keyformat}` : ''}（可能是 DRM 保护，本工具不处理）`,
      );
    }
    if (!k.uri) throw new Error('EXT-X-KEY 缺少 URI');
  }
}
