// @ts-ignore
import uxp from "uxp";
import { sha1Hex } from "./sha1";
import { wavDurationFrames } from "./wav";
import { buildPreviewText } from "./preview-text";
import {
  applyPolyphonicDict,
  applyManualAnnotations,
  escapeXml,
  getProjectCacheFolder,
  getBaseCacheFolder,
  sanitizeForFileName,
  updateCacheIndex,
  DEFAULT_OUTPUT_FORMAT
} from "./azure-tts";
import { CloudClient } from "./cloud-client";
import { CloudStore } from "./cloud-store";

const storage = uxp.storage;
const fs = storage.localFileSystem;

/**
 * 云端 TTS Provider（PR / UXP 版）
 *
 * 与 AzureTtsProvider 接口相同，但通过云端 API 合成（无需本地 Azure Key）。
 * 复用 AzureTtsProvider 的项目级缓存体系（相同 hash + 文件名 + 目录），
 * 确保缓存命中跨 Provider 通用，相同参数不重复扣费。
 *
 * 与 DR 版 CloudTtsProvider 的差异：
 * - 使用 UXP localFileSystem（非 Node fs）
 * - 返回 UXP 文件 entry 的 nativePath（非 Node path）
 * - 缓存文件命名与 PR AzureTtsProvider 完全一致（含文本/音色片段前缀）
 */

function sha1(value: string): Promise<string> {
  return Promise.resolve(sha1Hex(value));
}

export class CloudTtsProvider {
  private cloudClient: CloudClient;
  private cloudStore: CloudStore;
  private _refreshingPromise: Promise<string> | null = null;

  constructor({ cloudClient, cloudStore }: { cloudClient: CloudClient; cloudStore: CloudStore }) {
    this.cloudClient = cloudClient;
    this.cloudStore = cloudStore;
  }

  /**
   * 用 refresh_token 刷新 access_token（并发安全）。
   * 多条字幕同时遇到 401 时，只发一次 refresh 请求。
   */
  private async _refreshAccessToken(tokenData: any): Promise<string> {
    if (!tokenData?.refresh_token) {
      const err: any = new Error('NO_REFRESH_TOKEN');
      err.code = 'NO_REFRESH_TOKEN';
      throw err;
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
  private async _synthesizeWithRetry(tokenData: any, payload: any): Promise<ArrayBuffer> {
    try {
      return await this.cloudClient.synthesize(tokenData.access_token, payload);
    } catch (err: any) {
      if (err.code === 'TOKEN_EXPIRED' && tokenData.refresh_token) {
        const newToken = await this._refreshAccessToken(tokenData);
        return await this.cloudClient.synthesize(newToken, payload);
      }
      throw err;
    }
  }

  /**
   * 获取云端音色列表
   */
  async listVoices(_settingsOverride = {}): Promise<any[]> {
    const tokenData = await this.cloudStore.loadToken();
    if (!tokenData?.access_token) {
      throw new Error('未登录云端账号');
    }
    try {
      return await this.cloudClient.listVoices(tokenData.access_token);
    } catch (err: any) {
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
  async listVoicesPublic(): Promise<any[]> {
    return this.cloudClient.listVoicesPublic();
  }

  /**
   * 合成语音（通过云端 API）
   * 复用 AzureTtsProvider 的项目级缓存，相同参数不重复扣费
   */
  async synthesize({ text, voice, voiceLabel, style, rate, pitch, styledegree, role, volume, annotations, polyphonicDict, outputFormat = DEFAULT_OUTPUT_FORMAT, timelineFps = 24, projectName }: any): Promise<any> {
    const tokenData = await this.cloudStore.loadToken();
    if (!tokenData?.access_token) {
      const err: any = new Error('未登录云端账号');
      err.code = 'NOT_LOGGED_IN';
      throw err;
    }

    const hash = await sha1(JSON.stringify({ text, voice, style, rate, pitch, styledegree, role, volume, annotations, polyphonicDict, outputFormat }));
    const cacheFolder = await getProjectCacheFolder(projectName);
    const textSnippet = sanitizeForFileName(text, 20) || 'untitled';
    const voiceSnippet = sanitizeForFileName(voiceLabel || voice || 'voice', 30) || 'voice';
    const fileName = `${textSnippet}_${voiceSnippet}_momo_${hash.slice(0, 8)}.wav`;

    // 检查缓存命中（与 AzureTtsProvider 完全一致的逻辑）
    try {
      const fileEntry = await cacheFolder.getEntry(fileName);
      const existing = await fileEntry.read({ format: storage.formats.binary });
      const duration = wavDurationFrames(existing, timelineFps);

      await updateCacheIndex(cacheFolder, hash, {
        text, textHash: await sha1(text),
        voice: voice || 'zh-CN-XiaoxiaoNeural',
        style: style || '', styledegree: styledegree || '',
        role: role || '', rate: rate || '0%', pitch: pitch || '0%', volume: volume || '',
        outputFormat, fileName,
        sampleRate: duration.sampleRate, durationFrames: duration.durationFrames,
        lastUsedAt: new Date().toISOString()
      });

      return { filePath: fileEntry.nativePath, durationFrames: duration.durationFrames, sampleRate: duration.sampleRate, cacheHit: true };
    } catch (_) {
      // 没命中缓存，向下进行
    }

    // 缓存未命中，调用云端 API
    // 先在客户端应用多音字字典和标注（与 Azure 模式一致），云端只负责 SSML 包裹 + Azure 调用
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
      client_type: 'pr',
    });

    const newFile = await cacheFolder.createEntry(fileName, { overwrite: true });
    await newFile.write(audioBuffer, { format: storage.formats.binary });

    const duration = wavDurationFrames(audioBuffer, timelineFps);

    if (!duration || duration.durationFrames === 0) {
      throw new Error('音色合成失败：云端返回了空音频，音色可能不支持当前文本语言。');
    }

    await updateCacheIndex(cacheFolder, hash, {
      text, textHash: await sha1(text),
      voice: voice || 'zh-CN-XiaoxiaoNeural',
      style: style || '', styledegree: styledegree || '',
      role: role || '', rate: rate || '0%', pitch: pitch || '0%', volume: volume || '',
      outputFormat, fileName,
      sampleRate: duration.sampleRate, durationFrames: duration.durationFrames,
      createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString()
    });

    return { filePath: newFile.nativePath, durationFrames: duration.durationFrames, sampleRate: duration.sampleRate, cacheHit: false };
  }

  // ─── 缓存管理公共方法（与 AzureTtsProvider 接口一致，委托给共享的缓存工具） ───

  async getBaseCacheDirNativePath(): Promise<string> {
    const folder = await getBaseCacheFolder();
    return folder.nativePath || '';
  }

  async getProjectCacheDirNativePath(projectName: string): Promise<string> {
    const folder = await getProjectCacheFolder(projectName);
    return folder.nativePath || '';
  }

  // 以下缓存管理方法由 DelegatingTtsProvider 委托给 AzureTtsProvider 执行
  // （缓存是文件系统级的，与 Provider 无关），此处仅为接口完整性占位
  async listCacheFileNames(_projectName: string): Promise<string[]> { return []; }
  async deleteCacheFiles(_projectName: string, _fileNames: string[]): Promise<number> { return 0; }
  async deleteProjectCacheFolder(_projectName: string): Promise<number> { return 0; }
  async deleteAllCacheFiles(): Promise<number> { return 0; }

  // ─── 试听预览 ───

  private async readPreviewCacheIndex(previewDirFolder: any): Promise<any> {
    try {
      const entry = await previewDirFolder.getEntry('preview-index.json');
      const raw = await entry.read({ format: storage.formats.utf8 });
      return JSON.parse(raw);
    } catch (_) {
      return { version: 1, entries: {} };
    }
  }

  private async writePreviewCacheIndex(previewDirFolder: any, index: any): Promise<void> {
    const entry = await previewDirFolder.createEntry('preview-index.json', { overwrite: true });
    await entry.write(JSON.stringify(index, null, 2), { format: storage.formats.utf8 });
  }

  /**
   * 合成预览音频（通过云端 API）
   * 优先尝试云端预生成音频（公开接口，不消耗配额），失败则实时合成
   */
  async synthesizePreview({ shortName, localName, displayName, locale }: any): Promise<any> {
    const dataFolder = await fs.getDataFolder();
    let previewFolder;
    try {
      previewFolder = await dataFolder.getEntry('preview');
    } catch (_) {
      previewFolder = await dataFolder.createFolder('preview');
    }

    const previewText = buildPreviewText({ locale, localName, displayName });

    // 检查预览缓存
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

    // 优先尝试从云端预生成音频下载（公开接口，不需要登录，不消耗配额）
    try {
      const { wavBuffer: previewBuffer } = await this.cloudClient.fetchPreview(shortName);
      if (previewBuffer && previewBuffer.byteLength > 0) {
        const safeShortName = String(shortName || '').replace(/[:<>"/\\|?*]/g, '_');
        const fileName = `preview_${safeShortName}.wav`;
        const newFile = await previewFolder.createEntry(fileName, { overwrite: true });
        await newFile.write(previewBuffer, { format: storage.formats.binary });

        index.entries[shortName] = {
          file: fileName, shortName,
          localName: localName || displayName || shortName,
          text: previewText,
          createdAt: new Date().toISOString(),
          lastPreviewedAt: new Date().toISOString(),
          source: 'previews'
        };
        await this.writePreviewCacheIndex(previewFolder, index);

        return { wavBuffer: previewBuffer, cacheHit: false };
      }
    } catch {
      // 预览接口不可用，回退到实时合成
    }

    // 回退：调用云端 API 实时合成（会消耗配额）
    const tokenData = await this.cloudStore.loadToken();
    if (!tokenData?.access_token) {
      throw new Error('未登录云端账号');
    }

    const deviceFp = await this.cloudStore.getDeviceFp();
    const wavBuffer = await this._synthesizeWithRetry(tokenData, {
      text: previewText,
      voice: shortName,
      device_fp: deviceFp,
      client_type: 'pr',
    });

    const safeShortName = String(shortName || '').replace(/[:<>"/\\|?*]/g, '_');
    const fileName = `preview_${safeShortName}.wav`;
    const newFile = await previewFolder.createEntry(fileName, { overwrite: true });
    await newFile.write(wavBuffer, { format: storage.formats.binary });

    index.entries[shortName] = {
      file: fileName, shortName,
      localName: localName || displayName || shortName,
      text: previewText,
      createdAt: new Date().toISOString(),
      lastPreviewedAt: new Date().toISOString(),
      source: 'synthesize'
    };
    await this.writePreviewCacheIndex(previewFolder, index);

    return { wavBuffer, cacheHit: false };
  }
}
