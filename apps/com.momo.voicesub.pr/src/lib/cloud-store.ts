// @ts-ignore
import uxp from "uxp";
import { sha1Hex } from "./sha1";

/**
 * 云端账号 Token 存储 + 设备指纹生成（PR / UXP 版）
 *
 * 与 DR 版（Electron）的差异：
 * - 使用 UXP localFileSystem（非 Node fs）
 * - 无 safeStorage 加密 → 明文 JSON 存储（UXP 沙箱限制）
 * - 无 execSync/child_process → 用 UXP os 模块（platform/arch/cpus/totalmem/homedir）
 * - 无 crypto.createHash → 用纯 JS sha1Hex
 * - 无 os.networkInterfaces → 用 homedir（含用户名）+ 硬件信息组合
 */

const storage = uxp.storage;
const fs = storage.localFileSystem;

const TOKEN_FILE = 'cloud-token.json';
const DEVICE_FP_FILE = 'device-fp.txt';

// 设备指纹版本号：变更指纹算法时递增，旧指纹会自动重新生成。
// 使用 p 前缀（pr）区分于 DR 版的 v 前缀，两者指纹算法不同但互不冲突（client_type 也不同）。
const DEVICE_FP_VERSION = 1;

export interface TokenData {
  access_token: string;
  refresh_token: string;
  email: string;
  is_admin: boolean;
  nickname: string;
  saved_at?: string;
}

export class CloudStore {
  private _cachedDeviceFp: string | null = null;

  private async readFile(fileName: string): Promise<string | null> {
    try {
      const dataFolder = await fs.getDataFolder();
      const entry = await dataFolder.getEntry(fileName);
      if (entry && entry.isFile) {
        // @ts-ignore
        return await entry.read({ format: storage.formats.utf8 });
      }
    } catch (_) {
      // 文件不存在或读取失败
    }
    return null;
  }

  private async writeFile(fileName: string, content: string): Promise<void> {
    const dataFolder = await fs.getDataFolder();
    const entry = await dataFolder.createEntry(fileName, { overwrite: true });
    // @ts-ignore
    await entry.write(content, { format: storage.formats.utf8 });
  }

  private async deleteFile(fileName: string): Promise<void> {
    try {
      const dataFolder = await fs.getDataFolder();
      const entry = await dataFolder.getEntry(fileName);
      if (entry) await entry.delete();
    } catch (_) {
      // 文件不存在，忽略
    }
  }

  /**
   * 保存 token（明文存储，UXP 无 safeStorage）
   */
  async saveToken(tokenData: Partial<TokenData>): Promise<void> {
    const payload: TokenData = {
      access_token: tokenData.access_token || '',
      refresh_token: tokenData.refresh_token || '',
      email: tokenData.email || '',
      is_admin: tokenData.is_admin || false,
      nickname: tokenData.nickname || '',
      saved_at: new Date().toISOString(),
    };
    await this.writeFile(TOKEN_FILE, JSON.stringify(payload, null, 2));
  }

  /**
   * 读取 token
   * @returns {Promise<TokenData|null>} token 数据或 null（未登录）
   */
  async loadToken(): Promise<TokenData | null> {
    try {
      const raw = await this.readFile(TOKEN_FILE);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data.access_token) return null;
      return data as TokenData;
    } catch {
      // 文件损坏等情况，不抛异常，返回 null
      return null;
    }
  }

  /**
   * 清除 token（登出）
   */
  async clearToken(): Promise<void> {
    await this.deleteFile(TOKEN_FILE);
  }

  /**
   * 生成或读取稳定的设备指纹
   *
   * UXP os 模块仅提供 platform/arch/cpus/totalmem/homedir，
   * 无法像 DR 版那样读取注册表 MachineGuid 或 BIOS 序列号。
   * 但 homedir（Windows 上为 C:\Users\{username}）+ CPU + 内存容量
   * 组合在单机上足够稳定，只有重装系统或换机器才会变。
   *
   * 指纹带版本号前缀（p1:），便于后续算法升级时区分。
   */
  async getDeviceFp(): Promise<string> {
    if (this._cachedDeviceFp) return this._cachedDeviceFp;

    // 先尝试读取已保存的（需是当前版本，旧版本会重新生成）
    try {
      const saved = (await this.readFile(DEVICE_FP_FILE) || '').trim();
      if (saved && saved.startsWith(`p${DEVICE_FP_VERSION}:`) && saved.length >= 20) {
        this._cachedDeviceFp = saved;
        return saved;
      }
    } catch (_) {
      // 读取失败，继续生成新指纹
    }

    // 收集硬件/系统标识
    const parts: string[] = [];

    try {
      // @ts-ignore - UXP 提供 require('os')
      const os = require('os');

      const platform = typeof os.platform === 'function' ? os.platform() : '';
      if (platform) parts.push('plat:' + platform);

      const arch = typeof os.arch === 'function' ? os.arch() : '';
      if (arch) parts.push('arch:' + arch);

      // CPU 型号
      const cpus = typeof os.cpus === 'function' ? os.cpus() : [];
      if (cpus && cpus.length > 0 && cpus[0] && cpus[0].model) {
        parts.push('cpu:' + cpus[0].model);
      }

      // 总内存（字节）
      const totalmem = typeof os.totalmem === 'function' ? os.totalmem() : 0;
      if (totalmem) parts.push('mem:' + totalmem);

      // 用户主目录（Windows 上为 C:\Users\{username}，含用户名，是较好的标识）
      const homedir = typeof os.homedir === 'function' ? os.homedir() : '';
      if (homedir) parts.push('home:' + homedir);

      // OS 版本号（补充）
      const release = typeof os.release === 'function' ? os.release() : '';
      if (release) parts.push('rel:' + release);
    } catch (_) {
      // os 模块不可用时，回退到空标识（指纹仅基于随机数，稳定性降低但仍可用）
    }

    // 兆底：如果上面都拿不到，用固定标识 + 随机数（不稳定，但不会崩溃）
    if (parts.length === 0) {
      parts.push('fallback:' + 'momovoicesub-pr');
    }

    const fingerprint = parts.join('|');
    const hash = sha1Hex(fingerprint).substring(0, 32);
    const result = `p${DEVICE_FP_VERSION}:${hash}`;

    // 保存
    await this.writeFile(DEVICE_FP_FILE, result);

    this._cachedDeviceFp = result;
    return result;
  }
}
