'use strict';

/**
 * TTS Provider 委托器
 * 根据 activeChannel 显式设置或认证状态自动切换 AzureTtsProvider / CloudTtsProvider / LocalTtsProvider：
 *   1. activeChannel === 'local' → LocalTtsProvider
 *   2. activeChannel === 'cloud' → CloudTtsProvider
 *   3. activeChannel === 'azure' → AzureTtsProvider
 *   4. 未显式选择（'' 或 undefined）→ 隐式推断：
 *      a. 有自填 Azure Key → AzureTtsProvider
 *      b. 无 key + 有云端 token → CloudTtsProvider
 *      c. 本地通道可用（managed 有整合包目录 / url 有 baseUrl）且有本地音色 → LocalTtsProvider
 *      d. 都没有 → AzureTtsProvider（会因无 key 报错，引导用户去设置）
 * 对外接口完全同构，业务调用方无需感知切换
 */

class DelegatingTtsProvider {
  constructor({ azureProvider, cloudProvider, localProvider, cloudStore, getAzureKey, getActiveChannel, getSettings }) {
    this.azureProvider = azureProvider;
    this.cloudProvider = cloudProvider;
    this.localProvider = localProvider || null;
    this.cloudStore = cloudStore;
    this.getAzureKey = getAzureKey || (() => '');
    this.getActiveChannel = getActiveChannel || (() => '');
    this.getSettings = getSettings || (() => null);
  }

  async _getActive() {
    const explicit = this.getActiveChannel ? await this.getActiveChannel() : '';
    if (explicit === 'local') {
      return this.localProvider || this.azureProvider;
    }
    if (explicit === 'cloud') {
      return this.cloudProvider;
    }
    if (explicit === 'azure') {
      return this.azureProvider;
    }

    // 未显式选择时：隐式推断
    const azureKey = await this.getAzureKey();
    if (azureKey) return this.azureProvider;

    const token = await this.cloudStore.loadToken();
    if (token?.access_token) return this.cloudProvider;

    if (this.localProvider && this.getSettings) {
      try {
        const settings = await this.getSettings();
        if (this._localChannelReady(settings)) return this.localProvider;
      } catch {}
    }

    return this.azureProvider;
  }

  /**
   * 本地通道是否"可推断"：
   * - managed 模式：服务地址由端口推导（127.0.0.1:<engine.port>），
   *   无需手填 baseUrl，只要配置了整合包目录 + 本地音色即可。
   * - url 模式：必须手填了 baseUrl。
   */
  _localChannelReady(settings) {
    const localTts = settings?.localTts || {};
    if (!Array.isArray(localTts.voices) || !localTts.voices.length) return false;
    if (localTts.mode === 'managed') {
      return Boolean(localTts.engine?.rootDir);
    }
    return Boolean(localTts.baseUrl);
  }

  async listVoices(settingsOverride = {}) {
    const explicit = this.getActiveChannel ? await this.getActiveChannel() : '';
    
    if (explicit === 'local') {
      if (this.localProvider) {
        return this.localProvider.listVoices(settingsOverride);
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

    if (this.localProvider && this.getSettings) {
      try {
        const settings = await this.getSettings();
        if (this._localChannelReady(settings)) {
          return await this.localProvider.listVoices(settingsOverride);
        }
      } catch {}
    }

    // 默认回退到云端公开音色列表接口
    return this.cloudProvider.listVoicesPublic();
  }

  async synthesize(payload) {
    const provider = await this._getActive();
    return provider.synthesize(payload);
  }

  /**
   * 试听预览：独立路由
   * - 显式 local → LocalProvider（若未注入则走 cloud 兜底）
   * - 显式 azure → AzureProvider
   * - 显式 cloud → CloudProvider
   * - 未显式选择 → 有自填 Key 走 Azure（本地直接合成），其余走 Cloud（公开试听优先）
   */
  async synthesizePreview(payload) {
    // 若指定了音色，先判断音色自身归属：本地音色必须由 localProvider 试听
    if (this.localProvider && this.getSettings) {
      try {
        const settings = await this.getSettings();
        const isLocalVoice = (settings?.localTts?.voices || []).some(v => v.id === payload?.shortName)
          || String(payload?.shortName || '').startsWith('local_');
        if (isLocalVoice) {
          return this.localProvider.synthesizePreview(payload);
        }
      } catch {}
    }

    const explicit = this.getActiveChannel ? await this.getActiveChannel() : '';
    if (explicit === 'local' && this.localProvider) {
      return this.localProvider.synthesizePreview(payload);
    }
    if (explicit === 'azure') {
      return this.azureProvider.synthesizePreview(payload);
    }
    if (explicit === 'cloud') {
      return this.cloudProvider.synthesizePreview(payload);
    }

    // 未显式选择
    const azureKey = await this.getAzureKey();
    if (azureKey) {
      return this.azureProvider.synthesizePreview(payload);
    }
    return this.cloudProvider.synthesizePreview(payload);
  }
}

module.exports = { DelegatingTtsProvider };
