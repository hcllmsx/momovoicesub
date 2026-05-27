'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DEFAULT_SETTINGS = {
  region: 'eastasia',
  endpoint: '',
  defaultVoice: 'zh-CN-XiaoxiaoNeural',
  defaultStyle: '',
  defaultRate: '0%',
  defaultPitch: '0%',
  overwriteMode: 'skip',
  rememberKey: false,
  voices: [],
  cacheDir: ''
};

class SettingsStore {
  constructor({ appDataDir, safeStorage }) {
    this.appDataDir = appDataDir;
    this.safeStorage = safeStorage;
    this.settingsPath = path.join(appDataDir, 'settings.json');
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
    try {
      const raw = fs.readFileSync(this.settingsPath, 'utf8');
      return this.ensureDefaults(JSON.parse(raw));
    } catch {
      return this.ensureDefaults();
    }
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.settingsPath, 'utf8');
      return this.ensureDefaults(JSON.parse(raw));
    } catch {
      return this.ensureDefaults();
    }
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

    await fsp.mkdir(this.appDataDir, { recursive: true });
    await fsp.writeFile(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    return this.redact(settings);
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
  DEFAULT_SETTINGS
};
