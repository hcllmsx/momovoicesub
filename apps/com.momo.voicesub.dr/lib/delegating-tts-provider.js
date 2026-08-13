'use strict';

/**
 * TTS Provider 委托器
 * 根据认证状态自动切换 AzureTtsProvider / CloudTtsProvider：
 *   1. 自填 Key 被"临时禁用" → CloudTtsProvider（即便有有效 Key 也不用；未登录则由云端报错引导）
 *   2. 有自填 Azure Key → AzureTtsProvider（本地 key 路线，优先级最高）
 *   3. 无自填 key + 有云端 token → CloudTtsProvider（云端路线）
 *   4. 都没有 → AzureTtsProvider（会因无 key 报错，引导用户去设置）
 * 对外接口与 AzureTtsProvider 完全一致，resolveAdapter 无需感知切换
 */

class DelegatingTtsProvider {
  constructor({ azureProvider, cloudProvider, cloudStore, getAzureKey, isAzureKeyDisabled }) {
    this.azureProvider = azureProvider;
    this.cloudProvider = cloudProvider;
    this.cloudStore = cloudStore;
    this.getAzureKey = getAzureKey || (() => '');
    this.isAzureKeyDisabled = isAzureKeyDisabled || (() => false);
  }

  async _getActive() {
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

  async listVoices(settingsOverride = {}) {
    // 试听/配音的 Provider 路由用 _getActive()，但音色列表有额外的"公开接口"兜底：
    // 无自填 Key + 未登录时，不走 AzureTtsProvider（会因无 key 报错），
    // 而是走 CloudTtsProvider.listVoicesPublic()（公开 manifest，不需要登录）
    const disabled = await this.isAzureKeyDisabled();
    if (!disabled) {
      const azureKey = await this.getAzureKey();
      if (azureKey) {
        // Cloud provider 忽略 settingsOverride，Azure provider 需要它
        return this.azureProvider.listVoices(settingsOverride);
      }
    }
    // 到这里：要么 key 禁用，要么没有 key
    const token = await this.cloudStore.loadToken();
    if (token?.access_token) {
      // 有 token 时尝试带 token 请求，失败（网络错误/token 过期且刷新也失败）时回退到公开接口
      try {
        return await this.cloudProvider.listVoices(settingsOverride);
      } catch {
        return this.cloudProvider.listVoicesPublic();
      }
    }
    // 无自填 Key + 未登录 → 公开音色列表接口
    return this.cloudProvider.listVoicesPublic();
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
