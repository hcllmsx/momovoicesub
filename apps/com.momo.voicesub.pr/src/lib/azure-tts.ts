// @ts-ignore
import uxp from "uxp";
import { wavDurationFrames } from "./wav";
import { sha1Hex } from "./sha1";
import polyphonicBuiltin from "./polyphonic-builtin.json";

const storage = uxp.storage;
const fs = storage.localFileSystem;

const DEFAULT_OUTPUT_FORMAT = 'riff-24khz-16bit-mono-pcm';

const STYLE_CN_MAP: Record<string, string> = {
  'general': '通用',
  'chat': '聊天',
  'cheerful': '愉快',
  'sad': '悲伤',
  'angry': '愤怒',
  'fearful': '恐惧',
  'excited': '激动',
  'friendly': '友好',
  'gentle': '温柔',
  'lyrical': '抒情',
  'serious': '严肃',
  'poetry-reading': '诗歌朗读',
  'customercare': '客服',
  'newscast': '新闻',
  'assistant': '助手',
  'embarrassed': '尴尬',
  'calm': '平静',
  'hopeful': '希望',
  'disgruntled': '不满',
  'whispering': '低语',
  'shouting': '喊叫',
  'unfriendly': '不友好',
  'terrified': '惊恐',
  'sorrowful': '悲伤',
  'narration-professional': '专业叙述',
  'narration-relaxed': '轻松叙述',
  'narration-sports': '体育解说',
  'narration-sports-excited': '激动解说',
  'documentary-narration': '纪录片旁白',
  'live-commercial': '直播带货',
  'affectionate': '亲切',
  'customerservice': '客户服务',
  'envy': '嫉妒',
  'depressed': '沮丧',
  'prosody': '韵律',
  'advertisement_upbeat': '广告 upbeat',
  'sports_commentary': '体育评论',
  'sports_commentary_excited': '激动评论',
  'customerservice_deprecated': '客服(旧)'
};

/**
 * 计算字符串的 SHA-1 十六进制摘要。
 *
 * PR UXP 运行时没有全局 TextEncoder，也不支持 crypto.subtle.digest，
 * 所以这里改用纯 JS 实现的 sha1Hex（见 lib/sha1.ts）。
 *
 * 保留 async 包装是为了维持原有调用点 `await sha1(...)` 的签名不变。
 */
function sha1(value: string): Promise<string> {
  return Promise.resolve(sha1Hex(value));
}

function escapeXml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function styleNameCn(style: string): string {
  return STYLE_CN_MAP[style] || style;
}

/**
 * 清理字符串使其可安全用于文件名：移除 Windows 非法字符与控制字符，并截断到指定长度。
 */
function sanitizeForFileName(s: string, maxLen = 20): string {
  if (!s) return '';
  const cleaned = String(s)
    .replace(/[\/\\:*?"<>|]/g, '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

/**
 * 将项目名清理为可安全用于文件夹名的字符串。
 *
 * 与达芬奇版 sanitizeName 行为对齐：移除 Windows 非法字符，空白转为下划线，
 * 截断到 80 字符。空字符串回退为 'untitled'，避免目录名为空。
 *
 * 这里的清理比 sanitizeForFileName 更宽松（保留中日韩字符、括号等），
 * 因为项目名通常含有中文和括号，过度清理会让目录名不可读。
 */
function sanitizeProjectName(name: string): string {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|#%&{}$!'@+`=]/g, '_')
    .replace(/\s+/g, '_')
    .trim();
  const result = cleaned.length > 80 ? cleaned.slice(0, 80) : cleaned;
  return result || 'untitled';
}

function normalizeEndpoint(settings: any = {}) {
  const explicit = String(settings.endpoint || '').trim().replace(/\/+$/, '');
  const region = String(settings.region || '').trim().toLowerCase();

  if (explicit) {
    if (/\/cognitiveservices\/v1$/i.test(explicit)) {
      return {
        synthUrl: explicit,
        voicesUrl: explicit.replace(/\/cognitiveservices\/v1$/i, '/cognitiveservices/voices/list')
      };
    }
    if (/\.cognitiveservices\.azure\.com$/i.test(explicit)) {
      return {
        synthUrl: `${explicit}/cognitiveservices/v1`,
        voicesUrl: `${explicit}/tts/cognitiveservices/voices/list`
      };
    }
    return {
      synthUrl: `${explicit}/cognitiveservices/v1`,
      voicesUrl: `${explicit}/cognitiveservices/voices/list`
    };
  }

  if (!region) {
    throw new Error('Azure region or endpoint is required');
  }

  return {
    synthUrl: `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    voicesUrl: `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`
  };
}

export function applyPolyphonicDict(text: string, userDict: any[]): string {
  if (!text) return text;

  const allDict = [...(userDict || []), ...polyphonicBuiltin];

  const charToEntries: Record<string, any[]> = {};
  for (const entry of allDict) {
    if (!entry.char) continue;
    if (!charToEntries[entry.char]) charToEntries[entry.char] = [];
    const exists = charToEntries[entry.char].some(e => e.pinyin === entry.pinyin && e.phonetic === entry.phonetic);
    if (!exists) charToEntries[entry.char].push(entry);
  }

  const parts = text.split(/(<[^>]+>)/g);

  let insidePhoneme = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith('<')) {
      if (/^<phoneme\b/i.test(part)) insidePhoneme++;
      else if (/^<\/phoneme>/i.test(part)) insidePhoneme = Math.max(0, insidePhoneme - 1);
      continue;
    }
    if (insidePhoneme > 0) continue;

    let segment = part;
    for (const [char, entries] of Object.entries(charToEntries)) {
      if (entries.length === 1) {
        const entry = entries[0];
        let ph = (entry.phonetic || '').trim();
        if (ph && !ph.includes(' ')) {
          ph = ph.replace(/^([a-zA-Züü]+)([1-5])$/i, '$1 $2');
        }
        const regex = new RegExp(char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        segment = segment.replace(regex, (match) =>
          `<phoneme alphabet="sapi" ph="${escapeXml(ph)}">${match}</phoneme>`
        );
      }
    }
    parts[i] = segment;
  }

  return parts.join('');
}

export function applyManualAnnotations(text: string, annotations: any[]): string {
  if (!text || !annotations || !annotations.length) return text;

  let result = text;
  const sorted = [...annotations].sort((a, b) => (b.start || 0) - (a.start || 0));

  for (const ann of sorted) {
    const start = ann.start;
    const end = ann.end || start + 1;

    if (ann.type === 'phoneme' && ann.phonetic) {
      let ph = ann.phonetic.trim();
      if (ph && !ph.includes(' ')) {
        ph = ph.replace(/^([a-zA-Züü]+)([1-5])$/i, '$1 $2');
      }
      const originalChar = result.slice(start, end);
      const phonemeTag = `<phoneme alphabet="sapi" ph="${escapeXml(ph)}">${escapeXml(originalChar)}</phoneme>`;
      result = result.slice(0, start) + phonemeTag + result.slice(end);
    } else if (ann.type === 'break') {
      const breakMs = typeof ann.duration === 'number' ? `${ann.duration}ms` : (ann.duration || '500ms');
      const breakTag = breakMs === 'none'
        ? '<break strength="none"/>'
        : `<break time="${escapeXml(breakMs)}"/>`;
      result = result.slice(0, start) + breakTag + result.slice(start);
    }
  }

  return result;
}

export function buildSsml({ text, voice, style, rate, pitch, styledegree, role, volume, annotations, polyphonicDict }: any): string {
  if (!text || !String(text).trim()) {
    throw new Error('Text is required');
  }

  const voiceName = voice || 'zh-CN-XiaoxiaoNeural';
  let content = text;
  const hasUserTags = /<phoneme\b/i.test(text);

  if (annotations && annotations.length) {
    content = applyManualAnnotations(text, annotations);
  }

  if (polyphonicDict && polyphonicDict.length) {
    content = applyPolyphonicDict(content, polyphonicDict);
  }

  if (!annotations?.length && !polyphonicDict?.length && !hasUserTags) {
    content = escapeXml(text);
  }

  const prosodyAttrs = [];
  if (rate && rate !== '0%') prosodyAttrs.push(`rate="${escapeXml(rate)}"`);
  if (pitch && pitch !== '0%') prosodyAttrs.push(`pitch="${escapeXml(pitch)}"`);
  if (volume && volume !== '100%') prosodyAttrs.push(`volume="${escapeXml(volume)}"`);

  if (prosodyAttrs.length > 0) {
    content = `<prosody ${prosodyAttrs.join(' ')}>${content}</prosody>`;
  }

  if (style) {
    const expressAttrs = [`style="${escapeXml(style)}"`];
    if (styledegree && styledegree !== '1.0') expressAttrs.push(`styledegree="${escapeXml(styledegree)}"`);
    if (role) expressAttrs.push(`role="${escapeXml(role)}"`);
    content = `<mstts:express-as ${expressAttrs.join(' ')}>${content}</mstts:express-as>`;
  }

  return [
    '<speak version="1.0"',
    ' xmlns="http://www.w3.org/2001/10/synthesis"',
    ' xmlns:mstts="https://www.w3.org/2001/mstts"',
    ' xml:lang="zh-CN">',
    `<voice name="${escapeXml(voiceName)}">${content}</voice>`,
    '</speak>'
  ].join('');
}

/**
 * 获取基础缓存目录（cache/），是所有项目子目录的父目录。
 *
 * 该目录下不直接存放音频文件，而是按项目名分子目录：
 *   cache/{projectName}/momo_xxx.wav
 *   cache/{projectName}/cache-index.json
 *
 * 仅用于：
 * - "打开缓存目录"（展示父目录，让用户看到所有项目）
 * - "删除全部缓存"（遍历所有项目子目录）
 */
export async function getBaseCacheFolder() {
  const dataFolder = await fs.getDataFolder();
  let cacheFolder;
  try {
    cacheFolder = await dataFolder.getEntry('cache');
  } catch (_) {
    cacheFolder = await dataFolder.createFolder('cache');
  }
  return cacheFolder;
}

/**
 * 判断 entry 是否为文件夹。
 *
 * 不使用 entry.isDirectory 属性，因为在某些 UXP 运行时版本中该属性可能为
 * undefined，会导致已存在的文件夹被误判为“不是文件夹”，进而触发
 * createFolder 并抛 "A Folder with given name exists" 错误。
 *
 * 改用 typeof entry.getEntries === 'function' 判断：只有 Folder 对象才有
 * getEntries 方法，File 对象没有。这是最可靠的方式。
 */
function isFolderEntry(entry: any): boolean {
  return !!entry && typeof entry.getEntries === 'function';
}

/**
 * 获取当前项目的缓存目录（cache/{projectName}/）。
 *
 * 不同工程的缓存完全隔离：
 * - 避免 hash 冲突时误删其他工程的缓存（两个工程有同一句字幕+同一音色时，
 *   hash 相同、文件名相同，若共用目录会互相覆盖/误删）。
 * - "删除当前工程缓存"只删除当前项目子目录，不影响其他工程。
 *
 * 同一项目内不同序列可以复用缓存（节省 Azure 调用），因为缓存键仅基于
 * 文本+音色+参数，与序列无关。
 *
 * 实现说明：
 * - 用 getEntry 尝试获取已存在的文件夹，失败则 createFolder 创建
 * - 不检查 isDirectory 属性（某些 UXP 版本下不可靠）
 * - 用 promise 去重避免并发调用时重复 createFolder 导致报错
 *   （loadCacheDirPath 与 synthesize 可能同时调用此函数）
 */
const projectFolderPromises = new Map<string, Promise<any>>();

export async function getProjectCacheFolder(projectName: string): Promise<any> {
  const folderName = sanitizeProjectName(projectName);

  // 复用正在进行中的请求，避免并发创建同一文件夹
  const pending = projectFolderPromises.get(folderName);
  if (pending) return pending;

  const promise = (async () => {
    const baseFolder = await getBaseCacheFolder();
    try {
      // 尝试获取已存在的项目文件夹
      return await baseFolder.getEntry(folderName);
    } catch (_) {
      // 不存在，创建新文件夹
      return await baseFolder.createFolder(folderName);
    }
  })();

  projectFolderPromises.set(folderName, promise);
  try {
    return await promise;
  } finally {
    projectFolderPromises.delete(folderName);
  }
}

async function readCacheIndex(folder: any): Promise<any> {
  try {
    const entry = await folder.getEntry('cache-index.json');
    const raw = await entry.read({ format: storage.formats.utf8 });
    return JSON.parse(raw);
  } catch (_) {
    return { version: 1, entries: {} };
  }
}

async function writeCacheIndex(folder: any, index: any): Promise<void> {
  const entry = await folder.createEntry('cache-index.json', { overwrite: true });
  await entry.write(JSON.stringify(index, null, 2), { format: storage.formats.utf8 });
}

async function updateCacheIndex(folder: any, cacheKey: string, entry: any): Promise<void> {
  const index = await readCacheIndex(folder);
  const previous = index.entries[cacheKey] || {};
  index.entries[cacheKey] = {
    ...previous,
    ...entry,
    updatedAt: new Date().toISOString()
  };
  await writeCacheIndex(folder, index);
}

async function fetchWithRetry(fetchImpl: any, url: string, options: any, retryCount = 3): Promise<Response> {
  let lastError: any;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      const response = await fetchImpl(url, options);
      if (response.status === 429 && attempt < retryCount) {
        const retryAfter = Number.parseInt(response.headers.get('retry-after') || '', 10);
        const delayMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 700 * (attempt + 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      if (response.ok) {
        return response;
      }

      const body = await response.text().catch(() => '');
      lastError = new Error(`Azure Speech request failed (${response.status}): ${body || response.statusText}`);
      lastError.status = response.status;

      // 401/403 是鉴权问题，重试无意义，直接抛出
      if (response.status === 401 || response.status === 403) {
        throw lastError;
      }
      // 其他非 ok 状态（500/502/503/504 等服务端错误）继续重试
      if (attempt < retryCount) {
        await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
        continue;
      }
      throw lastError;
    } catch (err: any) {
      // 网络层异常（fetch reject：DNS/TCP/TLS 失败、超时等）——重试
      // 但鉴权错误（上面主动 throw 的）不重试
      if (err && err.status && (err.status === 401 || err.status === 403)) {
        throw err;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retryCount) {
        await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
        continue;
      }
      throw lastError;
    }
  }

  throw lastError || new Error('Azure Speech request failed');
}

export class AzureTtsProvider {
  private getSettings: () => Promise<any>;
  private getAzureKey: () => Promise<string>;
  private fetchImpl: any;

  constructor({ getSettings, getAzureKey, fetchImpl = globalThis.fetch }: any) {
    this.getSettings = getSettings;
    this.getAzureKey = getAzureKey;
    this.fetchImpl = fetchImpl;
  }

  public async listVoices(settingsOverride = {}): Promise<any[]> {
    const settings = { ...(await this.getSettings()), ...settingsOverride };
    const key = settings.azureKey || await this.getAzureKey();
    if (!key) throw new Error('Azure Speech key is required');

    const { voicesUrl } = normalizeEndpoint(settings);
    const response = await fetchWithRetry(this.fetchImpl, voicesUrl, {
      method: 'GET',
      headers: {
        'Ocp-Apim-Subscription-Key': key
      }
    }, 1);

    const voices = await response.json();
    return voices.map((voice: any) => ({
      shortName: voice.ShortName,
      displayName: voice.DisplayName,
      localName: voice.LocalName,
      locale: voice.Locale,
      gender: voice.Gender,
      styles: voice.StyleList || [],
      roles: voice.RoleList || [],
      wordsPerMinute: Number.parseInt(voice.WordsPerMinute || '0', 10) || null
    }));
  }

  public async synthesize({ text, voice, voiceLabel, style, rate, pitch, styledegree, role, volume, annotations, polyphonicDict, outputFormat = DEFAULT_OUTPUT_FORMAT, timelineFps = 24, projectName }: any): Promise<any> {
    const settings = await this.getSettings();
    const key = await this.getAzureKey();
    if (!key) throw new Error('Azure Speech key is required');

    const { synthUrl } = normalizeEndpoint(settings);
    const hash = await sha1(JSON.stringify({ text, voice, style, rate, pitch, styledegree, role, volume, annotations, polyphonicDict, outputFormat }));
    const cacheFolder = await getProjectCacheFolder(projectName);
    // 文件名格式：字幕内容_音色名_momo_8位hash.wav
    // hash 仍基于完整参数计算，确保缓存命中逻辑不变；文件名只是更易识别
    const textSnippet = sanitizeForFileName(text, 20) || 'untitled';
    const voiceSnippet = sanitizeForFileName(voiceLabel || voice || 'voice', 30) || 'voice';
    const fileName = `${textSnippet}_${voiceSnippet}_momo_${hash.slice(0, 8)}.wav`;

    // 检查缓存命中
    try {
      const fileEntry = await cacheFolder.getEntry(fileName);
      const existing = await fileEntry.read({ format: storage.formats.binary });
      const duration = wavDurationFrames(existing, timelineFps);
      
      await updateCacheIndex(cacheFolder, hash, {
        text, textHash: await sha1(text),
        voice: voice || 'zh-CN-XiaoxiaoNeural',
        style: style || '', styledegree: styledegree || '',
        role: role || '', rate: rate || '0%', pitch: pitch || '0%', volume: volume || '',
        outputFormat, fileName: fileName,
        sampleRate: duration.sampleRate, durationFrames: duration.durationFrames,
        lastUsedAt: new Date().toISOString()
      });

      return { filePath: fileEntry.nativePath, durationFrames: duration.durationFrames, sampleRate: duration.sampleRate, cacheHit: true };
    } catch (_) {
      // 没命中缓存，向下进行
    }

    const ssml = buildSsml({ text, voice, style, rate, pitch, styledegree, role, volume, annotations, polyphonicDict });
    const response = await fetchWithRetry(this.fetchImpl, synthUrl, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': outputFormat,
        'User-Agent': 'momovoicesub'
      },
      body: ssml
    });

    const audioArrayBuffer = await response.arrayBuffer();
    const newFile = await cacheFolder.createEntry(fileName, { overwrite: true });
    await newFile.write(audioArrayBuffer, { format: storage.formats.binary });

    const duration = wavDurationFrames(audioArrayBuffer, timelineFps);

    // 音频时长校验：如果 Azure 返回了 0 帧的空音频，说明音色可能不支持当前文本语言
    // 此时文件虽已写入，但内容无效，需抛出清晰错误而非让后续导入步骤报迷惑性错误
    if (!duration || duration.durationFrames === 0) {
      throw new Error(`音色合成失败：Azure 返回了空音频（0 帧），音色可能不支持当前文本语言。请检查音色与字幕语言是否匹配。`);
    }

    await updateCacheIndex(cacheFolder, hash, {
      text, textHash: await sha1(text),
      voice: voice || 'zh-CN-XiaoxiaoNeural',
      style: style || '', styledegree: styledegree || '',
      role: role || '', rate: rate || '0%', pitch: pitch || '0%', volume: volume || '',
      outputFormat, fileName: fileName,
      sampleRate: duration.sampleRate, durationFrames: duration.durationFrames,
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString()
    });

    return { filePath: newFile.nativePath, durationFrames: duration.durationFrames, sampleRate: duration.sampleRate, cacheHit: false };
  }

  // ─── 缓存管理公共方法 ───

  /** 获取基础缓存目录的本地路径（用于"打开缓存目录"：展示所有项目子目录） */
  public async getBaseCacheDirNativePath(): Promise<string> {
    const folder = await getBaseCacheFolder();
    return folder.nativePath || '';
  }

  /** 获取当前项目缓存目录的本地路径（用于设置页展示当前项目缓存路径） */
  public async getProjectCacheDirNativePath(projectName: string): Promise<string> {
    const folder = await getProjectCacheFolder(projectName);
    return folder.nativePath || '';
  }

  /** 列出当前项目缓存目录下所有 .wav 文件名 */
  public async listCacheFileNames(projectName: string): Promise<string[]> {
    const folder = await getProjectCacheFolder(projectName);
    const names: string[] = [];
    try {
      const entries = await folder.getEntries();
      for (const entry of entries) {
        if (entry.isFile && entry.name.endsWith('.wav')) {
          names.push(entry.name);
        }
      }
    } catch (_) {}
    return names;
  }

  /** 删除当前项目缓存目录中指定的文件，返回成功删除的数量 */
  public async deleteCacheFiles(projectName: string, fileNames: string[]): Promise<number> {
    if (!fileNames.length) return 0;
    const folder = await getProjectCacheFolder(projectName);
    let deleted = 0;
    for (const name of fileNames) {
      try {
        const entry = await folder.getEntry(name);
        if (entry && entry.isFile) {
          await entry.delete();
          deleted++;
        }
      } catch (_) {}
    }
    // 清理当前项目 cache-index.json 中已删除文件的条目
    await this.pruneCacheIndex(projectName, fileNames);
    return deleted;
  }

  /**
   * 删除当前项目的整个缓存子目录，返回删除的 .wav 文件数量。
   *
   * 仅删除当前项目子目录，不影响其他工程的缓存。
   * 用于"删除当前项目缓存"功能。
   */
  public async deleteProjectCacheFolder(projectName: string): Promise<number> {
    const baseFolder = await getBaseCacheFolder();
    const folderName = sanitizeProjectName(projectName);
    let projectFolder: any = null;
    try {
      projectFolder = await baseFolder.getEntry(folderName);
    } catch (_) { return 0; }
    // 用 getEntries 方法存在性判断是否为文件夹（不依赖 isDirectory 属性）
    if (!isFolderEntry(projectFolder)) return 0;

    // 统计 .wav 文件数量（用于返回值）
    let count = 0;
    try {
      const entries = await projectFolder.getEntries();
      for (const entry of entries) {
        if (entry.isFile && entry.name.endsWith('.wav')) count++;
      }
    } catch (_) {}

    // UXP 的 Folder.delete() 可能不支持递归删除非空文件夹，
    // 先清空目录内所有条目，再删除空文件夹本身
    try {
      const entries = await projectFolder.getEntries();
      for (const entry of entries) {
        try { await entry.delete(); } catch (_) {}
      }
    } catch (_) {}
    try { await projectFolder.delete(); } catch (_) {}
    return count;
  }

  /**
   * 删除所有项目的缓存，返回删除的 .wav 文件数量。
   *
   * 遍历基础缓存目录下所有项目子目录并删除，同时兼容旧版直接放在 cache/ 下的 .wav 文件。
   * 不影响 preview 目录（preview 与 cache 同级，位于 getDataFolder()/preview/）。
   */
  public async deleteAllCacheFiles(): Promise<number> {
    const baseFolder = await getBaseCacheFolder();
    let deleted = 0;
    try {
      const entries = await baseFolder.getEntries();
      for (const entry of entries) {
        if (isFolderEntry(entry)) {
          // 统计该子目录下的 .wav 文件数量
          try {
            const subEntries = await entry.getEntries();
            for (const subEntry of subEntries) {
              if (subEntry.isFile && subEntry.name.endsWith('.wav')) deleted++;
            }
          } catch (_) {}
          // 清空子目录内容后删除空目录
          try {
            const subEntries = await entry.getEntries();
            for (const subEntry of subEntries) {
              try { await subEntry.delete(); } catch (_) {}
            }
          } catch (_) {}
          try { await entry.delete(); } catch (_) {}
        } else if (entry.isFile && entry.name.endsWith('.wav')) {
          // 兼容旧版：直接放在 cache/ 下的 .wav 文件
          try { await entry.delete(); deleted++; } catch (_) {}
        }
      }
    } catch (_) {}
    return deleted;
  }

  /** 从当前项目的 cache-index.json 中移除指定文件名的条目 */
  private async pruneCacheIndex(projectName: string, deletedFileNames: string[]): Promise<void> {
    if (!deletedFileNames.length) return;
    const folder = await getProjectCacheFolder(projectName);
    const index = await readCacheIndex(folder);
    const deletedSet = new Set(deletedFileNames);
    let changed = false;
    for (const key of Object.keys(index.entries || {})) {
      const entry = index.entries[key];
      if (entry && entry.fileName && deletedSet.has(entry.fileName)) {
        delete index.entries[key];
        changed = true;
      }
    }
    if (changed) {
      await writeCacheIndex(folder, index);
    }
  }

  public async readPreviewCacheIndex(previewDirFolder: any) {
    try {
      const entry = await previewDirFolder.getEntry('preview-index.json');
      const raw = await entry.read({ format: storage.formats.utf8 });
      return JSON.parse(raw);
    } catch (_) {
      return { version: 1, entries: {} };
    }
  }

  public async writePreviewCacheIndex(previewDirFolder: any, index: any) {
    const entry = await previewDirFolder.createEntry('preview-index.json', { overwrite: true });
    await entry.write(JSON.stringify(index, null, 2), { format: storage.formats.utf8 });
  }

  public async synthesizePreview({ shortName, localName, displayName, locale }: any): Promise<any> {
    const dataFolder = await fs.getDataFolder();
    let previewFolder;
    try {
      previewFolder = await dataFolder.getEntry('preview');
    } catch (_) {
      previewFolder = await dataFolder.createFolder('preview');
    }

    const isChinese = locale && (String(locale).startsWith('zh-') || String(locale).startsWith('yue-') || String(locale).startsWith('wuu-'));
    const rawName = localName || displayName || '';
    const cleanName = rawName.replace(/\b(Dragon|HD|Flash|Latest|Neural|Multilingual|Online|TTS|V\d+|\d+[KkMm]Hz)\b/g, '').replace(/\s{2,}/g, ' ').trim();

    const previewText = isChinese
      ? `你好，感谢使用默默配音助手，${cleanName}很高兴为你服务。`
      : `Hello, thank you for using MOMO VoiceSub. ${cleanName} is very glad to serve you.`;

    const index = await this.readPreviewCacheIndex(previewFolder);
    const cached = index.entries[shortName];

    if (cached && cached.text === previewText) {
      try {
        const fileEntry = await previewFolder.getEntry(cached.file);
        const wavBuffer = await fileEntry.read({ format: storage.formats.binary });
        index.entries[shortName].lastPreviewedAt = new Date().toISOString();
        await this.writePreviewCacheIndex(previewFolder, index);
        return { wavBuffer, cacheHit: true };
      } catch (_) {}
    }

    const ssml = buildSsml({ text: previewText, voice: shortName });
    const settings = await this.getSettings();
    const key = await this.getAzureKey();
    if (!key) throw new Error('Azure Speech key is required');

    const { synthUrl } = normalizeEndpoint(settings);
    const response = await fetchWithRetry(this.fetchImpl, synthUrl, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': DEFAULT_OUTPUT_FORMAT,
        'User-Agent': 'momovoicesub'
      },
      body: ssml
    });

    const wavBuffer = await response.arrayBuffer();
    // shortName 可能含冒号等 Windows/UXP 非法字符（如部分多语言音色），需转义后才能用作文件名
    const safeName = String(shortName).replace(/[^A-Za-z0-9_\-]/g, '_');
    const fileName = `preview_${safeName}.wav`;
    const newFile = await previewFolder.createEntry(fileName, { overwrite: true });
    await newFile.write(wavBuffer, { format: storage.formats.binary });

    index.entries[shortName] = {
      file: fileName, shortName,
      localName: localName || displayName || shortName,
      text: previewText,
      createdAt: new Date().toISOString(),
      lastPreviewedAt: new Date().toISOString()
    };
    await this.writePreviewCacheIndex(previewFolder, index);

    return { wavBuffer, cacheHit: false };
  }
}
