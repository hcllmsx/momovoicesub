/**
 * 云端 API 客户端（PR / UXP 版）
 *
 * 与 DR 版（Electron）的差异：
 * - 使用 UXP 内置 fetch（无需 Node http）
 * - 无 Buffer → 返回 ArrayBuffer
 * - 无 TextDecoder → 用 response.text() + JSON.parse 替代
 * - JWT payload 解码用 atob（JWT payload 是 ASCII JSON，atob 足够）
 */

declare const __API_BASE_URL__: string;

const DEFAULT_BASE_URL = 'https://momovoicesub.sxrec.com';

export class CloudClient {
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor({ baseUrl, fetchImpl }: { baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    // __API_BASE_URL__ 由 Vite 构建时注入（dev→localhost，prod→生产域名）
    this.baseUrl = (baseUrl || (typeof __API_BASE_URL__ !== 'undefined' ? __API_BASE_URL__ : DEFAULT_BASE_URL)).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl || globalThis.fetch.bind(globalThis);
  }

  private async _request(path: string, { method = 'GET', token, body, headers = {} }: any = {}): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const finalHeaders: Record<string, string> = { ...headers };
    if (token) finalHeaders['Authorization'] = `Bearer ${token}`;
    if (body !== undefined && !finalHeaders['Content-Type']) {
      finalHeaders['Content-Type'] = 'application/json';
    }

    return await this.fetchImpl(url, {
      method,
      headers: finalHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  private async _parseJson(response: Response): Promise<any> {
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
  async login(email: string, password: string): Promise<any> {
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
   */
  async refreshToken(refreshToken: string): Promise<any> {
    const response = await this._request('/api/auth/refresh', {
      method: 'POST',
      body: { refresh_token: refreshToken },
    });

    const data = await this._parseJson(response);
    if (!response.ok) {
      const err: any = new Error(data.error || `刷新 token 失败 (${response.status})`);
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
  async getQuota(token: string): Promise<any> {
    const response = await this._request('/api/account/quota', { token });
    const data = await this._parseJson(response);

    if (response.status === 401) {
      const err: any = new Error('TOKEN_EXPIRED');
      err.code = 'TOKEN_EXPIRED';
      throw err;
    }
    if (response.status === 403) {
      const err: any = new Error(data.error || '账号已被封禁');
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
   * 自动携带 client_type='pr' 标识来源客户端
   */
  async registerDevice(token: string, deviceFp: string): Promise<any> {
    const response = await this._request('/api/account/devices', {
      method: 'POST',
      token,
      body: { device_fp: deviceFp, client_type: 'pr' },
    });

    const data = await this._parseJson(response);
    if (response.status === 401) {
      const err: any = new Error('TOKEN_EXPIRED');
      err.code = 'TOKEN_EXPIRED';
      throw err;
    }
    if (!response.ok) {
      const err: any = new Error(data.error || `注册设备失败 (${response.status})`);
      err.code = data.code || null;
      err.status = response.status;
      throw err;
    }

    return data;
  }

  /**
   * 启动/活跃心跳上报（匿名统计，包含自填 Key、云端账号及未配置）
   */
  async sendHeartbeat(params: {
    device_fp: string;
    client_type?: string;
    version?: string;
    mode?: string;
  }): Promise<boolean> {
    try {
      const response = await this._request('/api/telemetry/heartbeat', {
        method: 'POST',
        body: {
          device_fp: params.device_fp,
          client_type: params.client_type || 'pr',
          version: params.version,
          mode: params.mode,
        },
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
  async listVoices(token: string): Promise<any[]> {
    const response = await this._request('/api/tts/voices', { token });
    const data = await this._parseJson(response);

    if (response.status === 401) {
      const err: any = new Error('TOKEN_EXPIRED');
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
  async listVoicesPublic(): Promise<any[]> {
    const response = await this._request('/api/tts/voices');
    const data = await this._parseJson(response);
    if (!response.ok) {
      throw new Error(data.error || `获取音色列表失败 (${response.status})`);
    }
    return data.voices || [];
  }

  /**
   * 判断错误是否为瞬态网络错误（值得重试）。
   */
  private _isTransientNetworkError(err: any): boolean {
    const msg = (err && err.message) || String(err);
    return /Body is unusable|Body has already been read|fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|UND_ERR|network|Network Error/i.test(msg);
  }

  /**
   * 合成语音
   * @returns {Promise<ArrayBuffer>} WAV 音频
   *
   * 内置瞬态网络错误自动重试（最多 2 次）。
   * 鉴权类错误（401/403）不重试，直接抛出由上层处理。
   */
  async synthesize(token: string, payload: any): Promise<ArrayBuffer> {
    let lastErr: any;
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this._request('/api/tts/synthesize', {
          method: 'POST',
          token,
          body: payload,
        });

        if (response.status === 401) {
          const err: any = new Error('TOKEN_EXPIRED');
          err.code = 'TOKEN_EXPIRED';
          throw err;
        }
        if (response.status === 403) {
          const data = await this._parseJson(response);
          const err: any = new Error(data.error || '账号已被封禁');
          err.code = 'BANNED';
          err.banned_until = data.banned_until;
          throw err;
        }
        if (!response.ok) {
          const data = await this._parseJson(response);
          // 服务端错误（5xx）可能是瞬态的，也值得重试
          if (response.status >= 500 && attempt < maxRetries) {
            lastErr = new Error(data.error || `合成失败 (${response.status})`);
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
            continue;
          }
          throw new Error(data.error || `合成失败 (${response.status})`);
        }

        return await response.arrayBuffer();
      } catch (err: any) {
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
   * @param {string} shortName 音色短名
   * @returns {Promise<{wavBuffer: ArrayBuffer|null}>}
   */
  async fetchPreview(shortName: string): Promise<{ wavBuffer: ArrayBuffer | null }> {
    try {
      const encoded = encodeURIComponent(shortName);
      const response = await this.fetchImpl(
        `${this.baseUrl}/api/tts/preview/${encoded}`,
        { method: 'GET' }
      );

      if (!response.ok) {
        return { wavBuffer: null };
      }

      const arrayBuffer = await response.arrayBuffer();
      if (!arrayBuffer || arrayBuffer.byteLength === 0) {
        return { wavBuffer: null };
      }
      return { wavBuffer: arrayBuffer };
    } catch {
      return { wavBuffer: null };
    }
  }
}
