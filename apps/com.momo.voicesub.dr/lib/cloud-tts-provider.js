'use strict';

const { buildPreviewText } = require('./preview-text');

/**
 * 云端 TTS Provider
 * 与 AzureTtsProvider 接口相同，但通过云端 API 合成（无需本地 Azure Key）
 * 复用本地缓存逻辑，避免重复扣费
 */

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
const { sha1, applyPolyphonicDict, applyManualAnnotations, escapeXml, buildSsml } = require('./azure-tts');
const { wavDurationFrames } = require('./wav');
const { DEFAULT_OUTPUT_FORMAT } = require('./azure-tts');

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

class CloudTtsProvider {
  constructor({ cloudClient, cloudStore, cacheDir }) {
    this.cloudClient = cloudClient;
    this.cloudStore = cloudStore;
    this.cacheDir = cacheDir;
    this._refreshingPromise = null;
  }

  /**
   * 用 refresh_token 刷新 access_token（并发安全）。
   * 多条字幕同时遇到 401 时，只发一次 refresh 请求。
   */
  async _refreshAccessToken(tokenData) {
    if (!tokenData?.refresh_token) {
      throw Object.assign(new Error('NO_REFRESH_TOKEN'), { code: 'NO_REFRESH_TOKEN' });
    }
    if (this._refreshingPromise) return this._refreshingPromise;
    this._refreshingPromise = (async () => {
      const refreshed = await this.cloudClient.refreshToken(tokenData.refresh_token);
      await this.cloudStore.saveToken({
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        email: tokenData.email || '',
        is_admin: refreshed.is_admin || tokenData.is_admin || false,
        nickname: tokenData.nickname || '',
      });
      return refreshed.access_token;
    })().finally(() => { this._refreshingPromise = null; });
    return this._refreshingPromise;
  }

  /**
   * 带自动刷新的合成调用：401 时用 refresh_token 刷新后重试一次。
   */
  async _synthesizeWithRetry(tokenData, payload) {
    try {
      return await this.cloudClient.synthesize(tokenData.access_token, payload);
    } catch (err) {
      if (err.code === 'TOKEN_EXPIRED' && tokenData.refresh_token) {
        const newToken = await this._refreshAccessToken(tokenData);
        return await this.cloudClient.synthesize(newToken, payload);
      }
      throw err;
    }
  }

  /**
   * 获取云端音色列表
   * 返回格式与 AzureTtsProvider.listVoices 一致
   */
  async listVoices() {
    const tokenData = await this.cloudStore.loadToken();
    if (!tokenData?.access_token) {
      throw new Error('未登录云端账号');
    }
    try {
      return await this.cloudClient.listVoices(tokenData.access_token);
    } catch (err) {
      if (err.code === 'TOKEN_EXPIRED' && tokenData.refresh_token) {
        const newToken = await this._refreshAccessToken(tokenData);
        return await this.cloudClient.listVoices(newToken);
      }
      throw err;
    }
  }

  /**
   * 获取音色列表（公开接口，不需要登录）
   * 用于"无自填 Key + 未登录"状态下让用户仍能浏览音色列表。
   */
  async listVoicesPublic() {
    return this.cloudClient.listVoicesPublic();
  }

  /**
   * 合成语音（通过云端 API）
   * 复用本地缓存，相同参数不重复扣费
   */
  async synthesize({ text, voice, style, rate, pitch, styledegree, role, volume, annotations, polyphonicDict, outputFormat = DEFAULT_OUTPUT_FORMAT, cacheKey, timelineFps = 24, cacheDir }) {
    const tokenData = await this.cloudStore.loadToken();
    if (!tokenData?.access_token) {
      const err = new Error('未登录云端账号');
      err.code = 'NOT_LOGGED_IN';
      throw err;
    }

    const hash = cacheKey || sha1(JSON.stringify({ text, voice, style, rate, pitch, styledegree, role, volume, annotations, polyphonicDict, outputFormat }));
    const targetDir = cacheDir || this.cacheDir;
    if (!targetDir) throw new Error('Cache directory is required');

    await fs.mkdir(targetDir, { recursive: true });
    const filePath = path.join(targetDir, `momo_${hash}.wav`);

    // 检查缓存
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
      const result = { filePath, durationFrames: duration.durationFrames, sampleRate: duration.sampleRate, cacheHit: true };
      return result;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    // 缓存未命中，调用云端 API
    // 先在客户端应用多音字字典和标注（与 Azure 模式一致）
    let processedText = text;
    const hasUserTags = /<phoneme\b/i.test(text);

    if (annotations && annotations.length) {
      processedText = applyManualAnnotations(text, annotations);
    }
    if (polyphonicDict && polyphonicDict.length) {
      processedText = applyPolyphonicDict(processedText, polyphonicDict);
    }
    if (!annotations?.length && !polyphonicDict?.length && !hasUserTags) {
      processedText = escapeXml(text);
    }

    const deviceFp = await this.cloudStore.getDeviceFp();

    const audioBuffer = await this._synthesizeWithRetry(tokenData, {
      text: processedText,
      voice: voice || 'zh-CN-XiaoxiaoNeural',
      style: style || undefined,
      rate: rate || '0%',
      pitch: pitch || '0%',
      styledegree: styledegree || undefined,
      role: role || undefined,
      volume: volume || '100%',
      outputFormat,
      device_fp: deviceFp,
      client_type: 'dr',
    });

    await fs.writeFile(filePath, audioBuffer);
    const duration = wavDurationFrames(audioBuffer, timelineFps);

    if (!duration || duration.durationFrames === 0) {
      throw new Error('音色合成失败：云端返回了空音频，音色可能不支持当前文本语言。');
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

  /**
   * 合成预览音频（通过云端 API）
   */
  async synthesizePreview({ shortName, localName, displayName, locale, previewDir }) {
    const targetDir = previewDir || this.cacheDir;
    if (!targetDir) throw new Error('Cache directory is required');

    const previewCacheDir = path.join(targetDir, 'preview');
    await fs.mkdir(previewCacheDir, { recursive: true });

    const previewText = buildPreviewText({ locale, localName, displayName });

    // 检查预览缓存
    const index = await readCacheIndex(path.join(previewCacheDir, 'preview-index.json'));
    const cached = index.entries[shortName];
    if (cached && cached.text === previewText) {
      const cachedPath = path.join(previewCacheDir, cached.file);
      try {
        const wavBuffer = await fs.readFile(cachedPath);
        index.entries[shortName].lastPreviewedAt = new Date().toISOString();
        await writeCacheIndex(path.join(previewCacheDir, 'preview-index.json'), index);
        return { wavBuffer, cacheHit: true };
      } catch {}
    }

    // 优先尝试从云端预生成音频下载（公开接口，不需要登录，不消耗配额）
    // 云端已预先合成好所有音色的试听音频，存放在 Supabase Storage
    // 这样试听不会消耗用户的 Azure 配额
    try {
      const { wavBuffer: previewBuffer } = await this.cloudClient.fetchPreview(shortName);
      if (previewBuffer && previewBuffer.length > 0) {
        const safeShortName = String(shortName || '').replace(/[:<>"/\\|?*]/g, '_');
        const fileName = `preview_${safeShortName}.wav`;
        await fs.writeFile(path.join(previewCacheDir, fileName), previewBuffer);

        index.entries[shortName] = {
          file: fileName, shortName,
          localName: localName || displayName || shortName,
          text: previewText,
          createdAt: new Date().toISOString(),
          lastPreviewedAt: new Date().toISOString(),
          source: 'previews'
        };
        await writeCacheIndex(path.join(previewCacheDir, 'preview-index.json'), index);

        return { wavBuffer: previewBuffer, cacheHit: false };
      }
    } catch {
      // 预览接口不可用，回退到实时合成
    }

    // 回退：调用云端 API 实时合成（会消耗配额）
    // 仅当云端尚未预生成此音色、或预览接口不可用时才走到这里
    const tokenData = await this.cloudStore.loadToken();
    if (!tokenData?.access_token) {
      throw new Error('未登录云端账号');
    }

    const deviceFp = await this.cloudStore.getDeviceFp();
    const wavBuffer = await this._synthesizeWithRetry(tokenData, {
      text: previewText,
      voice: shortName,
      device_fp: deviceFp,
      client_type: 'dr',
    });

    const safeShortName = String(shortName || '').replace(/[:<>"/\\|?*]/g, '_');
    const fileName = `preview_${safeShortName}.wav`;
    await fs.writeFile(path.join(previewCacheDir, fileName), wavBuffer);

    index.entries[shortName] = {
      file: fileName, shortName,
      localName: localName || displayName || shortName,
      text: previewText,
      createdAt: new Date().toISOString(),
      lastPreviewedAt: new Date().toISOString(),
      source: 'synthesize'
    };
    await writeCacheIndex(path.join(previewCacheDir, 'preview-index.json'), index);

    return { wavBuffer, cacheHit: false };
  }
}

module.exports = { CloudTtsProvider };
