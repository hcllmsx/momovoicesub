'use strict';

const fs = require('fs');
const fsp = (() => {
  try { return require('fs/promises'); } catch (_) {
    const _fs = require('fs');
    const { promisify } = require('util');
    return {
      readFile: promisify(_fs.readFile),
      writeFile: promisify(_fs.writeFile),
      mkdir: promisify(_fs.mkdir),
      stat: promisify(_fs.stat),
    };
  }
})();
const path = require('path');

const DEFAULT_SETTINGS = {
  region: 'eastasia',
  endpoint: '',
  defaultVoice: 'zh-CN-XiaoxiaoNeural',
  defaultStyle: '',
  defaultStyledegree: '1.0',
  defaultRole: '',
  defaultVolume: '100%',
  defaultRate: '0%',
  defaultPitch: '0%',
  overwriteMode: 'skip',
  rememberKey: false,
  voices: [],
  favoriteVoices: [],
  cacheDir: '',
  polyphonicDict: []
};

const POLYPHONIC_USER_DICT_FILE = 'polyphonic-user-dict.json';

class SettingsStore {
  constructor({ appDataDir, safeStorage }) {
    this.appDataDir = appDataDir;
    this.safeStorage = safeStorage;
    this.settingsPath = path.join(appDataDir, 'settings.json');
    this.polyDictPath = path.join(appDataDir, POLYPHONIC_USER_DICT_FILE);
    this.sessionAzureKey = '';
  }

  ensureDefaults(settings) {
    const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    if (!merged.cacheDir) {
      merged.cacheDir = path.join(this.appDataDir, 'cache');
    }
    return merged;
  }

  loadSync() {
    let settings = {};
    try {
      const raw = fs.readFileSync(this.settingsPath, 'utf8');
      settings = JSON.parse(raw);
    } catch {}
    
    // 同步读取并合并独立的多音字词典
    try {
      const rawPoly = fs.readFileSync(this.polyDictPath, 'utf8');
      const parsed = JSON.parse(rawPoly);
      if (Array.isArray(parsed)) {
        settings.polyphonicDict = parsed;
      }
    } catch {}

    return this.ensureDefaults(settings);
  }

  async load() {
    let settings = {};
    try {
      const raw = await fsp.readFile(this.settingsPath, 'utf8');
      settings = JSON.parse(raw);
    } catch {}

    // 异步读取并合并独立的多音字词典
    try {
      const parsed = await this.loadPolyDict();
      if (Array.isArray(parsed)) {
        settings.polyphonicDict = parsed;
      }
    } catch {}

    return this.ensureDefaults(settings);
  }

  async save(nextSettings) {
    const previous = await this.load();
    const settings = this.ensureDefaults({ ...previous, ...nextSettings });
    const azureKey = nextSettings.azureKey;
    delete settings.azureKey;

    if (typeof azureKey === 'string') {
      this.sessionAzureKey = azureKey.trim();
      delete settings.azureKeyEncrypted;

      if (settings.rememberKey && this.sessionAzureKey && this.safeStorage?.isEncryptionAvailable?.()) {
        const encrypted = this.safeStorage.encryptString(this.sessionAzureKey);
        settings.azureKeyEncrypted = encrypted.toString('base64');
      }
    }

    // 保存用户自定义多音字词典到独立 JSON 文件，方便维护
    const polyDict = settings.polyphonicDict;
    if (polyDict && Array.isArray(polyDict)) {
      await this.savePolyDict(polyDict);
    }

    await fsp.mkdir(this.appDataDir, { recursive: true });
    await fsp.writeFile(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    return this.redact(settings);
  }

  async savePolyDict(entries) {
    await fsp.mkdir(this.appDataDir, { recursive: true });
    await fsp.writeFile(this.polyDictPath, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  }

  async loadPolyDict() {
    try {
      const raw = await fsp.readFile(this.polyDictPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      return [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async getAzureKey() {
    if (this.sessionAzureKey) return this.sessionAzureKey;

    const settings = await this.load();
    if (settings.azureKeyEncrypted && this.safeStorage?.isEncryptionAvailable?.()) {
      try {
        this.sessionAzureKey = this.safeStorage.decryptString(Buffer.from(settings.azureKeyEncrypted, 'base64'));
        return this.sessionAzureKey;
      } catch {
        return '';
      }
    }

    return '';
  }

  redact(settings) {
    const redacted = { ...this.ensureDefaults(settings) };
    redacted.hasAzureKey = Boolean(this.sessionAzureKey || redacted.azureKeyEncrypted);
    redacted.canEncryptKey = Boolean(this.safeStorage?.isEncryptionAvailable?.());
    delete redacted.azureKey;
    delete redacted.azureKeyEncrypted;
    return redacted;
  }

  async getRedacted() {
    return this.redact(await this.load());
  }
}

module.exports = {
  SettingsStore,
  DEFAULT_SETTINGS,
  POLYPHONIC_USER_DICT_FILE
};
