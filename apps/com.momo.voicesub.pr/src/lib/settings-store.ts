// @ts-ignore
import uxp from "uxp";

const storage = uxp.storage;
const fs = storage.localFileSystem;

export interface VoiceInfo {
  shortName: string;
  displayName: string;
  localName: string;
  locale: string;
  gender: string;
  styles: string[];
  roles: string[];
  wordsPerMinute: number | null;
}

export interface LocalTtsEngineSettings {
  rootDir: string;
  port: number;
  pythonPath: string;
  script: string;
}

export interface LocalTtsVoice {
  id: string;
  name: string;
  avatarType?: string;
  emotion?: string;
  gender?: string;
  avatar?: string;
  modelName?: string;
  modelVersion?: string;
  gptWeightsPath?: string;
  sovitsWeightsPath?: string;
  refAudioPath?: string;
  promptText?: string;
  promptLang?: string;
  auxRefAudioPaths?: string[];
}

export interface LocalTtsSettings {
  serviceType: 'gpt-sovits';
  mode: 'managed' | 'url';
  engine: LocalTtsEngineSettings;
  baseUrl: string;
  textLang: string;
  voices: LocalTtsVoice[];
  lastVoice?: string;
}

export const DEFAULT_LOCAL_TTS: LocalTtsSettings = {
  serviceType: 'gpt-sovits',
  mode: 'managed',
  engine: {
    rootDir: '',
    port: 9880,
    pythonPath: '',
    script: 'api_v2.py'
  },
  baseUrl: 'http://127.0.0.1:9880',
  textLang: 'auto',
  voices: []
};

export interface Settings {
  region: string;
  endpoint: string;
  activeChannel?: 'cloud' | 'azure' | 'local' | '';
  localTts?: LocalTtsSettings;
  defaultVoice: string;
  defaultStyle: string;
  defaultStyledegree: string;
  defaultRole: string;
  defaultVolume: string;
  defaultRate: string;
  defaultPitch: string;
  overwriteMode: string;
  rememberKey: boolean;
  azureKey?: string;
  voices: VoiceInfo[];
  favoriteVoices: string[];
  cacheDir: string;
  polyphonicDict: any[];
  [key: string]: any;
}

export const DEFAULT_SETTINGS: Settings = {
  region: 'eastasia',
  endpoint: '',
  activeChannel: '',
  localTts: DEFAULT_LOCAL_TTS,
  defaultVoice: 'zh-CN-XiaoxiaoNeural',
  defaultStyle: '',
  defaultStyledegree: '1.0',
  defaultRole: '',
  defaultVolume: '100%',
  defaultRate: '0%',
  defaultPitch: '0%',
  overwriteMode: 'skip',
  rememberKey: true,
  voices: [],
  favoriteVoices: [],
  cacheDir: '',
  polyphonicDict: []
};

const SETTINGS_FILE = 'settings.json';
const POLYPHONIC_USER_DICT_FILE = 'polyphonic-user-dict.json';

export class SettingsStore {
  private sessionAzureKey: string = '';

  private async getFileContent(fileName: string): Promise<string | null> {
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

  private async saveFileContent(fileName: string, content: string): Promise<void> {
    const dataFolder = await fs.getDataFolder();
    const entry = await dataFolder.createEntry(fileName, { overwrite: true });
    // @ts-ignore
    await entry.write(content, { format: storage.formats.utf8 });
  }

  private ensureDefaults(settings: Partial<Settings>): Settings {
    const merged = { ...DEFAULT_SETTINGS, ...settings } as Settings;

    // 迁移：老配置中 azureKeyDisabled === true 且未显式指定 activeChannel 时，迁移为 'cloud'
    if (!merged.activeChannel && (settings as any)?.azureKeyDisabled === true) {
      merged.activeChannel = 'cloud';
    }
    delete (merged as any).azureKeyDisabled;

    // 补全 localTts 缺省字段
    const rawLocal = (settings as any)?.localTts || {};
    merged.localTts = {
      serviceType: rawLocal.serviceType || 'gpt-sovits',
      // 缺省为 'managed'（插件托管），与 DR 版习惯一致：仅显式 'url' 才视为连接已有服务
      mode: rawLocal.mode === 'url' ? 'url' : 'managed',
      engine: {
        rootDir: rawLocal.engine?.rootDir || '',
        port: Number(rawLocal.engine?.port) || 9880,
        pythonPath: rawLocal.engine?.pythonPath || '',
        script: rawLocal.engine?.script || 'api_v2.py'
      },
      baseUrl: rawLocal.baseUrl || 'http://127.0.0.1:9880',
      textLang: rawLocal.textLang || 'auto',
      voices: Array.isArray(rawLocal.voices) ? rawLocal.voices : []
    };
    if (rawLocal.lastVoice) {
      merged.localTts.lastVoice = rawLocal.lastVoice;
    }

    // 迁移：早期 PR 版默认音色曾为「小艺」(zh-CN-XiaoyiNeural)，统一改为「晓晓」(zh-CN-XiaoxiaoNeural)，
    // 与达芬奇版默认音色保持一致。宽松匹配以兼容大小写差异。
    if (typeof merged.defaultVoice === 'string' && merged.defaultVoice.toLowerCase().includes('xiaoyi')) {
      merged.defaultVoice = 'zh-CN-XiaoxiaoNeural';
    }
    return merged;
  }

  public async load(): Promise<Settings> {
    let settings: Partial<Settings> = {};
    const rawSettings = await this.getFileContent(SETTINGS_FILE);
    if (rawSettings) {
      try {
        settings = JSON.parse(rawSettings);
      } catch (e) {
        // settings.json 存在但解析失败（可能因并发写入竞态导致文件被截断）。
        // 不能静默吞掉——否则后续 save 会用 DEFAULT_SETTINGS 覆盖文件，丢失 voices。
        console.warn("[Momo] settings.json 解析失败，将回退到默认设置（原文件内容不会被立即覆盖）:", e);
      }
    }

    // 读入用户自定义多音字词典
    const rawPoly = await this.getFileContent(POLYPHONIC_USER_DICT_FILE);
    if (rawPoly) {
      try {
        const parsed = JSON.parse(rawPoly);
        if (Array.isArray(parsed)) {
          settings.polyphonicDict = parsed;
        }
      } catch (e) {
        console.warn("[Momo] polyphonic-user-dict.json 解析失败:", e);
      }
    }

    const merged = this.ensureDefaults(settings);
    // 从已载入的数据中恢复 session key（如果用户选择了“记住密钥”）
    if (merged.rememberKey && merged.azureKey) {
      this.sessionAzureKey = merged.azureKey;
    }
    return merged;
  }

  // 串行化所有 save 操作：用 promise chain 保证一次只有一个 save 在执行。
  // 避免并发 save 时「A 正在写入 → B 的 load() 读到截断/残缺内容 → JSON.parse 失败 →
  // B 用 DEFAULT_SETTINGS 覆盖文件」的竞态，该竞态会丢失 voices（key 因从 sessionAzureKey
  // 内存恢复而不受影响，这就是「key 没丢但音色丢了」的根因）。
  private saveChain: Promise<void> = Promise.resolve();

  public save(nextSettings: Partial<Settings>): Promise<Settings> {
    // 把每次 save 串到链上执行；即使某次失败，链本身也继续（.then 第二参数吞掉错误）
    const result = this.saveChain.then(() => this._save(nextSettings));
    this.saveChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private async _save(nextSettings: Partial<Settings>): Promise<Settings> {
    const previous = await this.load();
    const settings = this.ensureDefaults({ ...previous, ...nextSettings });

    // 处理 API key：
    //   - 只有当传入的是非空、非占位符字符串时，才更新 sessionAzureKey
    //   - 空字符串或占位符（'__SAVED_KEY_PLACEHOLDER__'）视为"用户未修改"，保留原 key
    if (typeof nextSettings.azureKey === 'string') {
      const trimmed = nextSettings.azureKey.trim();
      if (trimmed && trimmed !== '__SAVED_KEY_PLACEHOLDER__') {
        this.sessionAzureKey = trimmed;
      }
    }

    // 如果用户不想记住 Key，则将其从保存的文件中剔除
    if (settings.rememberKey) {
      settings.azureKey = this.sessionAzureKey;
    } else {
      delete settings.azureKey;
    }

    // 保存独立的多音字字典
    const polyDict = settings.polyphonicDict;
    if (polyDict && Array.isArray(polyDict)) {
      await this.saveFileContent(POLYPHONIC_USER_DICT_FILE, JSON.stringify(polyDict, null, 2));
    }

    // 保存主设置
    const fileSettings = { ...settings };
    delete (fileSettings as any).azureKeyDisabled;
    // 在返回前，为安全起见，从返回的数据结构里脱敏
    await this.saveFileContent(SETTINGS_FILE, JSON.stringify(fileSettings, null, 2));

    return this.redact(settings);
  }

  public async getAzureKey(): Promise<string> {
    if (this.sessionAzureKey) return this.sessionAzureKey;
    const settings = await this.load();
    if (settings.rememberKey && settings.azureKey) {
      this.sessionAzureKey = settings.azureKey;
      return this.sessionAzureKey;
    }
    return '';
  }

  public redact(settings: Settings): Settings {
    const redacted = { ...this.ensureDefaults(settings) };
    redacted.hasAzureKey = Boolean(this.sessionAzureKey || redacted.azureKey);
    redacted.canEncryptKey = false; // UXP 暂无 safeStorage
    delete redacted.azureKey;
    return redacted;
  }

  public async getRedacted(): Promise<Settings> {
    return this.redact(await this.load());
  }
}
