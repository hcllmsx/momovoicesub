// @ts-ignore
import uxp from "uxp";
import { sha1 } from "./sha1";
import { wavDurationFrames } from "./wav";
import { buildPreviewText } from "./preview-text";
import { getProjectCacheFolder } from "./azure-tts";

const storage = uxp.storage;
const fs = storage.localFileSystem;

export interface ProbeResult {
  ok: boolean;
  ready?: boolean;
  version?: string;
  endpoints?: string[];
  error?: string;
}

/**
 * 规范化 Base URL，去除尾部斜杠
 */
export function normalizeBaseUrl(url?: string): string {
  return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * 剥离文本中的所有 SSML 标签和插件标注，提取纯文本
 */
export function stripAnnotations(text?: string, _annotations?: any): string {
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
export function ratePercentToFactor(rateStr?: string): number {
  if (!rateStr) return 1.0;
  const num = parseFloat(String(rateStr).replace('%', ''));
  if (isNaN(num)) return 1.0;
  const factor = 1.0 + num / 100.0;
  return Math.max(0.25, Math.min(4.0, Math.round(factor * 100) / 100));
}

/**
 * 简单检测文本的主要语言代码 (用于 GPT-SoVITS 等引擎)
 */
export function detectTextLang(text?: string): string {
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
 * 校验 WAV 音频 ArrayBuffer 是否有效（至少 44 字节且含 RIFF WAVE 标识）
 */
export function validateWavBuffer(buffer: ArrayBuffer | Uint8Array): void {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < 44) {
    throw new Error('本地服务返回了非 WAV 音频或音频数据损坏（数据长度不足），请检查服务配置。');
  }
  const header = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (header !== 'RIFF') {
    throw new Error('本地服务返回了非 WAV 音频（可能默认返回了 MP3/OGG 等），请确认服务端支持 response_format/media_type 为 wav。');
  }
}

/**
 * 探测 GPT-SoVITS (api_v2.py) 服务是否存活并确实是 GPT-SoVITS 服务。
 */
export async function probeGptSoVits(
  arg: string | { baseUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number }
): Promise<ProbeResult> {
  const baseUrl = typeof arg === 'string' ? arg : arg.baseUrl;
  const fetchImpl = typeof arg === 'object' ? arg.fetchImpl : undefined;
  const timeoutMs = (typeof arg === 'object' && arg.timeoutMs) ? arg.timeoutMs : 3000;

  const normUrl = normalizeBaseUrl(baseUrl);
  if (!normUrl) {
    return { ok: false, ready: false, error: '未配置本地服务地址。' };
  }

  const fetchFn = fetchImpl || globalThis.fetch;

  let signal: any;
  let timer: any = null;
  if (typeof AbortSignal !== 'undefined' && typeof (AbortSignal as any).timeout === 'function') {
    signal = (AbortSignal as any).timeout(timeoutMs);
  } else if (typeof AbortController !== 'undefined') {
    const controller = new AbortController();
    signal = controller.signal;
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  let res: Response;
  try {
    res = await fetchFn(`${normUrl}/openapi.json`, { method: 'GET', signal });
  } catch (err: any) {
    if (timer) clearTimeout(timer);
    const isTimeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const msg = isTimeout
      ? `连接超时（${timeoutMs}ms）：${normUrl} 无响应。请确认服务已启动、端口正确。`
      : `无法连接服务（${normUrl}）：${err?.message || err}。请确认服务已启动、端口正确。`;
    return { ok: false, ready: false, error: msg };
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res.ok) {
    return { ok: false, ready: false, error: `服务响应异常（${normUrl}）：HTTP ${res.status} ${res.statusText}。` };
  }

  let json: any;
  try {
    json = await res.json();
  } catch {
    return { ok: false, ready: false, error: `${normUrl} 返回的不是 JSON，可能不是 GPT-SoVITS 的 api_v2 服务。` };
  }

  const paths = (json && json.paths && typeof json.paths === 'object') ? Object.keys(json.paths) : [];
  if (!paths.includes('/tts')) {
    return { ok: false, ready: false, error: `${normUrl} 已连通，但未发现 /tts 端点，不是 GPT-SoVITS 的 api_v2 服务。` };
  }

  return {
    ok: true,
    ready: true,
    version: (json.info && json.info.version) || '',
    endpoints: paths
  };
}

export class GptSoVitsAdapter {
  private fetchImpl: typeof fetch;
  private lastWeights: { gpt: string; sovits: string };

  constructor({ fetchImpl }: { fetchImpl?: typeof fetch } = {}) {
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.lastWeights = { gpt: '', sovits: '' };
  }

  resetWeightCache(): void {
    this.lastWeights = { gpt: '', sovits: '' };
  }

  async switchWeightsIfNeeded({
    baseUrl,
    gptWeightsPath,
    sovitsWeightsPath
  }: {
    baseUrl: string;
    gptWeightsPath?: string;
    sovitsWeightsPath?: string;
  }): Promise<void> {
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

  async synthesize({
    baseUrl,
    voiceEntry,
    text,
    speed,
    textLang
  }: {
    baseUrl: string;
    voiceEntry: any;
    text: string;
    speed?: number;
    textLang?: string;
  }): Promise<ArrayBuffer> {
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

    let res: Response;
    try {
      res = await this.fetchImpl(`${normUrl}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (err: any) {
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
    validateWavBuffer(arrayBuf);
    return arrayBuf;
  }
}

async function readCacheIndex(entry: any): Promise<any> {
  try {
    const raw = await entry.read({ format: storage.formats.utf8 });
    return JSON.parse(raw);
  } catch (_) {
    return { version: 1, entries: {} };
  }
}

async function writeCacheIndex(folder: any, index: any): Promise<void> {
  const entry = await folder.createEntry('preview-index.json', { overwrite: true });
  await entry.write(JSON.stringify(index, null, 2), { format: storage.formats.utf8 });
}

export class LocalTtsProvider {
  private getSettings: () => Promise<any>;
  private fetchImpl: typeof fetch;
  public gptsovitsAdapter: GptSoVitsAdapter;
  private previewLocks: Map<string, Promise<any>>;

  constructor({
    getSettings,
    fetchImpl
  }: {
    getSettings: () => Promise<any>;
    fetchImpl?: typeof fetch;
  }) {
    this.getSettings = getSettings || (() => Promise.resolve(null));
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.gptsovitsAdapter = new GptSoVitsAdapter({ fetchImpl: this.fetchImpl });
    this.previewLocks = new Map();
  }

  async getConfig(): Promise<{
    mode: 'managed' | 'url';
    engine: any;
    baseUrl: string;
    textLang: string;
    voices: any[];
  }> {
    const settings = await this.getSettings();
    const localTts = settings?.localTts || {};
    const engine = localTts.engine || {};

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

  async listVoices(): Promise<any[]> {
    const config = await this.getConfig();
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
      gptWeightsPath: v.gptWeightsPath || '',
      sovitsWeightsPath: v.sovitsWeightsPath || '',
      styles: [],
      roles: [],
      wordsPerMinute: null,
      voiceType: 'LocalTTS',
      channel: 'local'
    }));
  }

  resetWeightCache(): void {
    this.gptsovitsAdapter.resetWeightCache();
  }

  async testConnection(): Promise<{
    ok: true;
    baseUrl: string;
    endpoints: string[];
    count: number;
    message: string;
    detail: string;
  }> {
    const config = await this.getConfig();
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
      endpoints: probe.endpoints || [],
      count: config.voices.length,
      message: `GPT-SoVITS 服务已连接（${config.baseUrl}）。`,
      detail: config.voices.length
        ? `本地音色库共 ${config.voices.length} 个音色。`
        : '本地音色库为空：点击下方「+ 新增音色」，选择已训练的模型并指定参考音频即可开始配音。'
    };
  }

  async synthesize({
    text,
    voice,
    rate,
    annotations,
    timelineFps = 24,
    cacheFolder,
    projectName
  }: {
    text: string;
    voice?: string;
    rate?: string;
    annotations?: any;
    timelineFps?: number;
    cacheFolder?: any;
    projectName?: string;
  }): Promise<{
    filePath: string;
    durationFrames: number;
    sampleRate: number;
    cacheHit: boolean;
  }> {
    const config = await this.getConfig();
    if (!config.baseUrl) {
      throw new Error('未配置本地服务地址，请在 设置 → 本地部署 中配置整合包目录或服务地址。');
    }

    const voiceEntry = config.voices.find(v => v.id === voice) || {
      id: voice,
      name: voice
    };

    const cleanText = stripAnnotations(text, annotations);
    if (!cleanText) {
      throw new Error('要配音的文本为空。');
    }
    const speed = ratePercentToFactor(rate);

    const audioArrayBuffer = await this.gptsovitsAdapter.synthesize({
      baseUrl: config.baseUrl,
      voiceEntry,
      text: cleanText,
      speed,
      textLang: config.textLang
    });

    const duration = wavDurationFrames(audioArrayBuffer, timelineFps);
    if (!duration || duration.durationFrames === 0) {
      throw new Error('音色合成失败：本地服务返回了 0 帧空音频，请检查音色配置或模型状态。');
    }

    let targetFolder = cacheFolder;
    if (!targetFolder) {
      try {
        targetFolder = await getProjectCacheFolder(projectName || 'default');
      } catch (_) {
        try {
          const dataFolder = await fs.getDataFolder();
          try {
            targetFolder = await dataFolder.getEntry('cache');
          } catch (_) {
            targetFolder = await dataFolder.createFolder('cache');
          }
        } catch (_) {}
      }
    }

    if (!targetFolder) {
      throw new Error('缺少缓存目录对象 (cacheFolder)');
    }

    // 唯一文件后缀：同一条字幕重新生成时产生新文件，让插入的始终是本次合成的音频
    const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const fileName = `momo_${nonce}.wav`;
    const newFile = await targetFolder.createEntry(fileName, { overwrite: true });
    await newFile.write(audioArrayBuffer, { format: storage.formats.binary });

    return {
      filePath: newFile.nativePath,
      durationFrames: duration.durationFrames,
      sampleRate: duration.sampleRate,
      cacheHit: false
    };
  }

  synthesizePreview(payload: any): Promise<{ wavBuffer: ArrayBuffer; cacheHit: boolean; fallback?: boolean }> {
    const key = String((payload && payload.shortName) || '');
    if (!key) return this._doPreview(payload);
    if (this.previewLocks.has(key)) return this.previewLocks.get(key)!;
    const task = this._doPreview(payload).finally(() => this.previewLocks.delete(key));
    this.previewLocks.set(key, task);
    return task;
  }

  private async _voiceSig(voiceEntry: any): Promise<string> {
    return sha1(JSON.stringify({
      gpt: voiceEntry.gptWeightsPath || '',
      sovits: voiceEntry.sovitsWeightsPath || '',
      ref: voiceEntry.refAudioPath || '',
      prompt: voiceEntry.promptText || '',
      promptLang: voiceEntry.promptLang || ''
    }));
  }

  private async _doPreview({
    shortName,
    localName,
    displayName,
    locale,
    previewFolder
  }: {
    shortName: string;
    localName?: string;
    displayName?: string;
    locale?: string;
    previewFolder?: any;
  }): Promise<{ wavBuffer: ArrayBuffer; cacheHit: boolean; fallback?: boolean }> {
    let targetFolder = previewFolder;
    if (!targetFolder) {
      try {
        const dataFolder = await fs.getDataFolder();
        try {
          targetFolder = await dataFolder.getEntry('preview');
        } catch (_) {
          targetFolder = await dataFolder.createFolder('preview');
        }
      } catch (err: any) {
        throw new Error('获取试听缓存目录失败: ' + (err?.message || err));
      }
    }
    previewFolder = targetFolder;
    const config = await this.getConfig();

    const voiceEntry = config.voices.find(v => v.id === shortName) || {
      id: shortName,
      name: displayName || localName || shortName
    };
    const sig = await this._voiceSig(voiceEntry);

    const previewText = buildPreviewText({
      locale: locale || 'zh-CN',
      localName: voiceEntry.name,
      displayName: voiceEntry.name
    });

    const safeShortName = String(shortName || '').replace(/[:<>"/\\|?*]/g, '_');
    const fileName = `preview_${safeShortName}.wav`;

    // 检查试听缓存（文本 + 音色签名都一致才算严格命中）
    let index: any = { version: 1, entries: {} };
    let indexEntry: any = null;
    try {
      indexEntry = await previewFolder.getEntry('preview-index.json');
      if (indexEntry && indexEntry.isFile) {
        index = await readCacheIndex(indexEntry);
      }
    } catch (_) {}

    const cached = index.entries ? index.entries[shortName] : null;
    if (cached && cached.sig === sig && cached.text === previewText) {
      try {
        const fileEntry = await previewFolder.getEntry(cached.file || fileName);
        if (fileEntry && fileEntry.isFile) {
          const wavBuffer = await fileEntry.read({ format: storage.formats.binary });
          if (wavBuffer && wavBuffer.byteLength >= 44) {
            index.entries[shortName].lastPreviewedAt = new Date().toISOString();
            await writeCacheIndex(previewFolder, index);
            return { wavBuffer, cacheHit: true };
          }
        }
      } catch (_) {}
    }

    let wavBuffer: ArrayBuffer;
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
      // 检查是否有历史试听缓存可用降级播放
      try {
        const fallbackFile = await previewFolder.getEntry(cached?.file || fileName);
        if (fallbackFile && fallbackFile.isFile) {
          const fallbackBuffer = await fallbackFile.read({ format: storage.formats.binary });
          if (fallbackBuffer && fallbackBuffer.byteLength >= 44) {
            return { wavBuffer: fallbackBuffer, cacheHit: true, fallback: true };
          }
        }
      } catch (_) {}
      throw err;
    }

    const newFile = await previewFolder.createEntry(fileName, { overwrite: true });
    await newFile.write(wavBuffer, { format: storage.formats.binary });

    if (!index.entries) index.entries = {};
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
    await writeCacheIndex(previewFolder, index);

    return { wavBuffer, cacheHit: false };
  }
}
