'use strict';

/**
 * 云端 API 客户端
 * 负责与 momovoicesub.sxrec.com 通信（API 与 Web 同域名，/api/* 路径走 Cloud Functions）
 */

const DEFAULT_BASE_URL = 'https://momovoicesub.sxrec.com';

class CloudClient {
  constructor({ baseUrl, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
  }

  async _request(path, { method = 'GET', token, body, headers = {} } = {}) {
    const url = `${this.baseUrl}${path}`;
    const finalHeaders = { ...headers };
    if (token) finalHeaders['Authorization'] = `Bearer ${token}`;
    if (body !== undefined && !finalHeaders['Content-Type']) {
      finalHeaders['Content-Type'] = 'application/json';
    }

    const response = await this.fetchImpl(url, {
      method,
      headers: finalHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    return response;
  }

  async _parseJson(response) {
    const text = await response.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return { _raw: text };
    }
  }

  /**
   * 登录
   * @returns {Promise<{access_token, refresh_token, is_admin, nickname}>}
   */
  async login(email, password) {
    const response = await this._request('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });

    const data = await this._parseJson(response);
    if (!response.ok) {
      throw new Error(data.error || data.message || `登录失败 (${response.status})`);
    }

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      is_admin: data.is_admin || false,
      nickname: data.nickname || null,
    };
  }

  /**
   * 用 refresh_token 刷新 access_token
   * @returns {Promise<{access_token, refresh_token, is_admin}>}
   */
  async refreshToken(refreshToken) {
    const response = await this._request('/api/auth/refresh', {
      method: 'POST',
      body: { refresh_token: refreshToken },
    });

    const data = await this._parseJson(response);
    if (!response.ok) {
      const err = new Error(data.error || `刷新 token 失败 (${response.status})`);
      err.code = 'REFRESH_FAILED';
      throw err;
    }

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      is_admin: data.is_admin || false,
    };
  }

  /**
   * 获取配额
   */
  async getQuota(token) {
    const response = await this._request('/api/account/quota', { token });
    const data = await this._parseJson(response);

    if (response.status === 401) {
      const err = new Error('TOKEN_EXPIRED');
      err.code = 'TOKEN_EXPIRED';
      throw err;
    }
    if (response.status === 403) {
      const err = new Error(data.error || '账号已被封禁');
      err.code = 'BANNED';
      err.banned_until = data.banned_until;
      throw err;
    }
    if (!response.ok) {
      throw new Error(data.error || `获取配额失败 (${response.status})`);
    }

    return data;
  }

  /**
   * 注册/刷新当前设备指纹
   * 让 Web 端的"设备绑定管理"看到此设备
   * 自动携带 client_type='dr' 标识来源客户端
   */
  async registerDevice(token, deviceFp) {
    const response = await this._request('/api/account/devices', {
      method: 'POST',
      token,
      body: { device_fp: deviceFp, client_type: 'dr' },
    });

    const data = await this._parseJson(response);
    if (response.status === 401) {
      const err = new Error('TOKEN_EXPIRED');
      err.code = 'TOKEN_EXPIRED';
      throw err;
    }
    if (!response.ok) {
      const err = new Error(data.error || `注册设备失败 (${response.status})`);
      // 传递服务端的 code（如 DEVICE_LIMIT）和 HTTP 状态码，便于上层区分处理
      err.code = data.code || null;
      err.status = response.status;
      throw err;
    }

    return data;
  }

  /**
   * 启动/活跃心跳上报（匿名统计，包含自填 Key、云端账号及未配置）
   * @param {{ device_fp: string, client_type?: string, version?: string, mode?: string }} params
   */
  async sendHeartbeat({ device_fp, client_type = 'dr', version, mode } = {}) {
    try {
      const response = await this._request('/api/telemetry/heartbeat', {
        method: 'POST',
        body: { device_fp, client_type, version, mode },
      });
      return response.ok;
    } catch {
      // 容错防崩：心跳失败静默忽略
      return false;
    }
  }

  /**
   * 获取音色列表
   */
  async listVoices(token) {
    const response = await this._request('/api/tts/voices', { token });
    const data = await this._parseJson(response);

    if (response.status === 401) {
      const err = new Error('TOKEN_EXPIRED');
      err.code = 'TOKEN_EXPIRED';
      throw err;
    }
    if (!response.ok) {
      throw new Error(data.error || `获取音色列表失败 (${response.status})`);
    }

    return data.voices || [];
  }

  /**
   * 获取音色列表（公开接口，不需要登录）
   *
   * 调用 GET /api/tts/voices（公开路由，返回 manifest 中已预生成试听音频的音色）。
   * 用于"无自填 Key + 未登录"状态下让用户仍能浏览音色列表。
   */
  async listVoicesPublic() {
    const response = await this._request('/api/tts/voices');
    const data = await this._parseJson(response);
    if (!response.ok) {
      throw new Error(data.error || `获取音色列表失败 (${response.status})`);
    }
    return data.voices || [];
  }

  /**
   * 判断错误是否为瞬态网络错误（值得重试）。
   * 典型场景：Node.js undici 连接池复用时 body 流损坏（"Body is unusable"）、
   * TCP 连接重置、超时等。这些错误重试一次通常即可成功。
   */
  _isTransientNetworkError(err) {
    const msg = (err && err.message) || String(err);
    return /Body is unusable|Body has already been read|fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|UND_ERR|network|Network Error/i.test(msg);
  }

  /**
   * 合成语音
   * @returns {Promise<Buffer>} WAV 音频
   *
   * 内置瞬态网络错误自动重试（最多 2 次），应对 Node.js undici 连接池复用
   * 导致的 "Body is unusable: Body has already been read" 等瞬态错误。
   * 鉴权类错误（401/403）不重试，直接抛出由上层处理。
   */
  async synthesize(token, payload) {
    let lastErr;
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this._request('/api/tts/synthesize', {
          method: 'POST',
          token,
          body: payload,
        });

        // 先一次性读取 body 为 ArrayBuffer，避免不同分支重复读取导致
        // "Body is unusable: Body has already been read" 错误
        const arrayBuffer = await response.arrayBuffer();

        if (response.status === 401) {
          const err = new Error('TOKEN_EXPIRED');
          err.code = 'TOKEN_EXPIRED';
          throw err;
        }
        if (response.status === 403) {
          const data = this._tryParseJson(arrayBuffer);
          const err = new Error(data.error || '账号已被封禁');
          err.code = 'BANNED';
          err.banned_until = data.banned_until;
          throw err;
        }
        if (!response.ok) {
          const data = this._tryParseJson(arrayBuffer);
          // 服务端错误（5xx）可能是瞬态的，也值得重试
          if (response.status >= 500 && attempt < maxRetries) {
            lastErr = new Error(data.error || `合成失败 (${response.status})`);
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
            continue;
          }
          throw new Error(data.error || `合成失败 (${response.status})`);
        }

        return Buffer.from(arrayBuffer);
      } catch (err) {
        // 鉴权类错误不重试，直接抛出
        if (err.code === 'TOKEN_EXPIRED' || err.code === 'BANNED') throw err;
        // 瞬态网络错误重试
        if (this._isTransientNetworkError(err) && attempt < maxRetries) {
          lastErr = err;
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }

    throw lastErr || new Error('合成失败');
  }

  /**
   * 获取预生成的试听音频（公开接口，不需要 token，不消耗配额）。
   *
   * 云端已通过管理员脚本预生成所有音色的试听音频并存储在 Supabase Storage。
   * 此接口直接返回预生成的音频，不经过 Azure TTS，不消耗用户配额。
   *
   * @param {string} shortName 音色短名
   * @returns {Promise<{wavBuffer: Buffer|null}>}
   *   - wavBuffer 非空：成功获取预生成音频
   *   - wavBuffer 为 null：云端尚未预生成此音色，调用方应回退到 synthesize()
   */
  async fetchPreview(shortName) {
    try {
      const encoded = encodeURIComponent(shortName);
      const response = await this.fetchImpl(
        `${this.baseUrl}/api/tts/preview/${encoded}`,
        { method: 'GET' }
      );

      // 404 = 尚未预生成；其他非 200 也视为不可用，统一回退
      if (!response.ok) {
        return { wavBuffer: null };
      }

      const arrayBuffer = await response.arrayBuffer();
      if (!arrayBuffer || arrayBuffer.byteLength === 0) {
        return { wavBuffer: null };
      }
      return { wavBuffer: Buffer.from(arrayBuffer) };
    } catch {
      // 网络异常等，回退到 synthesize
      return { wavBuffer: null };
    }
  }

  /**
   * 从已读取的 ArrayBuffer 尝试解析 JSON（失败返回空对象）
   */
  _tryParseJson(arrayBuffer) {
    try {
      const text = new TextDecoder().decode(arrayBuffer);
      return text ? JSON.parse(text) : {};
    } catch {
      return {};
    }
  }
}

module.exports = { CloudClient, DEFAULT_BASE_URL };
