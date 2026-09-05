import { AzureTtsProvider } from "./azure-tts";
import { CloudTtsProvider } from "./cloud-tts-provider";
import { CloudStore } from "./cloud-store";
import { LocalTtsProvider } from "./local-tts-provider";

/**
 * TTS Provider 委托器（PR / UXP 版）
 *
 * 根据 activeChannel 显式设置或认证状态自动切换 AzureTtsProvider / CloudTtsProvider / LocalTtsProvider：
 *   1. activeChannel === 'local' → LocalTtsProvider
 *   2. activeChannel === 'cloud' → CloudTtsProvider
 *   3. activeChannel === 'azure' → AzureTtsProvider
 *   4. 未显式选择时（'' 或 undefined）隐式推断：
 *      a. 自填 Key 勾选"临时禁用" → CloudTtsProvider
 *      b. 有自填 Azure Key → AzureTtsProvider（本地 key 路线，优先级最高）
 *      c. 无自填 key + 有云端 token → CloudTtsProvider（云端路线）
 *      d. 本地通道可用（managed 有整合包目录 / url 有 baseUrl）且有本地音色 → LocalTtsProvider
 *      e. 都没有 → AzureTtsProvider（会因无 key 报错，引导用户去设置）
 *
 * 缓存管理方法（getBaseCacheDirNativePath 等）始终委托给 azureProvider，
 * 因为缓存是文件系统级的，与合成通道无关，三个 Provider 共享同一缓存目录。
 */
export class DelegatingTtsProvider {
  private azureProvider: AzureTtsProvider;
  private cloudProvider: CloudTtsProvider;
  private localProvider: LocalTtsProvider | null;
  private cloudStore: CloudStore;
  private getAzureKey: () => Promise<string>;
  private getActiveChannel: () => Promise<string>;
  private getSettings: () => Promise<any>;

  constructor({
    azureProvider,
    cloudProvider,
    localProvider,
    cloudStore,
    getAzureKey,
    getActiveChannel,
    getSettings
  }: {
    azureProvider: AzureTtsProvider;
    cloudProvider: CloudTtsProvider;
    localProvider?: LocalTtsProvider | null;
    cloudStore: CloudStore;
    getAzureKey?: () => Promise<string>;
    getActiveChannel?: () => Promise<string>;
    getSettings?: () => Promise<any>;
  }) {
    this.azureProvider = azureProvider;
    this.cloudProvider = cloudProvider;
    this.localProvider = localProvider || null;
    this.cloudStore = cloudStore;
    this.getAzureKey = getAzureKey || (() => Promise.resolve(''));
    this.getActiveChannel = getActiveChannel || (() => Promise.resolve(''));
    this.getSettings = getSettings || (() => Promise.resolve(null));
  }

  private _localChannelReady(settings: any): boolean {
    const localTts = settings?.localTts || {};
    if (!Array.isArray(localTts.voices) || !localTts.voices.length) return false;
    if (localTts.mode === 'managed') {
      return Boolean(localTts.engine?.rootDir);
    }
    return Boolean(localTts.baseUrl);
  }

  private async _getActive(): Promise<AzureTtsProvider | CloudTtsProvider | LocalTtsProvider> {
    const explicit = await this.getActiveChannel();
    if (explicit === 'local') {
      return this.localProvider || this.azureProvider;
    }
    if (explicit === 'cloud') {
      return this.cloudProvider;
    }
    if (explicit === 'azure') {
      return this.azureProvider;
    }

    // 未显式选择时的兜底链：优先自填 key 路线
    const azureKey = await this.getAzureKey();
    if (azureKey) return this.azureProvider;

    const token = await this.cloudStore.loadToken();
    if (token?.access_token) return this.cloudProvider;

    if (this.localProvider) {
      try {
        const settings = await this.getSettings();
        if (this._localChannelReady(settings)) return this.localProvider;
      } catch {}
    }

    return this.azureProvider;
  }

  async listVoices(settingsOverride = {}): Promise<any[]> {
    const explicit = await this.getActiveChannel();
    if (explicit === 'local') {
      if (this.localProvider) {
        return this.localProvider.listVoices();
      }
      return [];
    }

    if (explicit === 'azure') {
      return this.azureProvider.listVoices(settingsOverride);
    }

    if (explicit === 'cloud') {
      const token = await this.cloudStore.loadToken();
      if (token?.access_token) {
        try {
          return await this.cloudProvider.listVoices(settingsOverride);
        } catch {
          return this.cloudProvider.listVoicesPublic();
        }
      }
      return this.cloudProvider.listVoicesPublic();
    }

    // 未显式选择时的兜底链
    const azureKey = await this.getAzureKey();
    if (azureKey) {
      return this.azureProvider.listVoices(settingsOverride);
    }

    const token = await this.cloudStore.loadToken();
    if (token?.access_token) {
      try {
        return await this.cloudProvider.listVoices(settingsOverride);
      } catch {
        return this.cloudProvider.listVoicesPublic();
      }
    }

    if (this.localProvider) {
      try {
        const settings = await this.getSettings();
        if (this._localChannelReady(settings)) {
          return await this.localProvider.listVoices();
        }
      } catch {}
    }

    return this.cloudProvider.listVoicesPublic();
  }

  async synthesize(payload: any): Promise<any> {
    const provider = await this._getActive();
    return provider.synthesize(payload);
  }

  /**
   * 试听预览：独立路由
   * - 若指定音色归属于本地（id 匹配或以 local_ 开头），直接由 localProvider 合成
   * - 显式 local → LocalProvider
   * - 显式 azure → AzureProvider
   * - 显式 cloud → CloudProvider
   * - 未显式选择 → 有自填 Key 且未禁用走 Azure（本地直接合成），其余走 Cloud（公开试听优先）
   */
  async synthesizePreview(payload: any): Promise<any> {
    const shortName = String(payload?.shortName || '');
    if (this.localProvider) {
      try {
        const settings = await this.getSettings();
        const isLocalVoice = (settings?.localTts?.voices || []).some((v: any) => v.id === shortName)
          || shortName.startsWith('local_');
        if (isLocalVoice) {
          return this.localProvider.synthesizePreview(payload);
        }
      } catch {}
    }

    const explicit = await this.getActiveChannel();
    if (explicit === 'local' && this.localProvider) {
      return this.localProvider.synthesizePreview(payload);
    }
    if (explicit === 'azure') {
      return this.azureProvider.synthesizePreview(payload);
    }
    if (explicit === 'cloud') {
      return this.cloudProvider.synthesizePreview(payload);
    }

    const azureKey = await this.getAzureKey();
    if (azureKey) return this.azureProvider.synthesizePreview(payload);
    return this.cloudProvider.synthesizePreview(payload);
  }

  // ─── 缓存管理（始终委托给 azureProvider，缓存与合成通道无关） ───
  async getBaseCacheDirNativePath(): Promise<string> {
    return this.azureProvider.getBaseCacheDirNativePath();
  }
  async getProjectCacheDirNativePath(projectName: string): Promise<string> {
    return this.azureProvider.getProjectCacheDirNativePath(projectName);
  }
  async listCacheFileNames(projectName: string): Promise<string[]> {
    return this.azureProvider.listCacheFileNames(projectName);
  }
  async deleteCacheFiles(projectName: string, fileNames: string[]): Promise<number> {
    return this.azureProvider.deleteCacheFiles(projectName, fileNames);
  }
  async deleteProjectCacheFolder(projectName: string): Promise<number> {
    return this.azureProvider.deleteProjectCacheFolder(projectName);
  }
  async deleteAllCacheFiles(): Promise<number> {
    return this.azureProvider.deleteAllCacheFiles();
  }
}
