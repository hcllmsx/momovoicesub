const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAGIC = Buffer.from('MVPK', 'ascii');
const FORMAT_VERSION = 1;
const SAMPLE_CHUNK_SIZE = 65536; // 64KB * 5 = 320KB 采样指纹
const COPY_CHUNK_SIZE = 8 * 1024 * 1024; // 8MB 分块流式读写

/**
 * 判断权重路径是否属于整合包自带的预训练通用底模（无需随音色包打包，所有整合包自带）
 */
function isPretrainedWeightPath(weightPath) {
  const norm = String(weightPath || '').replace(/\\/g, '/').trim();
  return norm.startsWith('GPT_SoVITS/pretrained_models/') || norm.includes('/pretrained_models/');
}

/**
 * 将权重路径规范化为相对于整合包根目录的相对路径，例如：
 * "D:\\...\\GPT_weights_v2Pro\\xxx.ckpt" -> "GPT_weights_v2Pro/xxx.ckpt"
 */
function normalizeWeightRelPath(weightPath, kind = 'gpt', modelVersion = 'v2Pro') {
  const norm = String(weightPath || '').replace(/\\/g, '/').trim();
  if (!norm) return '';
  if (isPretrainedWeightPath(norm)) {
    const idx = norm.indexOf('GPT_SoVITS/pretrained_models/');
    return idx >= 0 ? norm.slice(idx) : norm;
  }
  const m = norm.match(/((?:GPT|SoVITS)_weights[^/]*)\/([^/]+)$/i);
  if (m) {
    return `${m[1]}/${m[2]}`;
  }
  const base = path.posix.basename(norm);
  const verSuffix = (!modelVersion || modelVersion === 'v1') ? '' : `_${modelVersion}`;
  const defaultDir = kind === 'sovits' ? `SoVITS_weights${verSuffix}` : `GPT_weights${verSuffix}`;
  return `${defaultDir}/${base}`;
}

/**
 * 计算采样偏移位置（首、25%、50%、75%、尾 各 64KB），与 PR 版 UXP 算法严格一致
 */
function getSampleOffsets(fileSize) {
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
 * 对文件句柄中指定区间 [baseOffset, baseOffset + byteLength) 计算快速内容指纹：
 * 格式为 `${byteLength}:${sha1Hex}`
 */
function computeFdSliceFingerprint(fd, baseOffset, byteLength) {
  const hash = crypto.createHash('sha1');
  const offsets = getSampleOffsets(byteLength);
  if (!offsets) {
    const buf = Buffer.allocUnsafe(byteLength);
    const bytesRead = fs.readSync(fd, buf, 0, byteLength, baseOffset);
    hash.update(bytesRead === byteLength ? buf : buf.subarray(0, bytesRead));
  } else {
    const chunk = Buffer.allocUnsafe(SAMPLE_CHUNK_SIZE);
    for (const off of offsets) {
      const bytesRead = fs.readSync(fd, chunk, 0, SAMPLE_CHUNK_SIZE, baseOffset + off);
      hash.update(bytesRead === SAMPLE_CHUNK_SIZE ? chunk : chunk.subarray(0, bytesRead));
    }
  }
  return `${byteLength}:${hash.digest('hex')}`;
}

/**
 * 计算磁盘文件的快速指纹（仅读取 320KB，耗时 < 2ms）
 */
function computeFileFingerprint(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    return {
      size: stat.size,
      fingerprint: computeFdSliceFingerprint(fd, 0, stat.size)
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 计算内存 Buffer / Uint8Array 的快速指纹
 */
function computeBufferFingerprint(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const byteLength = buf.length;
  const hash = crypto.createHash('sha1');
  const offsets = getSampleOffsets(byteLength);
  if (!offsets) {
    hash.update(buf);
  } else {
    for (const off of offsets) {
      hash.update(buf.subarray(off, off + SAMPLE_CHUNK_SIZE));
    }
  }
  return `${byteLength}:${hash.digest('hex')}`;
}

/**
 * 枚举可能的整合包候选根目录（当前 rootDir、额外记录的目录、同级父目录下的其他 GPT-SoVITS 目录）
 */
function collectCandidateRoots(rootDir, extraRoots = []) {
  const roots = [];
  const seen = new Set();
  const addRoot = (r) => {
    if (!r || typeof r !== 'string') return;
    const clean = path.resolve(r.trim());
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    try {
      if (fs.existsSync(clean) && fs.statSync(clean).isDirectory()) {
        seen.add(key);
        roots.push(clean);
      }
    } catch (_) {}
  };

  addRoot(rootDir);
  for (const r of extraRoots) addRoot(r);

  // 自动扫描同级目录（例如 D:\GPT-SoVITS\ 下的旧整合包目录）
  const baseForSibling = rootDir || extraRoots.find(Boolean);
  if (baseForSibling) {
    try {
      const parentDir = path.dirname(path.resolve(baseForSibling));
      if (parentDir && fs.existsSync(parentDir)) {
        const entries = fs.readdirSync(parentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && /gpt[-_]?sovits/i.test(entry.name)) {
            addRoot(path.join(parentDir, entry.name));
          }
        }
      }
    } catch (_) {}
  }

  return roots;
}

/**
 * 在候选整合包目录中定位权重文件的真实磁盘路径
 */
function resolveWeightSourceFile(weightPath, rootDir, extraRoots = [], kind = 'gpt', modelVersion = 'v2Pro') {
  if (!weightPath) return null;
  const raw = String(weightPath).trim();
  if (path.isAbsolute(raw) && fs.existsSync(raw)) {
    return {
      absPath: raw,
      relPath: normalizeWeightRelPath(raw, kind, modelVersion),
      inCurrentRoot: rootDir ? path.resolve(raw).toLowerCase().startsWith(path.resolve(rootDir).toLowerCase()) : true,
      sourceRoot: ''
    };
  }

  const relPath = normalizeWeightRelPath(raw, kind, modelVersion);
  const candidates = collectCandidateRoots(rootDir, extraRoots);
  const normRoot = rootDir ? path.resolve(rootDir).toLowerCase() : '';

  for (const candRoot of candidates) {
    const absCandidate = path.join(candRoot, relPath);
    if (fs.existsSync(absCandidate)) {
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
 * 将源句柄区间 [srcOffset, srcOffset + byteLength) 流式复制到目标文件
 */
function copyFdRangeToFile(srcFd, srcOffset, byteLength, destFilePath) {
  const dir = path.dirname(destFilePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${destFilePath}.momo_tmp_${Date.now()}`;
  const destFd = fs.openSync(tmpPath, 'w');
  const buf = Buffer.allocUnsafe(Math.min(COPY_CHUNK_SIZE, Math.max(4096, byteLength)));
  try {
    let remaining = byteLength;
    let readPos = srcOffset;
    while (remaining > 0) {
      const toRead = Math.min(buf.length, remaining);
      const bytesRead = fs.readSync(srcFd, buf, 0, toRead, readPos);
      if (bytesRead <= 0) throw new Error('读取音色包模型权重数据时意外结束');
      fs.writeSync(destFd, buf, 0, bytesRead);
      readPos += bytesRead;
      remaining -= bytesRead;
    }
  } catch (err) {
    try { fs.closeSync(destFd); } catch (_) {}
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    throw err;
  }
  fs.closeSync(destFd);
  if (fs.existsSync(destFilePath)) {
    fs.unlinkSync(destFilePath);
  }
  fs.renameSync(tmpPath, destFilePath);
}

/**
 * 智能安装或复用单个模型权重到目标整合包 rootDir：
 * 1. 若目标相对路径已存在且指纹一致 -> 直接复用（不重复写盘）
 * 2. 若目标目录下存在其他文件名但指纹完全一致的权重 -> 直接复用该已有文件
 * 3. 若目标同名文件已存在但指纹不同（同名冲突） -> 自动编号重命名（如 xxx_2.ckpt），绝不覆盖原模型
 */
function installOrReuseWeight({
  rootDir,
  relPath,
  fingerprint,
  byteLength,
  writeToFile
}) {
  const normRel = relPath.replace(/\\/g, '/');
  const parts = normRel.split('/');
  const fileName = parts.pop();
  const dirName = parts.join('/') || 'GPT_weights_v2Pro';
  const targetDir = path.join(rootDir, dirName);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const ext = path.extname(fileName);
  const baseName = fileName.slice(0, fileName.length - ext.length);
  const directPath = path.join(targetDir, fileName);

  // 1. 检查同名文件是否已存在且指纹相同
  if (fs.existsSync(directPath)) {
    try {
      const stat = fs.statSync(directPath);
      if (! byteLength || stat.size === byteLength) {
        const localInfo = computeFileFingerprint(directPath);
        if (localInfo.fingerprint === fingerprint) {
          return {
            relPath: `${dirName}/${fileName}`,
            action: 'reused',
            renamed: false
          };
        }
      }
    } catch (_) {}
  }

  // 2. 扫描同目录下是否有「不同文件名但内容指纹完全一致」的模型权重
  try {
    const entries = fs.readdirSync(targetDir);
    for (const entry of entries) {
      if (entry === fileName) continue;
      if (path.extname(entry).toLowerCase() !== ext.toLowerCase()) continue;
      const candPath = path.join(targetDir, entry);
      try {
        const stat = fs.statSync(candPath);
        if (!stat.isFile()) continue;
        if (byteLength && stat.size !== byteLength) continue;
        const localInfo = computeFileFingerprint(candPath);
        if (localInfo.fingerprint === fingerprint) {
          return {
            relPath: `${dirName}/${entry}`,
            action: 'reused',
            renamed: entry !== fileName
          };
        }
      } catch (_) {}
    }
  } catch (_) {}

  // 3. 需要写入新权重文件：若同名文件被不同内容的模型占用，自动编号避免覆盖
  let finalFileName = fileName;
  let n = 2;
  while (fs.existsSync(path.join(targetDir, finalFileName))) {
    finalFileName = `${baseName}_${n}${ext}`;
    n++;
  }

  const finalAbsPath = path.join(targetDir, finalFileName);
  writeToFile(finalAbsPath);

  return {
    relPath: `${dirName}/${finalFileName}`,
    action: 'installed',
    renamed: finalFileName !== fileName
  };
}

/**
 * 导出本地音色为 .mvpkg 完整音色包（内嵌参考音频 + 去重后的 GPT/SoVITS 模型权重）
 */
function exportVoicePackage({ filePath, voices, rootDir }) {
  const extraRoots = [];
  for (const v of voices) {
    if (v.sourceRootDir) extraRoots.push(v.sourceRootDir);
    if (v.refAudioPath) {
      const m = String(v.refAudioPath).match(/^(.*[\\/][^\\/]*gpt[-_]?sovits[^\\/]*)[\\/]/i);
      if (m && m[1]) extraRoots.push(m[1]);
    }
  }

  // 按 fingerprint 对模型权重去重：多个音色共用同一套模型时，包内仅存一份
  const weightsByFp = new Map();
  const weightList = [];
  let currentOffset = 0;
  let missingAudio = 0;
  let missingWeights = 0;

  const registerWeight = (weightPath, kind, modelVersion) => {
    if (!weightPath || isPretrainedWeightPath(weightPath)) {
      return { isPretrained: true, relPath: normalizeWeightRelPath(weightPath, kind, modelVersion), key: null };
    }
    const resolved = resolveWeightSourceFile(weightPath, rootDir, extraRoots, kind, modelVersion);
    if (!resolved || !fs.existsSync(resolved.absPath)) {
      missingWeights++;
      return { isPretrained: false, relPath: normalizeWeightRelPath(weightPath, kind, modelVersion), key: null };
    }
    const { size, fingerprint } = computeFileFingerprint(resolved.absPath);
    if (weightsByFp.has(fingerprint)) {
      const existing = weightsByFp.get(fingerprint);
      return { isPretrained: false, relPath: existing.relPath, key: existing.key, fingerprint };
    }
    const key = `w_${weightList.length}`;
    const entry = {
      key,
      kind,
      relPath: resolved.relPath,
      fingerprint,
      offset: currentOffset,
      length: size,
      _absPath: resolved.absPath
    };
    currentOffset += size;
    weightsByFp.set(fingerprint, entry);
    weightList.push(entry);
    return { isPretrained: false, relPath: resolved.relPath, key, fingerprint };
  };

  const manifestVoices = [];
  const audioSources = [];

  for (const v of voices) {
    const gptInfo = registerWeight(v.gptWeightsPath, 'gpt', v.modelVersion);
    const sovitsInfo = registerWeight(v.sovitsWeightsPath, 'sovits', v.modelVersion);

    let refAudioExt = 'wav';
    let refAudioOffset = -1;
    let refAudioLength = 0;

    if (v.refAudioPath && fs.existsSync(v.refAudioPath)) {
      try {
        const stat = fs.statSync(v.refAudioPath);
        if (stat.isFile() && stat.size > 0) {
          const m = String(v.refAudioPath).match(/\.([A-Za-z0-9]+)\s*$/);
          refAudioExt = m ? m[1].toLowerCase() : 'wav';
          refAudioOffset = currentOffset;
          refAudioLength = stat.size;
          currentOffset += stat.size;
          audioSources.push({ absPath: v.refAudioPath, length: stat.size });
        } else {
          missingAudio++;
        }
      } catch (_) {
        missingAudio++;
      }
    } else {
      missingAudio++;
    }

    manifestVoices.push({
      id: v.id,
      name: v.name || v.id,
      avatarType: v.avatarType || (v.gender === 'Male' ? 'man' : 'woman'),
      emotion: v.emotion || '通用',
      gender: v.gender || '',
      avatar: v.avatar || '',
      modelName: v.modelName || '',
      modelVersion: v.modelVersion || '',
      gptWeightsPath: gptInfo.relPath || v.gptWeightsPath || '',
      sovitsWeightsPath: sovitsInfo.relPath || v.sovitsWeightsPath || '',
      gptWeightKey: gptInfo.key,
      sovitsWeightKey: sovitsInfo.key,
      promptText: v.promptText || '',
      promptLang: v.promptLang || 'zh',
      refAudioExt,
      refAudioOffset,
      refAudioLength
    });
  }

  const manifest = {
    type: 'momovoicesub-voice-package',
    version: 2,
    exportedAt: new Date().toISOString(),
    weights: weightList.map(({ _absPath, ...rest }) => rest),
    voices: manifestVoices
  };

  const manifestBuf = Buffer.from(JSON.stringify(manifest), 'utf8');
  const headerBuf = Buffer.allocUnsafe(12);
  MAGIC.copy(headerBuf, 0);
  headerBuf.writeUInt32LE(FORMAT_VERSION, 4);
  headerBuf.writeUInt32LE(manifestBuf.length, 8);

  const tmpFile = `${filePath}.momo_tmp_${Date.now()}`;
  const outFd = fs.openSync(tmpFile, 'w');
  const copyBuf = Buffer.allocUnsafe(COPY_CHUNK_SIZE);

  const appendFileToOut = (srcPath, expectedLen) => {
    const inFd = fs.openSync(srcPath, 'r');
    try {
      let remaining = expectedLen;
      let pos = 0;
      while (remaining > 0) {
        const toRead = Math.min(copyBuf.length, remaining);
        const bytesRead = fs.readSync(inFd, copyBuf, 0, toRead, pos);
        if (bytesRead <= 0) throw new Error(`读取文件失败: ${srcPath}`);
        fs.writeSync(outFd, copyBuf, 0, bytesRead);
        pos += bytesRead;
        remaining -= bytesRead;
      }
    } finally {
      fs.closeSync(inFd);
    }
  };

  try {
    fs.writeSync(outFd, headerBuf);
    fs.writeSync(outFd, manifestBuf);
    for (const w of weightList) {
      appendFileToOut(w._absPath, w.length);
    }
    for (const a of audioSources) {
      appendFileToOut(a.absPath, a.length);
    }
  } catch (err) {
    try { fs.closeSync(outFd); } catch (_) {}
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (_) {}
    throw err;
  }

  fs.closeSync(outFd);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  fs.renameSync(tmpFile, filePath);

  return {
    ok: true,
    count: manifestVoices.length,
    packedWeightsCount: weightList.length,
    missingAudio,
    missingWeights,
    filePath
  };
}

/**
 * 解析并导入音色包文件（支持新版 .mvpkg 二进制完整音色包 与 旧版 .json 音色文件）
 */
function importVoicePackage({ filePath, rootDir, assetsDir }) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size < 4) {
      return { ok: false, error: '导入文件为空或已损坏' };
    }
    const head4 = Buffer.allocUnsafe(4);
    fs.readSync(fd, head4, 0, 4, 0);

    // 分支 A：新版 .mvpkg 二进制完整音色包
    if (head4.equals(MAGIC)) {
      if (stat.size < 12) {
        return { ok: false, error: '音色包文件头损坏' };
      }
      const metaBuf = Buffer.allocUnsafe(8);
      fs.readSync(fd, metaBuf, 0, 8, 4);
      const manifestLen = metaBuf.readUInt32LE(4);
      const dataBaseOffset = 12 + manifestLen;
      if (manifestLen <= 0 || dataBaseOffset > stat.size) {
        return { ok: false, error: '音色包清单数据损坏或文件不完整' };
      }

      const manifestBuf = Buffer.allocUnsafe(manifestLen);
      fs.readSync(fd, manifestBuf, 0, manifestLen, 12);
      let manifest;
      try {
        manifest = JSON.parse(manifestBuf.toString('utf8'));
      } catch (_) {
        return { ok: false, error: '音色包清单 JSON 解析失败' };
      }

      const rawVoices = Array.isArray(manifest.voices) ? manifest.voices : [];
      const rawWeights = Array.isArray(manifest.weights) ? manifest.weights : [];
      if (!rawVoices.length) {
        return { ok: false, error: '音色包中没有有效的音色数据' };
      }

      // 如果音色包含自训练模型权重，必须要求已设置有效的整合包目录 rootDir
      if (rawWeights.length > 0) {
        if (!rootDir || !fs.existsSync(rootDir)) {
          return {
            ok: false,
            error: '该音色包内含 GPT/SoVITS 模型权重，请先在「本地部署」中选择有效的 GPT-SoVITS 整合包目录后再导入'
          };
        }
      }

      // 1. 安装或复用模型权重（按 key 映射最终相对路径）
      const resolvedWeightPathByKey = new Map();
      let installedWeights = 0;
      let reusedWeights = 0;

      for (const w of rawWeights) {
        if (!w || !w.key || typeof w.offset !== 'number' || typeof w.length !== 'number') continue;
        const absOffset = dataBaseOffset + w.offset;
        if (absOffset + w.length > stat.size) {
          return { ok: false, error: `音色包内的模型权重文件（${w.relPath}）数据不完整，文件可能未下载完` };
        }
        const fingerprint = w.fingerprint || computeFdSliceFingerprint(fd, absOffset, w.length);
        const res = installOrReuseWeight({
          rootDir,
          relPath: w.relPath,
          fingerprint,
          byteLength: w.length,
          writeToFile: (destFilePath) => {
            copyFdRangeToFile(fd, absOffset, w.length, destFilePath);
          }
        });
        resolvedWeightPathByKey.set(w.key, res.relPath);
        if (res.action === 'reused') reusedWeights++;
        else installedWeights++;
      }

      // 2. 提取参考音频到 assetsDir 并组装音色条目
      if (!fs.existsSync(assetsDir)) {
        fs.mkdirSync(assetsDir, { recursive: true });
      }

      const importedVoices = [];
      for (const v of rawVoices) {
        if (!v || !v.name) continue;
        const newId = `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        let refAudioPath = '';

        if (typeof v.refAudioOffset === 'number' && v.refAudioOffset >= 0 && v.refAudioLength > 0) {
          const audioAbsOffset = dataBaseOffset + v.refAudioOffset;
          if (audioAbsOffset + v.refAudioLength <= stat.size) {
            const ext = String(v.refAudioExt || 'wav').replace(/[^A-Za-z0-9]/g, '') || 'wav';
            const targetAudioPath = path.join(assetsDir, `${newId}.${ext}`);
            copyFdRangeToFile(fd, audioAbsOffset, v.refAudioLength, targetAudioPath);
            refAudioPath = targetAudioPath;
          }
        } else if (v.refAudioBase64) {
          const ext = String(v.refAudioExt || 'wav').replace(/[^A-Za-z0-9]/g, '') || 'wav';
          const targetAudioPath = path.join(assetsDir, `${newId}.${ext}`);
          fs.writeFileSync(targetAudioPath, Buffer.from(String(v.refAudioBase64), 'base64'));
          refAudioPath = targetAudioPath;
        }

        if (!refAudioPath) continue;

        const finalGptPath = (v.gptWeightKey && resolvedWeightPathByKey.get(v.gptWeightKey))
          || v.gptWeightsPath
          || '';
        const finalSovitsPath = (v.sovitsWeightKey && resolvedWeightPathByKey.get(v.sovitsWeightKey))
          || v.sovitsWeightsPath
          || '';

        const gptCheckPath = finalGptPath && rootDir && !path.isAbsolute(finalGptPath)
          ? path.join(rootDir, finalGptPath)
          : finalGptPath;
        const sovitsCheckPath = finalSovitsPath && rootDir && !path.isAbsolute(finalSovitsPath)
          ? path.join(rootDir, finalSovitsPath)
          : finalSovitsPath;

        const gptExists = finalGptPath ? (rootDir ? fs.existsSync(gptCheckPath) : false) : true;
        const sovitsExists = finalSovitsPath ? (rootDir ? fs.existsSync(sovitsCheckPath) : false) : true;

        importedVoices.push({
          ...v,
          id: newId,
          gptWeightsPath: finalGptPath,
          sovitsWeightsPath: finalSovitsPath,
          refAudioPath,
          sourceRootDir: rootDir || '',
          weightsMissing: !(gptExists && sovitsExists)
        });
      }

      return {
        ok: true,
        isMvpkg: true,
        count: importedVoices.length,
        installedWeights,
        reusedWeights,
        voices: importedVoices
      };
    }

    // 分支 B：兼容旧版 .json 格式导入
    const rawText = fs.readFileSync(filePath, 'utf8');
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (_) {
      return { ok: false, error: '导入文件不是有效的音色包（.mvpkg 或 .json）格式' };
    }
    const raw = (data && Array.isArray(data.voices)) ? data.voices : [];
    if (!fs.existsSync(assetsDir)) {
      fs.mkdirSync(assetsDir, { recursive: true });
    }
    const importedVoices = [];
    for (const v of raw) {
      if (!v || !v.name || !v.refAudioBase64) continue;
      const newId = `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const ext = String(v.refAudioExt || 'wav').replace(/[^A-Za-z0-9]/g, '') || 'wav';
      const targetAudioPath = path.join(assetsDir, `${newId}.${ext}`);
      fs.writeFileSync(targetAudioPath, Buffer.from(String(v.refAudioBase64), 'base64'));

      const gptCheck = v.gptWeightsPath && rootDir && !path.isAbsolute(v.gptWeightsPath)
        ? path.join(rootDir, v.gptWeightsPath)
        : v.gptWeightsPath;
      const sovitsCheck = v.sovitsWeightsPath && rootDir && !path.isAbsolute(v.sovitsWeightsPath)
        ? path.join(rootDir, v.sovitsWeightsPath)
        : v.sovitsWeightsPath;
      const gptExists = v.gptWeightsPath ? (gptCheck ? fs.existsSync(gptCheck) : false) : true;
      const sovitsExists = v.sovitsWeightsPath ? (sovitsCheck ? fs.existsSync(sovitsCheck) : false) : true;

      importedVoices.push({
        ...v,
        id: newId,
        refAudioPath: targetAudioPath,
        weightsMissing: !(gptExists && sovitsExists)
      });
    }
    return {
      ok: true,
      isMvpkg: false,
      count: importedVoices.length,
      installedWeights: 0,
      reusedWeights: 0,
      voices: importedVoices
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 检查当前本地音色列表中，是否有模型权重在当前 rootDir 下缺失、但在旧整合包目录中存在（支持一键迁移）
 */
function inspectMissingWeights({ voices = [], rootDir, previousRootDir = '' }) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return { missingCount: 0, migratableItems: [], unresolvedVoices: [] };
  }

  const extraRoots = [];
  if (previousRootDir) extraRoots.push(previousRootDir);
  for (const v of voices) {
    if (v?.sourceRootDir) extraRoots.push(v.sourceRootDir);
  }

  const migratableByRelPath = new Map();
  const unresolvedVoices = [];

  for (const v of voices) {
    if (!v) continue;
    const pairs = [
      { path: v.gptWeightsPath, kind: 'gpt' },
      { path: v.sovitsWeightsPath, kind: 'sovits' }
    ];
    let voiceUnresolved = false;

    for (const item of pairs) {
      if (!item.path || isPretrainedWeightPath(item.path)) continue;
      const relPath = normalizeWeightRelPath(item.path, item.kind, v.modelVersion);
      const targetAbs = path.join(rootDir, relPath);
      if (fs.existsSync(targetAbs)) continue; // 当前整合包中已存在

      const resolved = resolveWeightSourceFile(item.path, '', extraRoots, item.kind, v.modelVersion)
        || resolveWeightSourceFile(item.path, rootDir, extraRoots, item.kind, v.modelVersion);

      if (resolved && resolved.absPath && fs.existsSync(resolved.absPath) && !resolved.inCurrentRoot) {
        if (!migratableByRelPath.has(relPath)) {
          migratableByRelPath.set(relPath, {
            relPath,
            sourceAbsPath: resolved.absPath,
            sourceRoot: resolved.sourceRoot || path.dirname(path.dirname(resolved.absPath)),
            voiceNames: [v.name || v.id]
          });
        } else {
          const entry = migratableByRelPath.get(relPath);
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
 * 执行旧整合包模型权重到当前 rootDir 的自动迁移（支持指纹比对与去重）
 */
function migrateMissingWeights({ voices = [], rootDir, previousRootDir = '' }) {
  const inspection = inspectMissingWeights({ voices, rootDir, previousRootDir });
  let migratedCount = 0;
  let reusedCount = 0;
  const updatedPathMap = new Map();

  for (const item of inspection.migratableItems) {
    if (!fs.existsSync(item.sourceAbsPath)) continue;
    const { size, fingerprint } = computeFileFingerprint(item.sourceAbsPath);
    const srcFd = fs.openSync(item.sourceAbsPath, 'r');
    try {
      const res = installOrReuseWeight({
        rootDir,
        relPath: item.relPath,
        fingerprint,
        byteLength: size,
        writeToFile: (destFilePath) => {
          copyFdRangeToFile(srcFd, 0, size, destFilePath);
        }
      });
      updatedPathMap.set(item.relPath, res.relPath);
      if (res.action === 'reused') reusedCount++;
      else migratedCount++;
    } finally {
      fs.closeSync(srcFd);
    }
  }

  return {
    ok: true,
    migratedCount,
    reusedCount,
    updatedPathMap: Object.fromEntries(updatedPathMap),
    unresolvedVoices: inspection.unresolvedVoices
  };
}

module.exports = {
  isPretrainedWeightPath,
  normalizeWeightRelPath,
  computeFileFingerprint,
  computeBufferFingerprint,
  resolveWeightSourceFile,
  installOrReuseWeight,
  exportVoicePackage,
  importVoicePackage,
  inspectMissingWeights,
  migrateMissingWeights
};
