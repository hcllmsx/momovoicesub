// @ts-ignore
import uxp from "uxp";
import { sha1Bytes, utf8Encode, utf8Decode } from "./sha1";
import { base64ToArrayBuffer } from "./base64";

declare const require: any;

const MAGIC_BYTES = new Uint8Array([0x4d, 0x56, 0x50, 0x4b]); // "MVPK"
const FORMAT_VERSION = 1;
const SAMPLE_CHUNK_SIZE = 65536; // 64KB * 5 = 320KB

function safeGetFs(): any {
  try {
    return require("fs");
  } catch (_) {
    return null;
  }
}

function normSlash(p: string): string {
  return String(p || "").replace(/\\/g, "/").trim();
}

function pathJoin(...parts: string[]): string {
  return parts
    .map((p, i) => {
      let s = String(p || "").replace(/\\/g, "/");
      if (i > 0) s = s.replace(/^\/+/, "");
      if (i < parts.length - 1) s = s.replace(/\/+$/, "");
      return s;
    })
    .filter(Boolean)
    .join("/");
}

function pathDirname(p: string): string {
  const clean = normSlash(p).replace(/\/+$/, "");
  const idx = clean.lastIndexOf("/");
  return idx >= 0 ? clean.slice(0, idx) : "";
}

function pathBasename(p: string): string {
  const clean = normSlash(p).replace(/\/+$/, "");
  const idx = clean.lastIndexOf("/");
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

function pathExtname(p: string): string {
  const base = pathBasename(p);
  const idx = base.lastIndexOf(".");
  return idx > 0 ? base.slice(idx) : "";
}

function isAbsolutePath(p: string): boolean {
  const s = normSlash(p);
  return /^[a-zA-Z]:\//.test(s) || s.startsWith("/");
}

function toWinPath(p: string): string {
  return normSlash(p).replace(/\//g, "\\");
}

function statSyncSafe(target: string): { exists: boolean; size: number; isDir: boolean; isFile: boolean } {
  const fs = safeGetFs();
  if (!fs) return { exists: false, size: 0, isDir: false, isFile: false };
  try {
    const st = typeof fs.lstatSync === "function" ? fs.lstatSync(toWinPath(target)) : fs.statSync(toWinPath(target));
    if (!st) return { exists: false, size: 0, isDir: false, isFile: false };
    const isDir = typeof st.isDirectory === "function" ? Boolean(st.isDirectory()) : false;
    const isFile = typeof st.isFile === "function" ? Boolean(st.isFile()) : !isDir;
    return {
      exists: true,
      size: typeof st.size === "number" ? st.size : 0,
      isDir,
      isFile
    };
  } catch (_) {
    return { exists: false, size: 0, isDir: false, isFile: false };
  }
}

function ensureDirSync(dirPath: string): void {
  const fs = safeGetFs();
  if (!fs) return;
  const clean = normSlash(dirPath).replace(/\/+$/, "");
  if (!clean) return;
  if (statSyncSafe(clean).exists) return;

  try {
    if (typeof fs.mkdirSync === "function") {
      try {
        fs.mkdirSync(toWinPath(clean), { recursive: true });
        if (statSyncSafe(clean).exists) return;
      } catch (_) {}
      // UXP mkdirSync 若不支持 recursive，逐级创建
      const parts = clean.split("/");
      let cur = parts[0];
      for (let i = 1; i < parts.length; i++) {
        cur = `${cur}/${parts[i]}`;
        if (!statSyncSafe(cur).exists) {
          try {
            fs.mkdirSync(toWinPath(cur));
          } catch (_) {}
        }
      }
    }
  } catch (_) {}
}

export function readBinaryFile(filePath: string): Uint8Array | null {
  const fs = safeGetFs();
  if (!fs) return null;
  try {
    const raw = fs.readFileSync(toWinPath(filePath));
    if (!raw) return null;
    if (raw instanceof Uint8Array) return raw;
    if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
    if (raw.buffer instanceof ArrayBuffer) {
      return new Uint8Array(raw.buffer, raw.byteOffset || 0, raw.byteLength);
    }
    return new Uint8Array(raw);
  } catch (_) {
    return null;
  }
}

export async function writeBinaryFile(filePath: string, data: Uint8Array): Promise<boolean> {
  const fs = safeGetFs();
  const winTarget = toWinPath(filePath);
  const parentDir = pathDirname(filePath);
  if (parentDir) ensureDirSync(parentDir);

  if (fs && typeof fs.writeFileSync === "function") {
    try {
      fs.writeFileSync(winTarget, data);
      return true;
    } catch (e) {
      console.warn("[Momo] fs.writeFileSync binary failed, falling back to UXP storage:", e);
    }
  }

  try {
    const cleanDir = toWinPath(parentDir).replace(/^[a-zA-Z]:/, "").replace(/\\/g, "/");
    const drive = (toWinPath(parentDir).match(/^[a-zA-Z]:/) || [""])[0];
    const folderUrl = drive ? `file:///${drive}${cleanDir}` : `file://${cleanDir}`;
    const folderEntry = await (uxp.storage.localFileSystem as any).getEntryWithUrl(folderUrl);
    if (folderEntry && folderEntry.isFolder) {
      const fileEntry = await folderEntry.createEntry(pathBasename(filePath), { overwrite: true });
      const ab = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
        ? data.buffer
        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      await fileEntry.write(ab, { format: (uxp.storage.formats as any).binary });
      return true;
    }
  } catch (e) {
    console.error("[Momo] UXP fallback writeBinaryFile failed:", e);
  }
  return false;
}

/**
 * 判断权重路径是否属于整合包自带的预训练通用底模
 */
export function isPretrainedWeightPath(weightPath?: string): boolean {
  const norm = normSlash(weightPath || "");
  return norm.startsWith("GPT_SoVITS/pretrained_models/") || norm.includes("/pretrained_models/");
}

/**
 * 规范化权重路径为相对于整合包根目录的相对路径
 */
export function normalizeWeightRelPath(
  weightPath?: string,
  kind: "gpt" | "sovits" = "gpt",
  modelVersion: string = "v2Pro"
): string {
  const norm = normSlash(weightPath || "");
  if (!norm) return "";
  if (isPretrainedWeightPath(norm)) {
    const idx = norm.indexOf("GPT_SoVITS/pretrained_models/");
    return idx >= 0 ? norm.slice(idx) : norm;
  }
  const m = norm.match(/((?:GPT|SoVITS)_weights[^/]*)\/([^/]+)$/i);
  if (m) {
    return `${m[1]}/${m[2]}`;
  }
  const base = pathBasename(norm);
  const verSuffix = !modelVersion || modelVersion === "v1" ? "" : `_${modelVersion}`;
  const defaultDir = kind === "sovits" ? `SoVITS_weights${verSuffix}` : `GPT_weights${verSuffix}`;
  return `${defaultDir}/${base}`;
}

/**
 * 计算采样偏移位置（首、25%、50%、75%、尾 各 64KB），与 DR 版 Node 算法严格一致
 */
function getSampleOffsets(fileSize: number): number[] | null {
  if (fileSize <= SAMPLE_CHUNK_SIZE * 5) return null;
  const maxStart = fileSize - SAMPLE_CHUNK_SIZE;
  return [
    0,
    Math.floor(maxStart * 0.25),
    Math.floor(maxStart * 0.50),
    Math.floor(maxStart * 0.75),
    maxStart
  ];
}

/**
 * 对内存中的 Uint8Array 计算快速内容指纹（耗时 < 2ms）：
 * 格式为 `${byteLength}:${sha1Hex}`
 */
export function computeBufferFingerprint(bytes: Uint8Array): string {
  const len = bytes.byteLength;
  const offsets = getSampleOffsets(len);
  if (!offsets) {
    return `${len}:${sha1Bytes(bytes)}`;
  }
  const sample = new Uint8Array(SAMPLE_CHUNK_SIZE * offsets.length);
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i];
    sample.set(bytes.subarray(start, start + SAMPLE_CHUNK_SIZE), i * SAMPLE_CHUNK_SIZE);
  }
  return `${len}:${sha1Bytes(sample)}`;
}

/**
 * 计算磁盘文件的快速指纹
 */
export function computeFileFingerprint(filePath: string): { size: number; fingerprint: string; bytes?: Uint8Array } | null {
  const bytes = readBinaryFile(filePath);
  if (!bytes) return null;
  return {
    size: bytes.byteLength,
    fingerprint: computeBufferFingerprint(bytes),
    bytes
  };
}

/**
 * 收集可能的整合包候选根目录（当前 rootDir、额外记录目录、同级父目录下的其他 GPT-SoVITS 目录）
 */
function collectCandidateRoots(rootDir: string, extraRoots: string[] = []): string[] {
  const fs = safeGetFs();
  const roots: string[] = [];
  const seen = new Set<string>();

  const addRoot = (r?: string) => {
    if (!r) return;
    const clean = normSlash(r).replace(/\/+$/, "");
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    const st = statSyncSafe(clean);
    if (st.exists && st.isDir) {
      seen.add(key);
      roots.push(clean);
    }
  };

  addRoot(rootDir);
  for (const r of extraRoots) addRoot(r);

  const baseForSibling = rootDir || extraRoots.find(Boolean) || "";
  if (baseForSibling && fs && typeof fs.readdirSync === "function") {
    try {
      const parentDir = pathDirname(baseForSibling);
      if (parentDir && statSyncSafe(parentDir).exists) {
        const entries: string[] = fs.readdirSync(toWinPath(parentDir)) || [];
        for (const name of entries) {
          if (/gpt[-_]?sovits/i.test(name)) {
            addRoot(pathJoin(parentDir, name));
          }
        }
      }
    } catch (_) {}
  }

  return roots;
}

export function resolveWeightSourceFile(
  weightPath: string,
  rootDir: string,
  extraRoots: string[] = [],
  kind: "gpt" | "sovits" = "gpt",
  modelVersion: string = "v2Pro"
): { absPath: string; relPath: string; inCurrentRoot: boolean; sourceRoot: string } | null {
  if (!weightPath) return null;
  const raw = normSlash(weightPath);
  const normRoot = normSlash(rootDir).replace(/\/+$/, "").toLowerCase();

  if (isAbsolutePath(raw) && statSyncSafe(raw).exists) {
    return {
      absPath: raw,
      relPath: normalizeWeightRelPath(raw, kind, modelVersion),
      inCurrentRoot: normRoot ? raw.toLowerCase().startsWith(normRoot) : true,
      sourceRoot: ""
    };
  }

  const relPath = normalizeWeightRelPath(raw, kind, modelVersion);
  const candidates = collectCandidateRoots(rootDir, extraRoots);
  for (const candRoot of candidates) {
    const absCandidate = pathJoin(candRoot, relPath);
    if (statSyncSafe(absCandidate).exists) {
      return {
        absPath: absCandidate,
        relPath,
        inCurrentRoot: normRoot ? candRoot.toLowerCase() === normRoot : false,
        sourceRoot: candRoot
      };
    }
  }
  return null;
}

/**
 * 智能安装或复用单个模型权重到目标整合包 rootDir：
 * 1. 同名且指纹一致 -> 直接复用
 * 2. 同目录下存在不同文件名但指纹一致 -> 直接复用该文件
 * 3. 同名但指纹不一致 -> 自动编号重命名（xxx_2.ckpt），不覆盖原模型
 */
export async function installOrReuseWeight({
  rootDir,
  relPath,
  fingerprint,
  bytes
}: {
  rootDir: string;
  relPath: string;
  fingerprint: string;
  bytes: Uint8Array;
}): Promise<{ relPath: string; action: "reused" | "installed"; renamed: boolean }> {
  const fs = safeGetFs();
  const normRel = normSlash(relPath);
  const parts = normRel.split("/");
  const fileName = parts.pop() || "model.ckpt";
  const dirName = parts.join("/") || "GPT_weights_v2Pro";
  const targetDir = pathJoin(rootDir, dirName);
  ensureDirSync(targetDir);

  const ext = pathExtname(fileName);
  const baseName = fileName.slice(0, fileName.length - ext.length);
  const directPath = pathJoin(targetDir, fileName);
  const byteLength = bytes.byteLength;

  // 1. 检查同名文件是否已存在且指纹一致
  const directStat = statSyncSafe(directPath);
  if (directStat.exists && directStat.isFile && (!byteLength || directStat.size === byteLength)) {
    const localInfo = computeFileFingerprint(directPath);
    if (localInfo && localInfo.fingerprint === fingerprint) {
      return {
        relPath: `${dirName}/${fileName}`,
        action: "reused",
        renamed: false
      };
    }
  }

  // 2. 扫描同目录下是否有「不同文件名但内容指纹完全一致」的模型权重
  if (fs && typeof fs.readdirSync === "function") {
    try {
      const entries: string[] = fs.readdirSync(toWinPath(targetDir)) || [];
      for (const entry of entries) {
        if (entry === fileName) continue;
        if (pathExtname(entry).toLowerCase() !== ext.toLowerCase()) continue;
        const candPath = pathJoin(targetDir, entry);
        const st = statSyncSafe(candPath);
        if (!st.exists || !st.isFile) continue;
        if (byteLength && st.size !== byteLength) continue;
        const localInfo = computeFileFingerprint(candPath);
        if (localInfo && localInfo.fingerprint === fingerprint) {
          return {
            relPath: `${dirName}/${entry}`,
            action: "reused",
            renamed: entry !== fileName
          };
        }
      }
    } catch (_) {}
  }

  // 3. 写入新文件（若同名文件被不同模型占用，自动编号重命名）
  let finalFileName = fileName;
  let n = 2;
  while (statSyncSafe(pathJoin(targetDir, finalFileName)).exists) {
    finalFileName = `${baseName}_${n}${ext}`;
    n++;
  }

  const finalAbsPath = pathJoin(targetDir, finalFileName);
  const ok = await writeBinaryFile(finalAbsPath, bytes);
  if (!ok) {
    throw new Error(`无法写入模型权重文件到整合包目录：${toWinPath(finalAbsPath)}`);
  }

  return {
    relPath: `${dirName}/${finalFileName}`,
    action: "installed",
    renamed: finalFileName !== fileName
  };
}

/**
 * 构建 .mvpkg 二进制完整音色包（内嵌参考音频 + 去重后的 GPT/SoVITS 模型权重）
 */
export function buildVoicePackageBuffer({
  voices,
  rootDir,
  readAudioBytes
}: {
  voices: any[];
  rootDir: string;
  readAudioBytes: (path: string) => Promise<ArrayBuffer | null> | ArrayBuffer | null;
}): Promise<{
  buffer: Uint8Array;
  count: number;
  packedWeightsCount: number;
  missingAudio: number;
  missingWeights: number;
}> {
  return (async () => {
    const extraRoots: string[] = [];
    for (const v of voices) {
      if (v?.sourceRootDir) extraRoots.push(v.sourceRootDir);
    }

    const weightsByFp = new Map<string, {
      key: string;
      kind: string;
      relPath: string;
      fingerprint: string;
      offset: number;
      length: number;
      bytes: Uint8Array;
    }>();
    const weightList: {
      key: string;
      kind: string;
      relPath: string;
      fingerprint: string;
      offset: number;
      length: number;
      bytes: Uint8Array;
    }[] = [];

    let currentOffset = 0;
    let missingAudio = 0;
    let missingWeights = 0;

    const registerWeight = (weightPath: string, kind: "gpt" | "sovits", modelVersion: string) => {
      if (!weightPath || isPretrainedWeightPath(weightPath)) {
        return { isPretrained: true, relPath: normalizeWeightRelPath(weightPath, kind, modelVersion), key: null };
      }
      const resolved = resolveWeightSourceFile(weightPath, rootDir, extraRoots, kind, modelVersion);
      if (!resolved) {
        missingWeights++;
        return { isPretrained: false, relPath: normalizeWeightRelPath(weightPath, kind, modelVersion), key: null };
      }
      const fileInfo = computeFileFingerprint(resolved.absPath);
      if (!fileInfo || !fileInfo.bytes) {
        missingWeights++;
        return { isPretrained: false, relPath: resolved.relPath, key: null };
      }
      if (weightsByFp.has(fileInfo.fingerprint)) {
        const existing = weightsByFp.get(fileInfo.fingerprint)!;
        return { isPretrained: false, relPath: existing.relPath, key: existing.key };
      }
      const key = `w_${weightList.length}`;
      const entry = {
        key,
        kind,
        relPath: resolved.relPath,
        fingerprint: fileInfo.fingerprint,
        offset: currentOffset,
        length: fileInfo.size,
        bytes: fileInfo.bytes
      };
      currentOffset += fileInfo.size;
      weightsByFp.set(fileInfo.fingerprint, entry);
      weightList.push(entry);
      return { isPretrained: false, relPath: resolved.relPath, key };
    };

    const manifestVoices: any[] = [];
    const audioBuffers: Uint8Array[] = [];

    for (const v of voices) {
      const gptInfo = registerWeight(v.gptWeightsPath, "gpt", v.modelVersion);
      const sovitsInfo = registerWeight(v.sovitsWeightsPath, "sovits", v.modelVersion);

      let refAudioExt = "wav";
      let refAudioOffset = -1;
      let refAudioLength = 0;

      if (v.refAudioPath) {
        const ab = await readAudioBytes(v.refAudioPath);
        if (ab && ab.byteLength > 0) {
          const u8 = new Uint8Array(ab);
          const m = String(v.refAudioPath).match(/\.([A-Za-z0-9]+)\s*$/);
          refAudioExt = m ? m[1].toLowerCase() : "wav";
          refAudioOffset = currentOffset;
          refAudioLength = u8.byteLength;
          currentOffset += u8.byteLength;
          audioBuffers.push(u8);
        } else {
          missingAudio++;
        }
      } else {
        missingAudio++;
      }

      manifestVoices.push({
        id: v.id,
        name: v.name || v.id,
        avatarType: v.avatarType || (v.gender === "Male" ? "man" : "woman"),
        emotion: v.emotion || "通用",
        gender: v.gender || "",
        avatar: v.avatar || "",
        modelName: v.modelName || "",
        modelVersion: v.modelVersion || "",
        gptWeightsPath: gptInfo.relPath || v.gptWeightsPath || "",
        sovitsWeightsPath: sovitsInfo.relPath || v.sovitsWeightsPath || "",
        gptWeightKey: gptInfo.key,
        sovitsWeightKey: sovitsInfo.key,
        promptText: v.promptText || "",
        promptLang: v.promptLang || "zh",
        refAudioExt,
        refAudioOffset,
        refAudioLength
      });
    }

    const manifest = {
      type: "momovoicesub-voice-package",
      version: 2,
      exportedAt: new Date().toISOString(),
      weights: weightList.map(({ bytes, ...rest }) => rest),
      voices: manifestVoices
    };

    const manifestBytes = utf8Encode(JSON.stringify(manifest));
    const totalLength = 12 + manifestBytes.byteLength + currentOffset;
    const out = new Uint8Array(totalLength);
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);

    out.set(MAGIC_BYTES, 0);
    dv.setUint32(4, FORMAT_VERSION, true);
    dv.setUint32(8, manifestBytes.byteLength, true);
    out.set(manifestBytes, 12);

    let writePos = 12 + manifestBytes.byteLength;
    for (const w of weightList) {
      out.set(w.bytes, writePos);
      writePos += w.bytes.byteLength;
    }
    for (const a of audioBuffers) {
      out.set(a, writePos);
      writePos += a.byteLength;
    }

    return {
      buffer: out,
      count: manifestVoices.length,
      packedWeightsCount: weightList.length,
      missingAudio,
      missingWeights
    };
  })();
}

/**
 * 解析并导入音色包（支持 .mvpkg 二进制完整音色包 与 旧版 .json 文件）
 */
export async function parseAndInstallVoicePackage({
  fileBytes,
  rootDir,
  saveRefAudio
}: {
  fileBytes: Uint8Array;
  rootDir: string;
  saveRefAudio: (voiceId: string, ext: string, audioBytes: Uint8Array) => Promise<string>;
}): Promise<{
  ok: boolean;
  error?: string;
  isMvpkg?: boolean;
  installedWeights?: number;
  reusedWeights?: number;
  voices?: any[];
}> {
  if (!fileBytes || fileBytes.byteLength < 4) {
    return { ok: false, error: "导入文件为空或已损坏" };
  }

  const isMvpkg =
    fileBytes[0] === MAGIC_BYTES[0] &&
    fileBytes[1] === MAGIC_BYTES[1] &&
    fileBytes[2] === MAGIC_BYTES[2] &&
    fileBytes[3] === MAGIC_BYTES[3];

  if (isMvpkg) {
    if (fileBytes.byteLength < 12) {
      return { ok: false, error: "音色包文件头损坏" };
    }
    const dv = new DataView(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength);
    const manifestLen = dv.getUint32(8, true);
    const dataBaseOffset = 12 + manifestLen;
    if (manifestLen <= 0 || dataBaseOffset > fileBytes.byteLength) {
      return { ok: false, error: "音色包清单数据损坏或文件不完整" };
    }

    let manifest: any;
    try {
      const jsonStr = utf8Decode(fileBytes.subarray(12, 12 + manifestLen));
      manifest = JSON.parse(jsonStr);
    } catch (_) {
      return { ok: false, error: "音色包清单 JSON 解析失败" };
    }

    const rawVoices = Array.isArray(manifest?.voices) ? manifest.voices : [];
    const rawWeights = Array.isArray(manifest?.weights) ? manifest.weights : [];
    if (!rawVoices.length) {
      return { ok: false, error: "音色包中没有有效的音色数据" };
    }

    if (rawWeights.length > 0) {
      if (!rootDir || !statSyncSafe(rootDir).exists) {
        return {
          ok: false,
          error: "该音色包内含 GPT/SoVITS 模型权重，请先在「本地部署」中选择有效的 GPT-SoVITS 整合包目录后再导入"
        };
      }
    }

    const resolvedWeightPathByKey = new Map<string, string>();
    let installedWeights = 0;
    let reusedWeights = 0;

    for (const w of rawWeights) {
      if (!w || !w.key || typeof w.offset !== "number" || typeof w.length !== "number") continue;
      const absOffset = dataBaseOffset + w.offset;
      if (absOffset + w.length > fileBytes.byteLength) {
        return { ok: false, error: `音色包内的模型权重文件（${w.relPath}）数据不完整` };
      }
      const weightSlice = fileBytes.subarray(absOffset, absOffset + w.length);
      const fp = w.fingerprint || computeBufferFingerprint(weightSlice);
      const res = await installOrReuseWeight({
        rootDir,
        relPath: w.relPath,
        fingerprint: fp,
        bytes: weightSlice
      });
      resolvedWeightPathByKey.set(w.key, res.relPath);
      if (res.action === "reused") reusedWeights++;
      else installedWeights++;
    }

    const importedVoices: any[] = [];
    for (const v of rawVoices) {
      if (!v || !v.name) continue;
      const newId = `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      let audioSlice: Uint8Array | null = null;
      const ext = String(v.refAudioExt || "wav").replace(/[^A-Za-z0-9]/g, "") || "wav";

      if (typeof v.refAudioOffset === "number" && v.refAudioOffset >= 0 && v.refAudioLength > 0) {
        const audioAbsOffset = dataBaseOffset + v.refAudioOffset;
        if (audioAbsOffset + v.refAudioLength <= fileBytes.byteLength) {
          audioSlice = fileBytes.subarray(audioAbsOffset, audioAbsOffset + v.refAudioLength);
        }
      } else if (v.refAudioBase64) {
        audioSlice = new Uint8Array(base64ToArrayBuffer(v.refAudioBase64));
      }

      if (!audioSlice) continue;
      const archivedPath = await saveRefAudio(newId, ext, audioSlice);
      if (!archivedPath) continue;

      const finalGptPath = (v.gptWeightKey && resolvedWeightPathByKey.get(v.gptWeightKey))
        || v.gptWeightsPath
        || "";
      const finalSovitsPath = (v.sovitsWeightKey && resolvedWeightPathByKey.get(v.sovitsWeightKey))
        || v.sovitsWeightsPath
        || "";

      const gptAbs = finalGptPath && rootDir && !isAbsolutePath(finalGptPath)
        ? pathJoin(rootDir, finalGptPath)
        : finalGptPath;
      const sovitsAbs = finalSovitsPath && rootDir && !isAbsolutePath(finalSovitsPath)
        ? pathJoin(rootDir, finalSovitsPath)
        : finalSovitsPath;

      const gptOk = !finalGptPath || (rootDir ? statSyncSafe(gptAbs).exists : false);
      const sovitsOk = !finalSovitsPath || (rootDir ? statSyncSafe(sovitsAbs).exists : false);

      importedVoices.push({
        ...v,
        id: newId,
        gptWeightsPath: finalGptPath,
        sovitsWeightsPath: finalSovitsPath,
        refAudioPath: archivedPath,
        sourceRootDir: rootDir || "",
        weightsMissing: !(gptOk && sovitsOk)
      });
    }

    return {
      ok: true,
      isMvpkg: true,
      installedWeights,
      reusedWeights,
      voices: importedVoices
    };
  }

  // 兼容旧版 .json 格式
  let data: any;
  try {
    data = JSON.parse(utf8Decode(fileBytes));
  } catch (_) {
    return { ok: false, error: "导入文件不是有效的音色包（.mvpkg 或 .json）格式" };
  }
  const raw = data && Array.isArray(data.voices) ? data.voices : [];
  const importedVoices: any[] = [];
  for (const v of raw) {
    if (!v || !v.name || !v.refAudioBase64) continue;
    const newId = `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const ext = String(v.refAudioExt || "wav").replace(/[^A-Za-z0-9]/g, "") || "wav";
    const audioSlice = new Uint8Array(base64ToArrayBuffer(v.refAudioBase64));
    const archivedPath = await saveRefAudio(newId, ext, audioSlice);
    if (!archivedPath) continue;

    const gptAbs = v.gptWeightsPath && rootDir && !isAbsolutePath(v.gptWeightsPath)
      ? pathJoin(rootDir, v.gptWeightsPath)
      : v.gptWeightsPath;
    const sovitsAbs = v.sovitsWeightsPath && rootDir && !isAbsolutePath(v.sovitsWeightsPath)
      ? pathJoin(rootDir, v.sovitsWeightsPath)
      : v.sovitsWeightsPath;
    const gptOk = !v.gptWeightsPath || (gptAbs ? statSyncSafe(gptAbs).exists : false);
    const sovitsOk = !v.sovitsWeightsPath || (sovitsAbs ? statSyncSafe(sovitsAbs).exists : false);

    importedVoices.push({
      ...v,
      id: newId,
      refAudioPath: archivedPath,
      weightsMissing: !(gptOk && sovitsOk)
    });
  }

  return {
    ok: true,
    isMvpkg: false,
    installedWeights: 0,
    reusedWeights: 0,
    voices: importedVoices
  };
}

/**
 * 检测当前音色列表中是否有模型权重留在旧整合包目录中
 */
export function inspectMissingWeights({
  voices = [],
  rootDir,
  previousRootDir = ""
}: {
  voices: any[];
  rootDir: string;
  previousRootDir?: string;
}): {
  missingCount: number;
  migratableItems: { relPath: string; sourceAbsPath: string; sourceRoot: string; voiceNames: string[] }[];
  unresolvedVoices: string[];
} {
  if (!rootDir || !statSyncSafe(rootDir).exists) {
    return { missingCount: 0, migratableItems: [], unresolvedVoices: [] };
  }

  const extraRoots: string[] = [];
  if (previousRootDir) extraRoots.push(previousRootDir);
  for (const v of voices) {
    if (v?.sourceRootDir) extraRoots.push(v.sourceRootDir);
  }

  const migratableByRelPath = new Map<string, { relPath: string; sourceAbsPath: string; sourceRoot: string; voiceNames: string[] }>();
  const unresolvedVoices: string[] = [];

  for (const v of voices) {
    if (!v) continue;
    const pairs: { path?: string; kind: "gpt" | "sovits" }[] = [
      { path: v.gptWeightsPath, kind: "gpt" },
      { path: v.sovitsWeightsPath, kind: "sovits" }
    ];
    let voiceUnresolved = false;

    for (const item of pairs) {
      if (!item.path || isPretrainedWeightPath(item.path)) continue;
      const relPath = normalizeWeightRelPath(item.path, item.kind, v.modelVersion);
      const targetAbs = pathJoin(rootDir, relPath);
      if (statSyncSafe(targetAbs).exists) continue;

      const resolved =
        resolveWeightSourceFile(item.path, "", extraRoots, item.kind, v.modelVersion) ||
        resolveWeightSourceFile(item.path, rootDir, extraRoots, item.kind, v.modelVersion);

      if (resolved && resolved.absPath && statSyncSafe(resolved.absPath).exists && !resolved.inCurrentRoot) {
        if (!migratableByRelPath.has(relPath)) {
          migratableByRelPath.set(relPath, {
            relPath,
            sourceAbsPath: resolved.absPath,
            sourceRoot: resolved.sourceRoot || pathDirname(pathDirname(resolved.absPath)),
            voiceNames: [v.name || v.id]
          });
        } else {
          const entry = migratableByRelPath.get(relPath)!;
          if (!entry.voiceNames.includes(v.name || v.id)) {
            entry.voiceNames.push(v.name || v.id);
          }
        }
      } else {
        voiceUnresolved = true;
      }
    }

    if (voiceUnresolved) {
      unresolvedVoices.push(v.name || v.id);
    }
  }

  const migratableItems = [...migratableByRelPath.values()];
  return {
    missingCount: migratableItems.length + unresolvedVoices.length,
    migratableItems,
    unresolvedVoices
  };
}

/**
 * 将旧整合包中的自定义模型权重自动复制迁移到当前 rootDir（含指纹比对与复用）
 */
export async function migrateMissingWeights({
  voices = [],
  rootDir,
  previousRootDir = ""
}: {
  voices: any[];
  rootDir: string;
  previousRootDir?: string;
}): Promise<{
  ok: boolean;
  migratedCount: number;
  reusedCount: number;
  updatedPathMap: Record<string, string>;
  unresolvedVoices: string[];
}> {
  const inspection = inspectMissingWeights({ voices, rootDir, previousRootDir });
  let migratedCount = 0;
  let reusedCount = 0;
  const updatedPathMap: Record<string, string> = {};

  for (const item of inspection.migratableItems) {
    const fileInfo = computeFileFingerprint(item.sourceAbsPath);
    if (!fileInfo || !fileInfo.bytes) continue;
    const res = await installOrReuseWeight({
      rootDir,
      relPath: item.relPath,
      fingerprint: fileInfo.fingerprint,
      bytes: fileInfo.bytes
    });
    updatedPathMap[item.relPath] = res.relPath;
    if (res.action === "reused") reusedCount++;
    else migratedCount++;
  }

  return {
    ok: true,
    migratedCount,
    reusedCount,
    updatedPathMap,
    unresolvedVoices: inspection.unresolvedVoices
  };
}
