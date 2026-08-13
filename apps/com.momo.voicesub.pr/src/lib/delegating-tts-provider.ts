import { AzureTtsProvider } from "./azure-tts";
import { CloudTtsProvider } from "./cloud-tts-provider";
import { CloudStore } from "./cloud-store";

/**
 * TTS Provider 委托器（PR / UXP 版）
 *
 * 根据认证状态自动切换 AzureTtsProvider / CloudTtsProvider：
 *   1. 自填 Key 被"临时禁用" → CloudTtsProvider（即便有有效 Key 也不用；未登录则由云端报错引导）
 *   2. 有自填 Azure Key → AzureTtsProvider（本地 key 路线，优先级最高）
 *   3. 无自填 key + 有云端 token → CloudTtsProvider（云端路线）
 *   4. 都没有 → AzureTtsProvider（会因无 key 报错，引导用户去设置）
 *
 * 缓存管理方法（getBaseCacheDirNativePath 等）始终委托给 azureProvider，
 * 因为缓存是文件系统级的，与合成通道无关，两个 Provider 共享同一缓存目录。
 */
export class DelegatingTtsProvider {
  private azureProvider: AzureTtsProvider;
  private cloudProvider: CloudTtsProvider;
  private cloudStore: CloudStore;
  private getAzureKey: () => Promise<string>;
  private isAzureKeyDisabled: () => Promise<boolean>;

  constructor({ azureProvider, cloudProvider, cloudStore, getAzureKey, isAzureKeyDisabled }: any) {
    this.azureProvider = azureProvider;
    this.cloudProvider = cloudProvider;
    this.cloudStore = cloudStore;
    this.getAzureKey = getAzureKey || (() => Promise.resolve(''));
    this.isAzureKeyDisabled = isAzureKeyDisabled || (() => Promise.resolve(false));
  }

  private async _getActive(): Promise<AzureTtsProvider | CloudTtsProvider> {
    // 用户在自填 Key 页勾选"临时禁用"后，完全跳过自填 Key 通道：
    // 已登录云端 → 走云端；未登录 → 仍走云端（由云端报错引导登录，绝不再回退到自填 Key）
    const disabled = await this.isAzureKeyDisabled();
    if (disabled) return this.cloudProvider;

    // 未禁用时：优先自填 key 路线（用户既填了 key 又登录了账号时，走自填 key）
    const azureKey = await this.getAzureKey();
    if (azureKey) return this.azureProvider;

    const token = await this.cloudStore.loadToken();
    return token?.access_token ? this.cloudProvider : this.azureProvider;
  }

  async listVoices(settingsOverride = {}): Promise<any[]> {
    // 试听/配音的 Provider 路由用 _getActive()，但音色列表有额外的"公开接口"兜底：
    // 无自填 Key + 未登录时，不走 AzureTtsProvider（会因无 key 报错），
    // 而是走 CloudTtsProvider.listVoicesPublic()（公开 manifest，不需要登录）
    const disabled = await this.isAzureKeyDisabled();
    if (!disabled) {
      const azureKey = await this.getAzureKey();
      if (azureKey) {
        return this.azureProvider.listVoices(settingsOverride);
      }
    }
    // 到这里：要么 key 被禁用，要么没有 key
    const token = await this.cloudStore.loadToken();
    if (token?.access_token) {
      return this.cloudProvider.listVoices(settingsOverride);
    }
    // 无自填 Key + 未登录 → 公开音色列表接口
    return this.cloudProvider.listVoicesPublic();
  }

  async synthesize(payload: any): Promise<any> {
    const provider = await this._getActive();
    return provider.synthesize(payload);
  }

  async synthesizePreview(payload: any): Promise<any> {
    const provider = await this._getActive();
    return provider.synthesizePreview(payload);
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
