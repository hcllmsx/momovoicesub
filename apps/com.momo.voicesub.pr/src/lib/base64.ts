const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** ArrayBuffer → base64（纯 JS 实现，分块拼接避免 UXP 环境缺少 btoa） */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const hasB = i + 1 < len;
    const hasC = i + 2 < len;
    const b1 = bytes[i];
    const b2 = hasB ? bytes[i + 1] : 0;
    const b3 = hasC ? bytes[i + 2] : 0;
    chunks.push(
      B64_ALPHABET[b1 >> 2],
      B64_ALPHABET[((b1 & 3) << 4) | (b2 >> 4)],
      hasB ? B64_ALPHABET[((b2 & 15) << 2) | (b3 >> 6)] : "=",
      hasC ? B64_ALPHABET[b3 & 63] : "="
    );
  }
  return chunks.join("");
}

/** base64 → ArrayBuffer（容忍换行/空白字符） */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const clean = String(base64 || "").replace(/[^A-Za-z0-9+/=]/g, "");
  const len = clean.length;
  if (!len) return new ArrayBuffer(0);
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array(Math.floor(len / 4) * 3 - padding);
  let p = 0;
  for (let i = 0; i + 3 < len; i += 4) {
    const e1 = B64_ALPHABET.indexOf(clean[i]);
    const e2 = B64_ALPHABET.indexOf(clean[i + 1]);
    const e3 = clean[i + 2] === "=" ? 0 : B64_ALPHABET.indexOf(clean[i + 2]);
    const e4 = clean[i + 3] === "=" ? 0 : B64_ALPHABET.indexOf(clean[i + 3]);
    if (p < bytes.length) bytes[p++] = (e1 << 2) | (e2 >> 4);
    if (p < bytes.length) bytes[p++] = ((e2 & 15) << 4) | (e3 >> 2);
    if (p < bytes.length) bytes[p++] = ((e3 & 3) << 6) | e4;
  }
  return bytes.buffer;
}
