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

/**
 * 本地引擎（GPT-SoVITS 整合包）配置。仅 mode === 'managed' 时生效。
 * pythonPath 留空表示自动探测 <rootDir>/runtime/python.exe。
 */
const DEFAULT_LOCAL_ENGINE = {
  rootDir: '',
  pythonPath: '',
  script: 'api_v2.py',
  port: 9880,
  autoStart: false
};

/**
 * 本地部署配置。当前仅支持 GPT-SoVITS 原生 API (api_v2)。
 * mode:
 *   'managed' = 插件托管进程（配置整合包根目录，由插件拉起 api_v2.py）
 *   'url'     = 连接已有服务（手动填 Base URL，如部署在带显卡的远程机器）
 */
const DEFAULT_LOCAL_TTS = {
  serviceType: 'gpt-sovits', // 'gpt-sovits'
  mode: 'managed', // 'managed' | 'url'
  engine: { ...DEFAULT_LOCAL_ENGINE },
  baseUrl: '',
  textLang: 'auto', // 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'yue'
  voices: []
};

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
  activeChannel: '', // '' | 'azure' | 'cloud' | 'local'；'' 表示未显式选择（走隐式推断）
  localTts: DEFAULT_LOCAL_TTS,
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
    const raw = settings || {};
    const merged = { ...DEFAULT_SETTINGS, ...raw };

    // 迁移：老配置中 azureKeyDisabled === true 且未显式指定 activeChannel 时，迁移为 'cloud'
    if (!merged.activeChannel && raw.azureKeyDisabled === true) {
      merged.activeChannel = 'cloud';
    }

    // 校验 activeChannel 合法值
    if (!['', 'azure', 'cloud', 'local'].includes(merged.activeChannel)) {
      merged.activeChannel = '';
    }

    // 补全 localTts 缺省字段
    const rawLocal = raw.localTts || {};
    merged.localTts = {
      ...DEFAULT_LOCAL_TTS,
      ...rawLocal,
      // engine 需深度合并，否则存量配置补齐时会丢掉已填的 rootDir
      engine: { ...DEFAULT_LOCAL_ENGINE, ...(rawLocal.engine || {}) }
    };

    // 迁移：本版本起仅支持 GPT-SoVITS 原生协议，旧的 OpenAI 兼容配置不再受支持。
    // OpenAI 型音色为 { id, name, voice, model }，与 GPT-SoVITS 的
    // { id, name, gptWeightsPath, sovitsWeightsPath, refAudioPath, promptText } 结构不兼容，
    // 直接丢弃音色列表，保留 Base URL 供用户改接 GPT-SoVITS 服务。
    if (rawLocal.apiType && rawLocal.apiType !== 'gptsovits') {
      merged.localTts.voices = [];
      merged.localTts.mode = 'url';
    }
    // 清理已废弃字段，避免脏数据长期滞留
    delete merged.localTts.apiType;
    delete merged.localTts.apiKey;
    delete merged.localTts.apiKeyEncrypted;
    delete merged.localTts.model;

    if (!['gpt-sovits'].includes(merged.localTts.serviceType)) {
      merged.localTts.serviceType = 'gpt-sovits';
    }
    if (!['managed', 'url'].includes(merged.localTts.mode)) {
      merged.localTts.mode = 'url';
    }
    if (!Array.isArray(merged.localTts.voices)) {
      merged.localTts.voices = [];
    }
    const port = Number(merged.localTts.engine.port);
    merged.localTts.engine.port = Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_LOCAL_ENGINE.port;

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

    // localTts 必须在 ensureDefaults 之前做深度合并。
    // 调用方常只传局部对象（如主进程写回 baseUrl 时只传 { baseUrl }），
    // 若直接浅合并，ensureDefaults 会把缺失的 engine 重置成默认值，
    // 导致已保存的整合包目录 rootDir 被清空。
    const mergedInput = { ...previous, ...nextSettings };
    if (nextSettings.localTts) {
      mergedInput.localTts = {
        ...(previous.localTts || {}),
        ...nextSettings.localTts,
        engine: { ...(previous.localTts?.engine || {}), ...(nextSettings.localTts.engine || {}) }
      };
    }

    const settings = this.ensureDefaults(mergedInput);
    
    // 显式删除旧字段 azureKeyDisabled，促使存量配置逐步自净
    delete settings.azureKeyDisabled;

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
    delete redacted.azureKeyDisabled;

    return redacted;
  }

  async getRedacted() {
    return this.redact(await this.load());
  }
}

module.exports = {
  SettingsStore,
  DEFAULT_SETTINGS,
  DEFAULT_LOCAL_TTS,
  DEFAULT_LOCAL_ENGINE,
  POLYPHONIC_USER_DICT_FILE
};
