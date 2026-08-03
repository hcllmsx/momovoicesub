'use strict';

/**
 * 云端账号 Token 存储 + 设备指纹生成
 * Token 使用 Electron safeStorage 加密存储
 * 设备指纹基于硬件标识（Windows MachineGuid + BIOS 序列号 + MAC）生成稳定哈希
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

// 设备指纹版本号：变更指纹算法时递增，旧指纹会自动重新生成
const DEVICE_FP_VERSION = 2;

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
   *
   * 优先使用硬件级标识（Windows MachineGuid + BIOS 序列号），
   * 这些标识不受改计算机名/新建用户/换 MAC 影响，只有重装系统或换机器才会变。
   * 在非 Windows 环境或拿不到硬件标识时回退到 os 信息组合。
   *
   * 指纹带版本号前缀（v2:），便于后续算法升级时区分。
   */
  async getDeviceFp() {
    if (this._cachedDeviceFp) return this._cachedDeviceFp;

    // 先尝试读取已保存的（需是当前版本，旧版本会重新生成）
    try {
      const saved = (await fs.readFile(this.deviceFpPath, 'utf8')).trim();
      if (saved && saved.startsWith(`v${DEVICE_FP_VERSION}:`) && saved.length >= 20) {
        this._cachedDeviceFp = saved;
        return saved;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    // 收集硬件标识
    const parts = [];

    // 1. Windows MachineGuid（注册表，每个 Windows 安装唯一）
    const machineGuid = this._readWindowsMachineGuid();
    if (machineGuid) parts.push('guid:' + machineGuid);

    // 2. BIOS 序列号（比 baseboard 序列号更可靠）
    const biosSerial = this._readBiosSerial();
    if (biosSerial) parts.push('bios:' + biosSerial);

    // 3. MAC 地址作为补充（硬件标识拿不到时的主要依据）
    const macs = this._collectMacAddresses();
    if (macs.length) parts.push('mac:' + macs.sort().join(','));

    // 4. 兆底：如果上面都拿不到，用 os 信息（老方案）
    if (parts.length === 0) {
      parts.push('host:' + os.hostname());
      parts.push('cpu:' + (os.cpus()[0]?.model || 'unknown'));
      parts.push('mem:' + os.totalmem());
      parts.push('user:' + (os.userInfo().username || 'unknown'));
    }

    const fingerprint = parts.join('|');
    const hash = crypto.createHash('sha256').update(fingerprint).digest('hex').substring(0, 32);
    const result = `v${DEVICE_FP_VERSION}:${hash}`;

    // 保存
    await fs.mkdir(this.appDataDir, { recursive: true });
    await fs.writeFile(this.deviceFpPath, result, 'utf8');

    this._cachedDeviceFp = result;
    return result;
  }

  /**
   * 读取 Windows MachineGuid（注册表 HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid）
   * 每个 Windows 安装唯一，重装系统会变。
   * @returns {string|null}
   */
  _readWindowsMachineGuid() {
    if (process.platform !== 'win32') return null;
    try {
      const { execSync } = require('child_process');
      const out = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
        { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] }
      );
      const m = out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/);
      return m ? m[1].trim() : null;
    } catch {
      return null;
    }
  }

  /**
   * 读取 BIOS 序列号（通过 PowerShell）
   * 比 baseboard 序列号更可靠，但虚拟机可能重复。
   * @returns {string|null}
   */
  _readBiosSerial() {
    if (process.platform !== 'win32') return null;
    try {
      const { execSync } = require('child_process');
      const out = execSync(
        'powershell -NoProfile -Command "(Get-CimInstance Win32_BIOS).SerialNumber"',
        { encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'ignore'] }
      ).trim();
      // 过滤掉 OEM 默认占位值
      if (!out || /to be filled|default|string|o\.e\.m|system serial/i.test(out)) return null;
      return out;
    } catch {
      return null;
    }
  }

  /**
   * 收集非内部网卡的 MAC 地址
   * @returns {string[]}
   */
  _collectMacAddresses() {
    const interfaces = os.networkInterfaces();
    const macs = [];
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
          macs.push(iface.mac);
        }
      }
    }
    return macs;
  }
}

module.exports = { CloudStore };
