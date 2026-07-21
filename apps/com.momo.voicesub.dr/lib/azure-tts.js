'use strict';

const crypto = require('crypto');
const fs = (() => {
  try { return require('fs/promises'); } catch (_) {
    const _fs = require('fs');
    const { promisify } = require('util');
    return {
      readFile: promisify(_fs.readFile),
      writeFile: promisify(_fs.writeFile),
      mkdir: promisify(_fs.mkdir),
      stat: promisify(_fs.stat),
    };
  }
})();
const path = require('path');
const { wavDurationFrames } = require('./wav');

const DEFAULT_OUTPUT_FORMAT = 'riff-24khz-16bit-mono-pcm';

const STYLE_CN_MAP = {
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

const EMOTION_INTENSITY = {
  'general': 'normal',
  'chat': 'normal',
  'friendly': 'normal',
  'gentle': 'normal',
  'assistant': 'normal',
  'calm': 'emotional',
  'hopeful': 'emotional',
  'sad': 'emotional',
  'sorrowful': 'emotional',
  'serious': 'emotional',
  'lyrical': 'emotional',
  'narration-professional': 'emotional',
  'narration-relaxed': 'emotional',
  'narration-sports': 'emotional',
  'embarrassed': 'emotional',
  'whispering': 'emotional',
  'depressed': 'emotional',
  'affectionate': 'emotional',
  'disgruntled': 'emotional',
  'cheerful': 'strong',
  'exciting': 'strong',
  'excited': 'strong',
  'angry': 'strong',
  'fearful': 'strong',
  'terrified': 'strong',
  'shouting': 'strong',
  'unfriendly': 'strong',
  'envy': 'strong',
  'narration-sports-excited': 'strong',
  'live-commercial': 'strong',
  'poetry-reading': 'strong',
  'advertisement_upbeat': 'strong',
  'sports_commentary_excited': 'strong'
};

// 内置多音字词典从外部 JSON 文件加载，方便维护
const POLYPHONIC_BUILTIN = require('./polyphonic-builtin.json');

function sha1(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function styleNameCn(style) {
  return STYLE_CN_MAP[style] || style;
}

function emotionIntensity(style) {
  return EMOTION_INTENSITY[style] || 'normal';
}

function normalizeEndpoint(settings = {}) {
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

function applyPolyphonicDict(text, userDict) {
  if (!text) return text;

  const allDict = [...(userDict || []), ...POLYPHONIC_BUILTIN];

  const charToEntries = {};
  for (const entry of allDict) {
    if (!entry.char) continue;
    if (!charToEntries[entry.char]) charToEntries[entry.char] = [];
    const exists = charToEntries[entry.char].some(e => e.pinyin === entry.pinyin && e.phonetic === entry.phonetic);
    if (!exists) charToEntries[entry.char].push(entry);
  }

  // 将文本分割为 XML 标签和纯文本段，只对纯文本段做替换，避免嵌套 <phoneme>
  const parts = text.split(/(<[^>]+>)/g);

  let insidePhoneme = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith('<')) {
      // 这是一个 XML 标签
      if (/^<phoneme\b/i.test(part)) insidePhoneme++;
      else if (/^<\/phoneme>/i.test(part)) insidePhoneme = Math.max(0, insidePhoneme - 1);
      continue;
    }
    // 如果当前在 <phoneme> 标签内部，跳过不替换
    if (insidePhoneme > 0) continue;

    // 对纯文本段做字典替换
    let segment = part;
    for (const [char, entries] of Object.entries(charToEntries)) {
      if (entries.length === 1) {
        const entry = entries[0];
        let ph = (entry.phonetic || '').trim();
        // 确保 ph 声调数字前带有空格以契合微软 SAPI 格式标准，防范 Unknown phoneme
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

function applyManualAnnotations(text, annotations) {
  if (!text || !annotations || !annotations.length) return text;

  let result = text;
  // 从后往前处理，避免插入/替换导致前面位置偏移
  const sorted = [...annotations].sort((a, b) => (b.start || 0) - (a.start || 0));

  for (const ann of sorted) {
    const start = ann.start;
    const end = ann.end || start + 1;

    if (ann.type === 'phoneme' && ann.phonetic) {
      // 多音字：用 SSML <phoneme> 标签替换对应文字
      let ph = ann.phonetic.trim();
      // 确保 ph 声调数字前带有空格以契合微软 SAPI 格式标准，防范 Unknown phoneme
      if (ph && !ph.includes(' ')) {
        ph = ph.replace(/^([a-zA-Züü]+)([1-5])$/i, '$1 $2');
      }
      const originalChar = result.slice(start, end);
      const phonemeTag = `<phoneme alphabet="sapi" ph="${escapeXml(ph)}">${escapeXml(originalChar)}</phoneme>`;
      result = result.slice(0, start) + phonemeTag + result.slice(end);
    } else if (ann.type === 'break') {
      // 停顿：在指定位置插入 <break> 标签
      const breakMs = typeof ann.duration === 'number' ? `${ann.duration}ms` : (ann.duration || '500ms');
      const breakTag = breakMs === 'none'
        ? '<break strength="none"/>'
        : `<break time="${escapeXml(breakMs)}"/>`;
      result = result.slice(0, start) + breakTag + result.slice(start);
    }
  }

  return result;
}

function buildSsml({ text, voice, style, rate, pitch, styledegree, role, volume, annotations, polyphonicDict }) {
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

async function fetchWithRetry(fetchImpl, url, options, retryCount = 3) {
  let lastError;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
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

    if (response.status === 401 || response.status === 403 || attempt === retryCount) {
      throw lastError;
    }
  }

  throw lastError || new Error('Azure Speech request failed');
}

class AzureTtsProvider {
  constructor({ getSettings, getAzureKey, fetchImpl = globalThis.fetch, cacheDir }) {
    this.getSettings = getSettings;
    this.getAzureKey = getAzureKey;
    this.fetchImpl = fetchImpl;
    this.cacheDir = cacheDir;
  }

  async listVoices(settingsOverride = {}) {
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
    return voices.map((voice) => ({
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

  async synthesize({ text, voice, style, rate, pitch, styledegree, role, volume, annotations, polyphonicDict, outputFormat = DEFAULT_OUTPUT_FORMAT, cacheKey, timelineFps = 24, cacheDir }) {
    const settings = await this.getSettings();
    const key = await this.getAzureKey();
    if (!key) throw new Error('Azure Speech key is required');

    const { synthUrl } = normalizeEndpoint(settings);
    const hash = cacheKey || sha1(JSON.stringify({ text, voice, style, rate, pitch, styledegree, role, volume, annotations, polyphonicDict, outputFormat }));
    const targetDir = cacheDir || this.cacheDir || settings.cacheDir;
    if (!targetDir) throw new Error('Cache directory is required');

    await fs.mkdir(targetDir, { recursive: true });
    const filePath = path.join(targetDir, `momo_${hash}.wav`);

    try {
      const existing = await fs.readFile(filePath);
      const duration = wavDurationFrames(existing, timelineFps);
      await updateCacheIndex(targetDir, hash, {
        text, textHash: sha1(text),
        voice: voice || 'zh-CN-XiaoxiaoNeural',
        style: style || '', styledegree: styledegree || '',
        role: role || '', rate: rate || '0%', pitch: pitch || '0%', volume: volume || '',
        outputFormat, fileName: path.basename(filePath),
        sampleRate: duration.sampleRate, durationFrames: duration.durationFrames,
        lastUsedAt: new Date().toISOString()
      });
      return { filePath, durationFrames: duration.durationFrames, sampleRate: duration.sampleRate, cacheHit: true };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
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

    const audio = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(filePath, audio);
    const duration = wavDurationFrames(audio, timelineFps);

    // 音频时长校验：如果 Azure 返回了 0 帧的空音频，说明音色可能不支持当前文本语言
    if (!duration || duration.durationFrames === 0) {
      throw new Error(`音色合成失败：Azure 返回了空音频（0 帧），音色可能不支持当前文本语言。请检查音色与字幕语言是否匹配。`);
    }

    await updateCacheIndex(targetDir, hash, {
      text, textHash: sha1(text),
      voice: voice || 'zh-CN-XiaoxiaoNeural',
      style: style || '', styledegree: styledegree || '',
      role: role || '', rate: rate || '0%', pitch: pitch || '0%', volume: volume || '',
      outputFormat, fileName: path.basename(filePath),
      sampleRate: duration.sampleRate, durationFrames: duration.durationFrames,
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString()
    });
    return { filePath, durationFrames: duration.durationFrames, sampleRate: duration.sampleRate, cacheHit: false };
  }

  async readPreviewCacheIndex(previewDir) {
    try {
      return JSON.parse(await fs.readFile(path.join(previewDir, 'preview-index.json'), 'utf8'));
    } catch {
      return { version: 1, entries: {} };
    }
  }

  async writePreviewCacheIndex(previewDir, index) {
    await fs.mkdir(previewDir, { recursive: true });
    await fs.writeFile(path.join(previewDir, 'preview-index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  }

  async synthesizePreview({ shortName, localName, displayName, locale, previewDir }) {
    const targetDir = previewDir || this.cacheDir || (await this.getSettings()).cacheDir;
    if (!targetDir) throw new Error('Cache directory is required');

    const previewCacheDir = path.join(targetDir, 'preview');
    await fs.mkdir(previewCacheDir, { recursive: true });

    const isChinese = locale && (String(locale).startsWith('zh-') || String(locale).startsWith('yue-') || String(locale).startsWith('wuu-'));

    // 移除技术后缀（Dragon、HD、Flash、Latest 等），避免 TTS 读出奇怪词语
    const rawName = localName || displayName || '';
    const cleanName = rawName.replace(/\b(Dragon|HD|Flash|Latest|Neural|Multilingual|Online|TTS|V\d+|\d+[KkMm]Hz)\b/g, '').replace(/\s{2,}/g, ' ').trim();

    const previewText = isChinese
      ? `你好，感谢使用默默配音助手，${cleanName}很高兴为你服务。`
      : `Hello, thank you for using MOMO VoiceSub. ${cleanName} is very glad to serve you.`;

    const index = await this.readPreviewCacheIndex(previewCacheDir);
    const cached = index.entries[shortName];

    if (cached && cached.text === previewText) {
      const cachedPath = path.join(previewCacheDir, cached.file);
      try {
        const wavBuffer = await fs.readFile(cachedPath);
        index.entries[shortName].lastPreviewedAt = new Date().toISOString();
        await this.writePreviewCacheIndex(previewCacheDir, index);
        return { wavBuffer, cacheHit: true };
      } catch {
      }
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

    const wavBuffer = Buffer.from(await response.arrayBuffer());
    const fileName = `preview_${shortName}.wav`;
    await fs.writeFile(path.join(previewCacheDir, fileName), wavBuffer);

    index.entries[shortName] = {
      file: fileName, shortName,
      localName: localName || displayName || shortName,
      text: previewText,
      createdAt: new Date().toISOString(),
      lastPreviewedAt: new Date().toISOString()
    };
    await this.writePreviewCacheIndex(previewCacheDir, index);

    return { wavBuffer, cacheHit: false };
  }
}

module.exports = {
  AzureTtsProvider,
  DEFAULT_OUTPUT_FORMAT,
  buildSsml,
  escapeXml,
  normalizeEndpoint,
  readCacheIndex,
  sha1,
  styleNameCn,
  emotionIntensity,
  STYLE_CN_MAP,
  POLYPHONIC_BUILTIN,
  applyPolyphonicDict,
  applyManualAnnotations
};
