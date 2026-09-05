/**
 * 纯 JS 实现的 UTF-8 编码 + SHA-1 哈希。
 *
 * 为什么需要这个文件：
 *   PR UXP 运行时既没有全局 TextEncoder，也不支持 crypto.subtle.digest。
 *   原本的 `new TextEncoder().encode(value)` + `crypto.subtle.digest('SHA-1', ...)`
 *   在字幕批量配音时直接抛 ReferenceError: TextEncoder is not defined。
 *
 *   试听功能能用，是因为它走 synthesizePreview，缓存文件名是 preview_${shortName}.wav，
 *   不依赖 sha1；而字幕批量配音的 synthesize 需要 hash 作为缓存文件名，会触发崩溃。
 */

/**
 * 将 JS 字符串按 UTF-8 编码为 Uint8Array。
 * 与 TextEncoder().encode 行为一致。
 */
export function utf8Encode(str: string): Uint8Array {
  // btoa/atob 在 UXP 下可用；先走 encodeURIComponent + unescape 的标准 polyfill
  // 这样 BMP 外的字符（含 emoji、扩展汉字）也能正确编码为 4 字节 UTF-8。
  const utf8PercentEncoded = encodeURIComponent(str);
  // unescape 已废弃但仍可用；如果不可用，回退到逐字符解码
  let binary: string;
  try {
    // eslint-disable-next-line no-undef
    binary = unescape(utf8PercentEncoded);
  } catch (_) {
    // 手动 unescape：%XX -> byte
    binary = '';
    for (let i = 0; i < utf8PercentEncoded.length; i++) {
      const ch = utf8PercentEncoded[i];
      if (ch === '%' && i + 2 < utf8PercentEncoded.length) {
        binary += String.fromCharCode(
          parseInt(utf8PercentEncoded.substr(i + 1, 2), 16)
        );
        i += 2;
      } else {
        binary += ch;
      }
    }
  }

  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/**
 * 左旋转（circular left shift）。
 */
function rotl(n: number, s: number): number {
  return (n << s) | (n >>> (32 - s));
}

/**
 * 将 Uint8Array 4 字节小端序组合成 32 位无符号整数。
 */
function bytesToUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] & 0xff) << 24) |
    ((bytes[offset + 1] & 0xff) << 16) |
    ((bytes[offset + 2] & 0xff) << 8) |
    (bytes[offset + 3] & 0xff)
  ) >>> 0;
}

/**
 * 将 32 位无符号整数写成 4 字节大端序到目标 Uint8Array。
 */
function uint32ToBytes(value: number, out: Uint8Array, offset: number): void {
  out[offset] = (value >>> 24) & 0xff;
  out[offset + 1] = (value >>> 16) & 0xff;
  out[offset + 2] = (value >>> 8) & 0xff;
  out[offset + 3] = value & 0xff;
}

/**
 * 计算 SHA-1 摘要并返回十六进制字符串。
 * 与 Web Crypto `crypto.subtle.digest('SHA-1', ...)` + 转 hex 等价。
 */
export function sha1Hex(value: string): string {
  const msg = utf8Encode(value);

  // 填充：0x80 + 0x00... + 8 字节大端序长度（位）
  const originalBitLength = msg.length * 8;
  // 需要让总长度 ≡ 56 (mod 64)，再加 8 字节长度
  const paddingLen = (56 - ((msg.length + 1) % 64) + 64) % 64;
  const paddedLen = msg.length + 1 + paddingLen + 8;
  const padded = new Uint8Array(paddedLen);
  padded.set(msg, 0);
  padded[msg.length] = 0x80;
  // 最后 8 字节：原始位长度（64 位大端序，这里高 32 位为 0，因为我们处理的输入都很短）
  // 为支持超长输入，高 32 位也得算
  const highBits = Math.floor(originalBitLength / 0x100000000);
  const lowBits = originalBitLength >>> 0;
  uint32ToBytes(highBits, padded, paddedLen - 8);
  uint32ToBytes(lowBits, padded, paddedLen - 4);

  // 初始哈希值
  let h0 = 0x67452301;
  let h1 = 0xEFCDAB89;
  let h2 = 0x98BADCFE;
  let h3 = 0x10325476;
  let h4 = 0xC3D2E1F0;

  // 按 512 位（64 字节）块处理
  const w = new Array(80);
  for (let chunkStart = 0; chunkStart < padded.length; chunkStart += 64) {
    // 前 16 个 word 直接从块里取（大端序）
    for (let i = 0; i < 16; i++) {
      w[i] = bytesToUint32(padded, chunkStart + i * 4);
    }
    // 扩展到 80 个 word
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5A827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ED9EBA1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8F1BBCDC;
      } else {
        f = b ^ c ^ d;
        k = 0xCA62C1D6;
      }

      const temp = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30) >>> 0;
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  // 输出 40 字符十六进制串
  const out = new Uint8Array(20);
  uint32ToBytes(h0, out, 0);
  uint32ToBytes(h1, out, 4);
  uint32ToBytes(h2, out, 8);
  uint32ToBytes(h3, out, 12);
  uint32ToBytes(h4, out, 16);

  let hex = '';
  for (let i = 0; i < out.length; i++) {
    hex += out[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export { sha1Hex as sha1 };
