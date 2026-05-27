'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { wavDurationFrames } = require('./wav');

const DEFAULT_OUTPUT_FORMAT = 'riff-24khz-16bit-mono-pcm';

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

function buildSsml({ text, voice, style, rate, pitch }) {
  if (!text || !String(text).trim()) {
    throw new Error('Text is required');
  }

  const voiceName = voice || 'zh-CN-XiaoxiaoNeural';
  const prosodyAttrs = [];
  if (rate && rate !== '0%') prosodyAttrs.push(`rate="${escapeXml(rate)}"`);
  if (pitch && pitch !== '0%') prosodyAttrs.push(`pitch="${escapeXml(pitch)}"`);

  let content = escapeXml(text);
  if (prosodyAttrs.length > 0) {
    content = `<prosody ${prosodyAttrs.join(' ')}>${content}</prosody>`;
  }
  if (style) {
    content = `<mstts:express-as style="${escapeXml(style)}">${content}</mstts:express-as>`;
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
      wordsPerMinute: Number.parseInt(voice.WordsPerMinute || '0', 10) || null
    }));
  }

  async synthesize({ text, voice, style, rate, pitch, outputFormat = DEFAULT_OUTPUT_FORMAT, cacheKey, timelineFps = 24, cacheDir }) {
    const settings = await this.getSettings();
    const key = await this.getAzureKey();
    if (!key) throw new Error('Azure Speech key is required');

    const { synthUrl } = normalizeEndpoint(settings);
    const hash = cacheKey || sha1(JSON.stringify({ text, voice, style, rate, pitch, outputFormat }));
    const targetDir = cacheDir || this.cacheDir || settings.cacheDir;
    if (!targetDir) throw new Error('Cache directory is required');

    await fs.mkdir(targetDir, { recursive: true });
    const filePath = path.join(targetDir, `momo_${hash}.wav`);

    try {
      const existing = await fs.readFile(filePath);
      const duration = wavDurationFrames(existing, timelineFps);
      await updateCacheIndex(targetDir, hash, {
        text,
        textHash: sha1(text),
        voice: voice || 'zh-CN-XiaoxiaoNeural',
        style: style || '',
        rate: rate || '0%',
        pitch: pitch || '0%',
        outputFormat,
        fileName: path.basename(filePath),
        sampleRate: duration.sampleRate,
        durationFrames: duration.durationFrames,
        lastUsedAt: new Date().toISOString()
      });
      return { filePath, durationFrames: duration.durationFrames, sampleRate: duration.sampleRate, cacheHit: true };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const ssml = buildSsml({ text, voice, style, rate, pitch });
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
    await updateCacheIndex(targetDir, hash, {
      text,
      textHash: sha1(text),
      voice: voice || 'zh-CN-XiaoxiaoNeural',
      style: style || '',
      rate: rate || '0%',
      pitch: pitch || '0%',
      outputFormat,
      fileName: path.basename(filePath),
      sampleRate: duration.sampleRate,
      durationFrames: duration.durationFrames,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString()
    });
    return { filePath, durationFrames: duration.durationFrames, sampleRate: duration.sampleRate, cacheHit: false };
  }
}

module.exports = {
  AzureTtsProvider,
  DEFAULT_OUTPUT_FORMAT,
  buildSsml,
  escapeXml,
  normalizeEndpoint,
  readCacheIndex,
  sha1
};
