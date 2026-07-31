'use strict';

/**
 * TTS Provider 委托器
 * 根据认证状态自动切换 AzureTtsProvider / CloudTtsProvider：
 *   1. 有自填 Azure Key → AzureTtsProvider（本地 key 路线，优先级最高）
 *   2. 无自填 key + 有云端 token → CloudTtsProvider（云端路线）
 *   3. 都没有 → AzureTtsProvider（会因无 key 报错，引导用户去设置）
 * 对外接口与 AzureTtsProvider 完全一致，resolveAdapter 无需感知切换
 */

class DelegatingTtsProvider {
  constructor({ azureProvider, cloudProvider, cloudStore, getAzureKey }) {
    this.azureProvider = azureProvider;
    this.cloudProvider = cloudProvider;
    this.cloudStore = cloudStore;
    this.getAzureKey = getAzureKey || (() => '');
  }

  async _getActive() {
    // 优先自填 key 路线：用户既填了 key 又登录了账号时，走自填 key
    const azureKey = await this.getAzureKey();
    if (azureKey) return this.azureProvider;

    const token = await this.cloudStore.loadToken();
    return token?.access_token ? this.cloudProvider : this.azureProvider;
  }

  async listVoices(settingsOverride = {}) {
    const provider = await this._getActive();
    // Cloud provider 忽略 settingsOverride，Azure provider 需要它
    return provider.listVoices(settingsOverride);
  }

  async synthesize(payload) {
    const provider = await this._getActive();
    return provider.synthesize(payload);
  }

  async synthesizePreview(payload) {
    const provider = await this._getActive();
    return provider.synthesizePreview(payload);
  }
}

module.exports = { DelegatingTtsProvider };
