'use strict';

const fs = (() => {
  try { return require('fs/promises'); } catch (_) {
    const _fs = require('fs');
    const { promisify } = require('util');
    return {
      readFile: promisify(_fs.readFile),
      writeFile: promisify(_fs.writeFile),
      mkdir: promisify(_fs.mkdir),
    };
  }
})();
const path = require('path');
const { sha1 } = require('./azure-tts');
const { wavDurationFrames } = require('./wav');
const { buildPreviewText } = require('./preview-text');

async function readCacheIndex(indexPath) {
  try {
    return JSON.parse(await fs.readFile(indexPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, entries: {} };
    throw error;
  }
}

async function writeCacheIndex(indexPath, index) {
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

async function updateCacheIndex(targetDir, cacheKey, entry) {
  const indexPath = path.join(targetDir, 'cache-index.json');
  const index = await readCacheIndex(indexPath);
  const previous = index.entries[cacheKey] || {};
  index.entries[cacheKey] = {
    ...previous,
    ...entry,
    updatedAt: new Date().toISOString()
  };
  await writeCacheIndex(indexPath, index);
}

/**
 * 规范化 Base URL，去除尾部斜杠
 */
function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * 剥离文本中的所有 SSML 标签和插件标注，提取纯文本
 */
function stripAnnotations(text, annotations) {
  if (!text) return '';
  let clean = String(text);
  // 剥离已内联的 SSML 标签，如 <phoneme ...>文字</phoneme>、<break .../>
  clean = clean.replace(/<phoneme\b[^>]*>(.*?)<\/phoneme>/gis, '$1');
  clean = clean.replace(/<break\b[^>]*\/?>/gis, '');
  clean = clean.replace(/<[^>]+>/g, '');
  // 剥离插件格式的标注 [pause:500ms]、[break:500ms]
  clean = clean.replace(/\[(?:pause|break):[^\]]+\]/gi, '');
  // 剥离字[拼音]格式的多音字标注，如 行[xing2] -> 行
  clean = clean.replace(/([\u4e00-\u9fa5])\[[a-zA-Z0-9\süÜ]+\]/g, '$1');
  return clean.trim();
}

/**
 * Azure 百分比语速 ('+10%', '-20%', '0%') 映射为浮点倍率 (1.10, 0.80, 1.0)
 */
function ratePercentToFactor(rateStr) {
  if (!rateStr) return 1.0;
  const num = parseFloat(String(rateStr).replace('%', ''));
  if (isNaN(num)) return 1.0;
  const factor = 1.0 + num / 100.0;
  return Math.max(0.25, Math.min(4.0, Math.round(factor * 100) / 100));
}

/**
 * 简单检测文本的主要语言代码 (用于 GPT-SoVITS 等引擎)
 */
function detectTextLang(text) {
  if (!text) return 'zh';
  const str = String(text);
  // 假名 (日文)
  if (/[\u3040-\u30ff]/.test(str)) return 'ja';
  // 谚文 (韩文)
  if (/[\uac00-\ud7af]/.test(str)) return 'ko';
  // CJK 统一表意汉字 (中文)
  if (/[\u4e00-\u9fa5]/.test(str)) return 'zh';
  // 默认英文
  return 'en';
}

/**
 * 校验 WAV 音频 Buffer 是否有效（至少 44 字节且含 RIFF WAVE 标识）
 */
function validateWavBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    throw new Error('本地服务返回了非 WAV 音频或音频数据损坏（数据长度不足），请检查服务配置。');
  }
  const header = buffer.toString('ascii', 0, 4);
  if (header !== 'RIFF') {
    throw new Error('本地服务返回了非 WAV 音频（可能默认返回了 MP3/OGG 等），请确认服务端支持 response_format/media_type 为 wav。');
  }
}

/**
 * 探测 GPT-SoVITS (api_v2.py) 服务是否存活并确实是 GPT-SoVITS 服务。
 *
 * 判定依据：GET /openapi.json 返回 200，且 paths 中确实存在 /tts 端点。
 * 任何网络异常 / 非 200 / 结构不符都会抛出可读错误，绝不返回 ok:true。
 *
 * @returns {Promise<{ok:true, version:string, endpoints:string[]}>}
 */
async function probeGptSoVits({ baseUrl, fetchImpl, timeoutMs = 3000 }) {
  const normUrl = normalizeBaseUrl(baseUrl);
  if (!normUrl) {
    throw new Error('未配置本地服务地址。');
  }

  const fetchFn = fetchImpl || globalThis.fetch;

  // Node 18+ 原生 AbortSignal.timeout；低版本回退到 AbortController
  let signal;
  let timer = null;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    signal = AbortSignal.timeout(timeoutMs);
  } else if (typeof AbortController !== 'undefined') {
    const controller = new AbortController();
    signal = controller.signal;
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  let res;
  try {
    res = await fetchFn(`${normUrl}/openapi.json`, { method: 'GET', signal });
  } catch (err) {
    const isTimeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new Error(isTimeout
      ? `连接超时（${timeoutMs}ms）：${normUrl} 无响应。请确认服务已启动、端口正确。`
      : `无法连接服务（${normUrl}）：${err.message}。请确认服务已启动、端口正确。`);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`服务响应异常（${normUrl}）：HTTP ${res.status} ${res.statusText}。`);
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`${normUrl} 返回的不是 JSON，可能不是 GPT-SoVITS 的 api_v2 服务（请确认地址未指向 webui 的 9874 端口）。`);
  }

  const paths = (json && json.paths && typeof json.paths === 'object') ? Object.keys(json.paths) : [];
  if (!paths.includes('/tts')) {
    throw new Error(`${normUrl} 已连通，但未发现 /tts 端点，不是 GPT-SoVITS 的 api_v2 服务。`);
  }

  return {
    ok: true,
    version: (json.info && json.info.version) || '',
    endpoints: paths
  };
}

class GptSoVitsAdapter {
  constructor({ fetchImpl }) {
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.lastWeights = { gpt: '', sovits: '' };
  }

  /**
   * 清空权重切换缓存。
   * api_v2.py 重启后会回到默认权重，而适配器无从感知，
   * 若不重置缓存，重启后的首次合成会沿用旧权重、声音不对。
   */
  resetWeightCache() {
    this.lastWeights = { gpt: '', sovits: '' };
  }

  async switchWeightsIfNeeded({ baseUrl, gptWeightsPath, sovitsWeightsPath }) {
    const normUrl = normalizeBaseUrl(baseUrl);
    if (gptWeightsPath && gptWeightsPath !== this.lastWeights.gpt) {
      try {
        await this.fetchImpl(`${normUrl}/set_gpt_weights?weights_path=${encodeURIComponent(gptWeightsPath)}`);
        this.lastWeights.gpt = gptWeightsPath;
      } catch {}
    }
    if (sovitsWeightsPath && sovitsWeightsPath !== this.lastWeights.sovits) {
      try {
        await this.fetchImpl(`${normUrl}/set_sovits_weights?weights_path=${encodeURIComponent(sovitsWeightsPath)}`);
        this.lastWeights.sovits = sovitsWeightsPath;
      } catch {}
    }
  }

  async synthesize({ baseUrl, voiceEntry, text, speed, textLang }) {
    const normUrl = normalizeBaseUrl(baseUrl);
    await this.switchWeightsIfNeeded({
      baseUrl: normUrl,
      gptWeightsPath: voiceEntry.gptWeightsPath,
      sovitsWeightsPath: voiceEntry.sovitsWeightsPath
    });

    const lang = (!textLang || textLang === 'auto') ? detectTextLang(text) : textLang;
    const body = {
      text: text,
      text_lang: lang,
      ref_audio_path: voiceEntry.refAudioPath || '',
      prompt_text: voiceEntry.promptText || '',
      prompt_lang: voiceEntry.promptLang || 'zh',
      aux_ref_audio_paths: voiceEntry.auxRefAudioPaths || [],
      speed_factor: Math.max(0.5, Math.min(2.0, speed || 1.0)),
      text_split_method: 'cut5',
      media_type: 'wav',
      streaming_mode: false
    };

    let res;
    try {
      res = await this.fetchImpl(`${normUrl}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (err) {
      const detail = (/fetch failed|ECONNREFUSED/i.test(err?.message || ''))
        ? '目标端口连接被拒绝，服务未在运行'
        : (err?.message || '未知网络错误');
      throw new Error(`无法连接 GPT-SoVITS 本地服务（${normUrl}）。请确认本地服务已启动且端口正确（${detail}）。`);
    }

    if (!res.ok) {
      let errDetail = '';
      try {
        const json = await res.json();
        errDetail = json.message || json.Exception || JSON.stringify(json);
      } catch {
        errDetail = await res.text().catch(() => '');
      }
      throw new Error(`GPT-SoVITS 本地服务报错 (${res.status}): ${errDetail || res.statusText}`);
    }

    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    validateWavBuffer(buffer);
    return buffer;
  }
}

/**
 * LocalTtsProvider
 * 仅支持 GPT-SoVITS 原生协议 (api_v2)，管理本地音色与合成缓存。
 *
 * baseUrl 的来源由 localTts.mode 决定：
 *   'managed' → 由插件托管的进程提供，地址恒为 http://127.0.0.1:<engine.port>
 *   'url'     → 用户手填的远程/本机地址
 */
class LocalTtsProvider {
  constructor({ getSettings, cacheDir, fetchImpl }) {
    this.getSettings = getSettings || (() => null);
    this.cacheDir = cacheDir;
    this.fetchImpl = fetchImpl || globalThis.fetch;

    this.gptsovitsAdapter = new GptSoVitsAdapter({ fetchImpl: this.fetchImpl });
  }

  async _getConfig() {
    const settings = await this.getSettings();
    const localTts = settings?.localTts || {};
    const engine = localTts.engine || {};

    // managed 模式下 baseUrl 由端口推导（插件托管的服务固定监听 127.0.0.1）
    const baseUrl = localTts.mode === 'managed'
      ? normalizeBaseUrl(`http://127.0.0.1:${engine.port || 9880}`)
      : normalizeBaseUrl(localTts.baseUrl);

    return {
      mode: localTts.mode === 'managed' ? 'managed' : 'url',
      engine,
      baseUrl,
      textLang: localTts.textLang || 'auto',
      voices: Array.isArray(localTts.voices) ? localTts.voices : []
    };
  }

  /**
   * 返回本地已配置的音色列表，映射为与 Azure 相同的 UI 结构
   */
  async listVoices() {
    const config = await this._getConfig();
    if (!config.voices.length) {
      return [];
    }

    return config.voices.map(v => ({
      shortName: v.id,
      displayName: v.name,
      localName: v.name,
      locale: v.promptLang || 'zh',
      gender: v.gender || 'Unknown',
      avatarType: v.avatarType || (v.gender === 'Male' ? 'man' : 'woman'),
      avatar: v.avatar,
      emotion: v.emotion || '通用',
      promptLang: v.promptLang || 'zh',
      modelName: v.modelName || '',
      modelVersion: v.modelVersion || '',
      refAudioPath: v.refAudioPath || '',
      styles: [],
      roles: [],
      wordsPerMinute: null,
      voiceType: 'LocalTTS',
      channel: 'local'
    }));
  }

  /**
   * 清空权重切换缓存（引擎重启后调用，避免沿用旧权重）
   */
  resetWeightCache() {
    this.gptsovitsAdapter.resetWeightCache();
  }

  /**
   * 测试服务连通性。
   *
   * 注意：GPT-SoVITS 的 api_v2 服务不提供"音色列表"接口，
   * 音色是「GPT权重 + SoVITS权重 + 参考音频 + 参考文本」的组合，由本插件本地维护。
   * 因此这里同时报告两件互不相关的事，措辞必须分开，避免误导。
   */
  async testConnection() {
    const config = await this._getConfig();
    if (!config.baseUrl) {
      throw new Error(config.mode === 'managed'
        ? '未配置 GPT-SoVITS 整合包目录或端口。'
        : '未配置本地服务地址 (Base URL)。');
    }

    const probe = await probeGptSoVits({
      baseUrl: config.baseUrl,
      fetchImpl: this.fetchImpl
    });

    return {
      ok: true,
      baseUrl: config.baseUrl,
      endpoints: probe.endpoints,
      // 服务端音色数对 GPT-SoVITS 恒为 0（服务端无此概念），这里报的是本地已入库的音色数
      count: config.voices.length,
      message: `GPT-SoVITS 服务已连接（${config.baseUrl}）。`,
      detail: config.voices.length
        ? `本地音色库共 ${config.voices.length} 个音色。`
        : '本地音色库为空：点击下方「+ 新增音色」，选择已训练的模型并指定参考音频即可开始配音。'
    };
  }

  /**
   * 合成语音（本地通道刻意不做"内容缓存"）。
   *
   * 与 Azure/云端不同：本地部署没有 token 成本，且 GPT-SoVITS 每次合成
   * 都有随机性（文本+音色完全相同，两次结果也可能不同）。因此每次点击
   * 生成都应真实调用一次服务，绝不返回旧音频：
   *   - 不检查/不复用磁盘缓存，cacheHit 恒为 false；
   *   - 输出文件带唯一后缀命名，保证「重新生成并替换」导入的是全新音频，
   *     不会被达芬奇按同路径去重成旧文件；
   *   - 文件仍落在项目缓存目录供时间线引用，未引用的旧文件由
   *     「缓存管理 → 删除未使用缓存」统一清理。
   */
  async synthesize({
    text,
    voice,
    rate,
    pitch,
    style,
    role,
    styledegree,
    volume,
    annotations,
    cacheKey,
    timelineFps = 24,
    cacheDir
  }) {
    const config = await this._getConfig();
    if (!config.baseUrl) {
      throw new Error('未配置本地服务地址，请在 设置 → 本地部署 中配置整合包目录或服务地址。');
    }

    // 匹配 voice 配置项（按 shortName/id 查找）
    const voiceEntry = config.voices.find(v => v.id === voice) || {
      id: voice,
      name: voice
    };

    const cleanText = stripAnnotations(text, annotations);
    if (!cleanText) {
      throw new Error('要配音的文本为空。');
    }
    const speed = ratePercentToFactor(rate);

    const audioBuffer = await this.gptsovitsAdapter.synthesize({
      baseUrl: config.baseUrl,
      voiceEntry,
      text: cleanText,
      speed,
      textLang: config.textLang
    });

    const duration = wavDurationFrames(audioBuffer, timelineFps);
    if (!duration || duration.durationFrames === 0) {
      throw new Error('音色合成失败：本地服务返回了 0 帧空音频，请检查音色配置或模型状态。');
    }

    const targetDir = cacheDir || this.cacheDir;
    if (!targetDir) throw new Error('Cache directory is required');
    await fs.mkdir(targetDir, { recursive: true });

    // 唯一文件后缀：同一条字幕重新生成时产生新文件，让插入的始终是本次合成的音频
    const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const filePath = path.join(targetDir, `momo_${nonce}.wav`);
    await fs.writeFile(filePath, audioBuffer);

    return {
      filePath,
      durationFrames: duration.durationFrames,
      sampleRate: duration.sampleRate,
      cacheHit: false
    };
  }

  /**
   * 试听预览音频合成。
   *
   * 试听缓存是刻意保留的（与正式合成相反）：试听只是听音色，结果不确定
   * 也不影响成片，缓存后反复试听不再重复消耗本地算力。
   * 但缓存键除了音色 id 还要带上音色参数签名——同一音色的权重/参考音频
   * 被编辑后，下次试听应自动重新合成，而不是继续播旧的。
   */
  synthesizePreview(payload) {
    const key = String((payload && payload.shortName) || '');
    if (!this.previewLocks) this.previewLocks = new Map();
    if (!key) return this._doPreview(payload);
    // 同一音色的试听正在合成中时，直接复用该次请求，避免快速连点重复合成
    if (this.previewLocks.has(key)) return this.previewLocks.get(key);
    const task = this._doPreview(payload).finally(() => this.previewLocks.delete(key));
    this.previewLocks.set(key, task);
    return task;
  }

  _voiceSig(voiceEntry) {
    return sha1(JSON.stringify({
      gpt: voiceEntry.gptWeightsPath || '',
      sovits: voiceEntry.sovitsWeightsPath || '',
      ref: voiceEntry.refAudioPath || '',
      prompt: voiceEntry.promptText || '',
      promptLang: voiceEntry.promptLang || ''
    }));
  }

  async _doPreview({ shortName, localName, displayName, locale, previewDir }) {
    const config = await this._getConfig();
    const targetDir = previewDir || this.cacheDir;
    if (!targetDir) throw new Error('Cache directory is required');

    const previewCacheDir = path.join(targetDir, 'preview');
    await fs.mkdir(previewCacheDir, { recursive: true });

    const voiceEntry = config.voices.find(v => v.id === shortName) || {
      id: shortName,
      name: displayName || localName || shortName
    };
    const sig = this._voiceSig(voiceEntry);

    const previewText = buildPreviewText({
      locale: locale || 'zh-CN',
      localName: voiceEntry.name,
      displayName: voiceEntry.name
    });

    const safeShortName = String(shortName || '').replace(/[:<>"/\\|?*]/g, '_');
    const fileName = `preview_${safeShortName}.wav`;
    const defaultFilePath = path.join(previewCacheDir, fileName);

    // 检查试听缓存（文本 + 音色签名都一致才算严格命中）
    const indexPath = path.join(previewCacheDir, 'preview-index.json');
    const index = await readCacheIndex(indexPath);
    const cached = index.entries[shortName];
    if (cached && cached.sig === sig && cached.text === previewText) {
      const cachedPath = path.join(previewCacheDir, cached.file || fileName);
      try {
        const wavBuffer = await fs.readFile(cachedPath);
        if (wavBuffer.length >= 44) {
          index.entries[shortName].lastPreviewedAt = new Date().toISOString();
          await writeCacheIndex(indexPath, index);
          return { wavBuffer, cacheHit: true };
        }
      } catch {}
    }

    // 若未严格命中（如新音色、或音色重新编辑），尝试请求本地服务合成；
    // 若服务未启动或连接失败，则安全降级复用已有的历史试听音频（如果有）
    let wavBuffer;
    try {
      if (!config.baseUrl) {
        throw new Error('未配置本地服务地址。');
      }
      wavBuffer = await this.gptsovitsAdapter.synthesize({
        baseUrl: config.baseUrl,
        voiceEntry,
        text: previewText,
        speed: 1.0,
        textLang: config.textLang
      });
    } catch (err) {
      // 检查是否有历史试听缓存可用（优先 index 记录的文件，其次默认命名规范文件）
      const candidatePaths = [
        cached?.file ? path.join(previewCacheDir, cached.file) : null,
        defaultFilePath
      ].filter(Boolean);

      for (const p of candidatePaths) {
        try {
          const fallbackBuffer = await fs.readFile(p);
          if (fallbackBuffer && fallbackBuffer.length >= 44) {
            // 命中历史缓存降级，直接返回播放
            return { wavBuffer: fallbackBuffer, cacheHit: true, fallback: true };
          }
        } catch {}
      }

      // 确实无任何历史缓存可用时，才抛出服务连接失败错误
      throw err;
    }

    await fs.writeFile(defaultFilePath, wavBuffer);

    index.entries[shortName] = {
      file: fileName,
      shortName,
      localName: voiceEntry.name,
      text: previewText,
      sig,
      createdAt: new Date().toISOString(),
      lastPreviewedAt: new Date().toISOString(),
      source: 'local'
    };
    await writeCacheIndex(indexPath, index);

    return { wavBuffer, cacheHit: false };
  }
}

module.exports = {
  LocalTtsProvider,
  GptSoVitsAdapter,
  probeGptSoVits,
  stripAnnotations,
  ratePercentToFactor,
  detectTextLang,
  normalizeBaseUrl
};
