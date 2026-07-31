'use strict';

/**
 * 云端账号 Token 存储 + 设备指纹生成
 * Token 使用 Electron safeStorage 加密存储
 * 设备指纹基于机器信息生成稳定哈希
 */

const fs = (() => {
  try { return require('fs/promises'); } catch (_) {
    const _fs = require('fs');
    const { promisify } = require('util');
    return {
      readFile: promisify(_fs.readFile),
      writeFile: promisify(_fs.writeFile),
      mkdir: promisify(_fs.mkdir),
      stat: promisify(_fs.stat),
      unlink: promisify(_fs.unlink),
    };
  }
})();
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const TOKEN_FILE = 'cloud-token.json';
const DEVICE_FP_FILE = 'device-fp.txt';

class CloudStore {
  constructor({ appDataDir, safeStorage }) {
    this.appDataDir = appDataDir;
    this.safeStorage = safeStorage;
    this.tokenPath = path.join(appDataDir, TOKEN_FILE);
    this.deviceFpPath = path.join(appDataDir, DEVICE_FP_FILE);
    this._cachedDeviceFp = null;
  }

  _canEncrypt() {
    return Boolean(this.safeStorage?.isEncryptionAvailable?.());
  }

  /**
   * 保存 token（加密存储）
   */
  async saveToken(tokenData) {
    await fs.mkdir(this.appDataDir, { recursive: true });

    const payload = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || '',
      email: tokenData.email || '',
      is_admin: tokenData.is_admin || false,
      nickname: tokenData.nickname || '',
      saved_at: new Date().toISOString(),
    };

    const json = JSON.stringify(payload);

    if (this._canEncrypt()) {
      const encrypted = this.safeStorage.encryptString(json);
      await fs.writeFile(this.tokenPath, encrypted.toString('base64'), 'utf8');
    } else {
      // safeStorage 不可用时退化为明文（开发环境）
      await fs.writeFile(this.tokenPath, json, 'utf8');
    }
  }

  /**
   * 读取 token（解密）
   * @returns {Promise<object|null>} token 数据或 null（未登录）
   */
  async loadToken() {
    try {
      const raw = await fs.readFile(this.tokenPath, 'utf8');
      let json;

      if (this._canEncrypt()) {
        try {
          const buf = Buffer.from(raw, 'base64');
          json = this.safeStorage.decryptString(buf);
        } catch {
          // 可能是旧版明文存储，尝试直接解析
          json = raw;
        }
      } else {
        json = raw;
      }

      const data = JSON.parse(json);
      if (!data.access_token) return null;
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      // 文件损坏等情况，不抛异常，返回 null
      return null;
    }
  }

  /**
   * 清除 token（登出）
   */
  async clearToken() {
    try {
      await fs.unlink(this.tokenPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  /**
   * 生成或读取稳定的设备指纹
   * 基于：hostname + CPU + MAC + 用户名，SHA256 哈希
   */
  async getDeviceFp() {
    if (this._cachedDeviceFp) return this._cachedDeviceFp;

    // 先尝试读取已保存的
    try {
      const saved = (await fs.readFile(this.deviceFpPath, 'utf8')).trim();
      if (saved && saved.length >= 16) {
        this._cachedDeviceFp = saved;
        return saved;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    // 生成新的指纹
    const interfaces = os.networkInterfaces();
    const macs = [];
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
          macs.push(iface.mac);
        }
      }
    }

    const fingerprint = [
      os.hostname(),
      os.cpus()[0]?.model || 'unknown-cpu',
      String(os.totalmem()),
      os.userInfo().username || 'unknown-user',
      macs.sort().join(','),
    ].join('|');

    const hash = crypto.createHash('sha256').update(fingerprint).digest('hex').substring(0, 32);

    // 保存
    await fs.mkdir(this.appDataDir, { recursive: true });
    await fs.writeFile(this.deviceFpPath, hash, 'utf8');

    this._cachedDeviceFp = hash;
    return hash;
  }
}

module.exports = { CloudStore };
