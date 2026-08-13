'use strict';

const path = require('path');
const fs = (() => {
  try { return require('fs/promises'); } catch (_) {
    const _fs = require('fs');
    const { promisify } = require('util');
    return {
      readFile: promisify(_fs.readFile),
      writeFile: promisify(_fs.writeFile),
      stat: promisify(_fs.stat),
    };
  }
})();
const { app, BrowserWindow, ipcMain, safeStorage, Menu, clipboard, dialog, shell } = require('electron');
const WorkflowIntegration = require('./WorkflowIntegration.node');
const { SettingsStore } = require('./lib/settings-store');
const { AzureTtsProvider } = require('./lib/azure-tts');
const { ResolveAdapter } = require('./lib/resolve-adapter');
const { CloudClient } = require('./lib/cloud-client');
const { CloudStore } = require('./lib/cloud-store');
const { CloudTtsProvider } = require('./lib/cloud-tts-provider');
const { DelegatingTtsProvider } = require('./lib/delegating-tts-provider');
const packageInfo = require('./package.json');

// 从 manifest.xml 读取插件 Id，保证与达芬奇握手时使用的 id 与 manifest 一致。
// dev 版安装脚本会把 manifest 的 Id 改为 com.momo.voicesub.dr.dev，
// 若此处仍硬编码正式版 id，会导致 WorkflowIntegration.Initialize 握手失败
// （报错 "Failed to initialize communication with host"）。
function readPluginIdFromManifest() {
  try {
    const manifestPath = path.join(__dirname, 'manifest.xml');
    const xml = require('fs').readFileSync(manifestPath, 'utf8');
    const match = xml.match(/<Id>\s*([^<\s]+)\s*<\/Id>/);
    if (match && match[1]) return match[1];
  } catch (e) {
    console.error('Failed to read plugin id from manifest.xml:', e);
  }
  return 'com.momo.voicesub.dr';
}
const PLUGIN_ID = readPluginIdFromManifest();
const LOGO_PATH = path.join(__dirname, 'momovoicesub-logo.png');

// 根据 manifest Id 自动切换环境：dev 版（Id 以 .dev 结尾）连本地，正式版连生产域名。
// dr-install.ps1 安装 dev 版时会改写 manifest 的 Id 为 com.momo.voicesub.dr.dev，
// 源码保持正式版不变，此处根据 Id 自动判断。
const IS_DEV = PLUGIN_ID.endsWith('.dev');
const API_BASE_URL = IS_DEV ? 'http://localhost:3000' : 'https://momovoicesub.sxrec.com';
const WEB_BASE_URL = IS_DEV ? 'http://localhost:3001' : 'https://momovoicesub.sxrec.com';
console.log(`[Env] 运行环境: ${IS_DEV ? 'DEV (本地)' : 'PROD (生产)'}, API=${API_BASE_URL}, WEB=${WEB_BASE_URL}`);

// 达芬奇内置 Electron 的 Node.js 版本检测。
// fs/promises 与可选链等语法需要 Node 14+。低于此版本时向用户给出升级提示。
const NODE_MAJOR = Number(process.versions.node.split('.')[0]) || 0;
const NODE_TOO_OLD = NODE_MAJOR < 14;

function getNodeWarning() {
  if (!NODE_TOO_OLD) return null;
  return {
    title: '检测到达芬奇版本过旧',
    message: `当前达芬奇内置的 Node.js 版本为 v${process.versions.node}，本插件至少需要 v14 以上版本。`,
    suggestion: '请升级达芬奇到较新版本后重试。'
  };
}

let mainWindow = null;
let resolveObj = null;
let projectManagerObj = null;
let settingsStore = null;
let ttsProvider = null;
let resolveAdapter = null;
let cloudClient = null;
let cloudStore = null;
let cloudTtsProvider = null;

function sendLog(message, detail = '', level = 'info') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:log', {
      time: new Date().toISOString(),
      level,
      message: String(message),
      detail: detail ? String(detail) : ''
    });
  }
}

function summarizePayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const copy = JSON.parse(JSON.stringify(payload));
  if (copy.azureKey) copy.azureKey = '[redacted]';
  if (copy.settings?.azureKey) copy.settings.azureKey = '[redacted]';
  // 精简日志中过长的数组字段，避免多音字字典/字幕列表刷屏（仅影响日志摘要，不影响实际 payload）
  truncateForLog(copy);
  return JSON.stringify(copy);
}

/**
 * 递归遍历对象，将过长的数组字段替换为 "[N items]" 占位符。
 * 仅针对已知的大体积字段（polyphonicDict / subtitleItems / voices / annotations），
 * 其他小数组保留原样，确保日志仍可读且不丢关键信息。
 */
function truncateForLog(obj) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (item && typeof item === 'object') truncateForLog(item);
    }
    return;
  }
  const KEYS_TO_TRUNCATE = new Set(['polyphonicDict', 'subtitleItems', 'voices', 'builtinPolyDict']);
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (Array.isArray(val) && KEYS_TO_TRUNCATE.has(key) && val.length > 0) {
      obj[key] = `[${val.length} items]`;
    } else if (val && typeof val === 'object') {
      truncateForLog(val);
    }
  }
}

function registerLoggedHandler(channel, handler) {
  ipcMain.handle(channel, async (event, payload) => {
    const summary = summarizePayload(payload);
    sendLog(`IPC ${channel} 开始`, summary);
    try {
      const result = await handler(event, payload);
      sendLog(`IPC ${channel} 完成`);
      return result;
    } catch (error) {
      sendLog(`IPC ${channel} 失败`, error && error.stack ? error.stack : error, 'error');
      throw error;
    }
  });
}

async function initResolveInterface() {
  if (resolveObj) return resolveObj;

  const initialized = await WorkflowIntegration.Initialize(PLUGIN_ID);
  if (!initialized) {
    throw new Error('Failed to initialize Resolve Workflow Integration');
  }

  resolveObj = await WorkflowIntegration.GetResolve();
  if (!resolveObj) {
    throw new Error('Failed to get Resolve object');
  }

  return resolveObj;
}

async function getResolve() {
  return initResolveInterface();
}

async function getProjectManager() {
  if (!projectManagerObj) {
    const resolve = await getResolve();
    projectManagerObj = await resolve.GetProjectManager();
  }
  return projectManagerObj;
}

async function cleanupResolveInterface() {
  try {
    WorkflowIntegration.CleanUp();
  } finally {
    resolveObj = null;
    projectManagerObj = null;
  }
  return true;
}

function initServices() {
  const appDataDir = path.join(app.getPath('appData'), 'momovoicesub');
  settingsStore = new SettingsStore({ appDataDir, safeStorage });

  const azureProvider = new AzureTtsProvider({
    getSettings: () => settingsStore.load(),
    getAzureKey: () => settingsStore.getAzureKey(),
    fetchImpl: globalThis.fetch
  });

  cloudClient = new CloudClient({ baseUrl: API_BASE_URL, fetchImpl: globalThis.fetch });
  cloudStore = new CloudStore({ appDataDir, safeStorage });
  cloudTtsProvider = new CloudTtsProvider({
    cloudClient,
    cloudStore,
    cacheDir: path.join(appDataDir, 'cache')
  });

  // 委托 provider：有自填 key 走 AzureTtsProvider，否则登录了云端走 CloudTtsProvider
  // isAzureKeyDisabled：用户在自填 Key 页勾选"临时禁用"时，强制走云端通道（即便 Key 有效也不用）
  ttsProvider = new DelegatingTtsProvider({
    azureProvider,
    cloudProvider: cloudTtsProvider,
    cloudStore,
    getAzureKey: () => settingsStore.getAzureKey(),
    isAzureKeyDisabled: () => settingsStore.loadSync().azureKeyDisabled === true
  });

  resolveAdapter = new ResolveAdapter({
    getResolve,
    ttsProvider,
    settingsStore,
    appDataDir
  });
}

function normalizeVoiceSettings(input = {}) {
  const result = {
    voice: input.voice || undefined,
    style: input.style || undefined,
    styledegree: input.styledegree || undefined,
    role: input.role || undefined,
    rate: input.rate || '0%',
    pitch: input.pitch || '0%',
    volume: input.volume || '100%'
  };
  if (input.annotations) result.annotations = input.annotations;
  if (input.polyphonicDict) result.polyphonicDict = input.polyphonicDict;
  if (input.enablePolyphonic !== undefined) result.enablePolyphonic = input.enablePolyphonic;
  return result;
}

function registerIpcHandlers() {
  registerLoggedHandler('app:getState', async () => {
    const settings = await settingsStore.getRedacted();
    const resolveState = await resolveAdapter.getSummary();
    return {
      settings,
      resolve: resolveState,
      version: packageInfo.version,
      nodeWarning: getNodeWarning()
    };
  });

  registerLoggedHandler('settings:load', async () => settingsStore.getRedacted());

  registerLoggedHandler('settings:save', async (_event, settings) => {
    const saved = await settingsStore.save(settings || {});
    sendLog('设置已保存');
    return saved;
  });

  // 内置多音字字典（只读），从打包内的 polyphonic-builtin.json 读取
  // require 会缓存 JSON 模块，仅读取一次后常驻内存，适合静态字典
  registerLoggedHandler('poly:loadBuiltin', async () => {
    return require('./lib/polyphonic-builtin.json');
  });

  registerLoggedHandler('tts:listVoices', async (_event, settingsOverride) => {
    const voices = await ttsProvider.listVoices(settingsOverride || {});
    await settingsStore.save({ voices });
    sendLog(`已刷新 ${voices.length} 个 Azure 音色`);
    return voices;
  });

  registerLoggedHandler('tts:testConnection', async (_event, settingsOverride) => {
    const voices = await ttsProvider.listVoices(settingsOverride || {});
    return {
      ok: true,
      count: voices.length,
      sample: voices.slice(0, 5)
    };
  });

  registerLoggedHandler('tts:previewVoice', async (_event, shortName) => {
    if (!shortName) throw new Error('shortName is required');

    const settings = await settingsStore.load();
    const voice = (settings.voices || []).find((v) => v.shortName === shortName);
    const cacheDir = settings.cacheDir || path.join(app.getPath('appData'), 'momovoicesub', 'cache');

    const result = await ttsProvider.synthesizePreview({
      shortName,
      localName: voice?.localName,
      displayName: voice?.displayName,
      locale: voice?.locale,
      previewDir: cacheDir
    });

    const base64 = result.wavBuffer.toString('base64');
    return `data:audio/wav;base64,${base64}`;
  });

  registerLoggedHandler('settings:toggleFavorite', async (_event, shortName) => {
    if (!shortName) throw new Error('shortName is required');
    const settings = await settingsStore.load();
    const favorites = [...(settings.favoriteVoices || [])];
    const idx = favorites.indexOf(shortName);
    if (idx >= 0) {
      favorites.splice(idx, 1);
    } else {
      favorites.push(shortName);
    }
    await settingsStore.save({ favoriteVoices: favorites });
    return favorites;
  });

  // ═══ Cloud 账号相关 IPC ═══

  registerLoggedHandler('cloud:login', async (_event, { email, password }) => {
    if (!email || !password) throw new Error('邮箱和密码不能为空');
    const result = await cloudClient.login(email, password);
    // 从 token 里解出 email（login 返回不含 email，用 JWT payload）
    let userEmail = email;
    try {
      const payload = JSON.parse(Buffer.from(result.access_token.split('.')[1], 'base64').toString('utf8'));
      userEmail = payload.email || email;
    } catch {}

    await cloudStore.saveToken({
      access_token: result.access_token,
      refresh_token: result.refresh_token,
      email: userEmail,
      is_admin: result.is_admin,
      nickname: result.nickname,
    });
    sendLog(`云端登录成功：${userEmail}${result.is_admin ? ' (管理员)' : ''}`);

    // 登录成功后强制注册设备（设备数/跨账号数超限时阻断登录，防止批量换号白嫖）
    try {
      const deviceFp = await cloudStore.getDeviceFp();
      await cloudClient.registerDevice(result.access_token, deviceFp);
      sendLog(`设备已自动注册：${deviceFp.slice(0, 16)}...`);
    } catch (err) {
      // 设备限制类错误 → 清除已保存的 token，拒绝登录
      if (err.code === 'DEVICE_LIMIT' || err.status === 403) {
        await cloudStore.clearToken();
        sendLog(`登录被拒绝（设备限制）：${err.message || err}`, '', 'error');
        throw new Error('此设备已登录过多账号，白嫖不要太狠啦，行行好');
      }
      // 其他错误（网络抖动、服务端 500 等）→ 不影响登录，降级处理
      sendLog(`设备自动注册失败（不影响登录）：${err.message || err}`, '', 'error');
    }

    return {
      ok: true,
      email: userEmail,
      is_admin: result.is_admin,
      nickname: result.nickname,
    };
  });

  registerLoggedHandler('cloud:logout', async () => {
    await cloudStore.clearToken();
    // 退出登录时同步清空云端拉取的音色列表，避免退出后音色仍在但配音不可用
    await settingsStore.save({ voices: [] });
    sendLog('已退出云端登录（音色列表已清空）');
    return { ok: true };
  });

  registerLoggedHandler('cloud:registerDevice', async () => {
    const tokenData = await cloudStore.loadToken();
    if (!tokenData?.access_token) {
      throw new Error('未登录云端账号');
    }
    const deviceFp = await cloudStore.getDeviceFp();
    await cloudClient.registerDevice(tokenData.access_token, deviceFp);
    sendLog(`设备已注册：${deviceFp.slice(0, 16)}...`);
    return { ok: true, device_fp: deviceFp };
  });

  registerLoggedHandler('cloud:getState', async () => {
    const tokenData = await cloudStore.loadToken();
    if (!tokenData?.access_token) {
      return { isLoggedIn: false };
    }
    return {
      isLoggedIn: true,
      email: tokenData.email || '',
      is_admin: tokenData.is_admin || false,
      nickname: tokenData.nickname || '',
    };
  });

  // ═══ Cloud token 自动刷新 ═══
  // access_token 过期时（API 返回 401），用 refresh_token 刷新新 token 并重试一次。
  // 刷新失败（refresh_token 也过期）才清除登录状态，避免频繁被登出。

  let _refreshingPromise = null;

  async function ensureValidToken() {
    const tokenData = await cloudStore.loadToken();
    if (!tokenData?.access_token) {
      return { token: null, tokenData: null, refreshed: false };
    }
    return { token: tokenData.access_token, tokenData, refreshed: false };
  }

  /**
   * 用 refresh_token 刷新 access_token，写入存储并返回新 token。
   * 并发调用时复用同一个 Promise（避免多条字幕同时 401 时重复刷新）。
   */
  async function doRefreshToken(tokenData) {
    if (!tokenData?.refresh_token) {
      throw Object.assign(new Error('NO_REFRESH_TOKEN'), { code: 'NO_REFRESH_TOKEN' });
    }
    if (_refreshingPromise) return _refreshingPromise;

    _refreshingPromise = (async () => {
      const refreshed = await cloudClient.refreshToken(tokenData.refresh_token);
      await cloudStore.saveToken({
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        email: tokenData.email || '',
        is_admin: refreshed.is_admin || tokenData.is_admin || false,
        nickname: tokenData.nickname || '',
      });
      sendLog('云端 token 已自动刷新');
      return refreshed.access_token;
    })().finally(() => { _refreshingPromise = null; });

    return _refreshingPromise;
  }

  registerLoggedHandler('cloud:getQuota', async () => {
    let tokenData = await cloudStore.loadToken();
    if (!tokenData?.access_token) {
      return { isLoggedIn: false };
    }
    try {
      const quota = await cloudClient.getQuota(tokenData.access_token);
      return { isLoggedIn: true, quota };
    } catch (err) {
      if (err.code === 'TOKEN_EXPIRED') {
        // access_token 过期，尝试用 refresh_token 刷新
        try {
          const newToken = await doRefreshToken(tokenData);
          const quota = await cloudClient.getQuota(newToken);
          return { isLoggedIn: true, quota };
        } catch (refreshErr) {
          // refresh_token 也失效了，才真正清除登录
          await cloudStore.clearToken();
          return { isLoggedIn: false, error: 'TOKEN_EXPIRED' };
        }
      }
      throw err;
    }
  });

  registerLoggedHandler('cloud:refreshVoices', async () => {
    let tokenData = await cloudStore.loadToken();
    if (!tokenData?.access_token) {
      // 未登录 → 公开音色列表接口（manifest-only，不需要 JWT）
      const voices = await cloudClient.listVoicesPublic();
      await settingsStore.save({ voices });
      sendLog(`已从公开接口刷新 ${voices.length} 个音色（未登录）`);
      return voices;
    }
    try {
      const voices = await cloudClient.listVoices(tokenData.access_token);
      await settingsStore.save({ voices });
      sendLog(`已从云端刷新 ${voices.length} 个音色`);
      return voices;
    } catch (err) {
      if (err.code === 'TOKEN_EXPIRED') {
        const newToken = await doRefreshToken(tokenData);
        const voices = await cloudClient.listVoices(newToken);
        await settingsStore.save({ voices });
        sendLog(`已从云端刷新 ${voices.length} 个音色`);
        return voices;
      }
      throw err;
    }
  });

  registerLoggedHandler('resolve:getSummary', async () => resolveAdapter.getSummary());
  registerLoggedHandler('resolve:listSubtitleTracks', async () => resolveAdapter.listSubtitleTracks());
  registerLoggedHandler('resolve:listAudioTracks', async () => resolveAdapter.listAudioTracks());
  registerLoggedHandler('resolve:getSubtitleItems', async (_event, trackIndex) => {
    return resolveAdapter.getSubtitleItems(trackIndex);
  });

  registerLoggedHandler('resolve:importSrt', async () => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const result = await dialog.showOpenDialog(win, {
      title: '选择 SRT 字幕文件',
      filters: [{ name: 'SRT 字幕', extensions: ['srt'] }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) {
      return null;
    }
    const filePath = result.filePaths[0];
    const content = await fs.readFile(filePath, 'utf8');
    const { project } = await resolveAdapter.getProjectContext();
    const fps = await resolveAdapter.getTimelineFps(project);
    const items = resolveAdapter.parseSrt(content, fps);
    if (!items || !items.length) {
      throw new Error('SRT 文件解析失败，未识别到有效字幕条目。请检查文件格式。');
    }
    sendLog(`SRT 导入成功：${path.basename(filePath)}，共 ${items.length} 条字幕（fps=${fps}）`);
    return { items, fileName: path.basename(filePath) };
  });

  registerLoggedHandler('job:generateFromSubtitles', async (_event, payload) => {
    sendLog('开始字幕批量配音');
    const voiceSettings = normalizeVoiceSettings(payload.voiceSettings);
    if (payload.voiceSettings?.polyphonicDict) voiceSettings.polyphonicDict = payload.voiceSettings.polyphonicDict;
    if (payload.voiceSettings?.enablePolyphonic !== undefined) voiceSettings.enablePolyphonic = payload.voiceSettings.enablePolyphonic;
    const result = await resolveAdapter.generateFromSubtitleTrack({
      subtitleTrackIndex: payload.subtitleTrackIndex != null ? Number(payload.subtitleTrackIndex) : undefined,
      audioTrackIndex: payload.audioTrackIndex || 'auto',
      voiceSettings,
      overwriteMode: payload.overwriteMode || 'skip',
      subtitleItems: payload.subtitleItems
    });
    sendLog(`字幕配音完成：插入 ${result.inserted}，跳过 ${result.skipped}`);
    return result;
  });

  registerLoggedHandler('job:insertManual', async (_event, payload) => {
    sendLog('开始生成手动配音');
    const voiceSettings = normalizeVoiceSettings(payload.voiceSettings);
    if (payload.voiceSettings?.annotations) voiceSettings.annotations = payload.voiceSettings.annotations;
    if (payload.voiceSettings?.polyphonicDict) voiceSettings.polyphonicDict = payload.voiceSettings.polyphonicDict;
    if (payload.voiceSettings?.enablePolyphonic !== undefined) voiceSettings.enablePolyphonic = payload.voiceSettings.enablePolyphonic;
    const result = await resolveAdapter.insertTextAtPlayhead({
      text: payload.text,
      audioTrackIndex: payload.audioTrackIndex || 'auto',
      voiceSettings,
      overwriteMode: payload.overwriteMode || 'allowDuplicate'
    });
    sendLog(`手动配音已插入到帧 ${result.recordFrame}`);
    return result;
  });

  registerLoggedHandler('cache:deleteUnusedCurrentProject', async () => {
    const result = await resolveAdapter.deleteUnusedCurrentProjectCache();
    sendLog(`已删除当前项目未使用缓存 ${result.deleted} 个，保留 ${result.kept} 个`);
    return result;
  });

  registerLoggedHandler('cache:deleteCurrentProject', async () => {
    const result = await resolveAdapter.deleteCurrentProjectCache();
    sendLog(`已删除当前项目缓存 ${result.deleted} 个`);
    return result;
  });

  registerLoggedHandler('cache:deleteAllProjects', async () => {
    const result = await resolveAdapter.deleteAllProjectCache();
    sendLog(`已删除所有项目缓存 ${result.deleted} 个`);
    return result;
  });

  registerLoggedHandler('cache:openFolder', async () => {
    const settings = await settingsStore.load();
    const cacheDir = settings.cacheDir || path.join(app.getPath('appData'), 'momovoicesub', 'cache');
    // 确保目录存在（fs/promises 有 mkdir，fallback 版可能没有）
    if (typeof fs.mkdir === 'function') {
      try { await fs.mkdir(cacheDir, { recursive: true }); } catch (_) {}
    }
    const errMsg = await shell.openPath(cacheDir);
    if (errMsg) {
      throw new Error(`无法打开缓存目录: ${errMsg}`);
    }
    return { ok: true, cacheDir };
  });

  registerLoggedHandler('debug:openDevTools', async () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
      return true;
    }
    return false;
  });

  registerLoggedHandler('debug:copyLog', async (_event, logText) => {
    clipboard.writeText(String(logText || ''));
    return true;
  });

  registerLoggedHandler('debug:exportLog', async (_event, logText) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { canceled: true };

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出运行日志',
      defaultPath: `momovoicesub-${timestamp}.log`,
      filters: [
        { name: 'Log 文件', extensions: ['log'] },
        { name: '文本文件', extensions: ['txt'] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    await fs.writeFile(result.filePath, String(logText || ''), 'utf8');
    return { canceled: false, filePath: result.filePath };
  });

  registerLoggedHandler('app:confirm', async (_event, options = {}) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '默默配音助手',
      message: options.message || '确定执行这个操作吗？',
      detail: options.detail || '',
      buttons: ['取消', '确定'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    return result.response === 1;
  });

  registerLoggedHandler('resolve:cleanupResolveInterface', cleanupResolveInterface);

  registerLoggedHandler('app:openExternal', async (_event, url) => {
    if (url) {
      await shell.openExternal(url);
      return true;
    }
    return false;
  });
}

function isAllowedShortcut(input) {
  const key = String(input.key || '').toLowerCase();
  const hasModifier = input.control || input.meta || input.alt;
  const editKeys = new Set(['z', 'y', 'x', 'c', 'v', 'a']);
  if ((input.control || input.meta) && !input.alt && editKeys.has(key)) return true;
  return !hasModifier && !/^f\d{1,2}$/i.test(input.key || '');
}

function registerShortcutGate(window) {
  window.webContents.on('before-input-event', (event, input) => {
    if (!isAllowedShortcut(input)) {
      event.preventDefault();
    }
  });
}

function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 960,
    minHeight: 600,
    resizable: true,
    maximizable: true,
    useContentSize: true,
    title: '默默配音助手',
    icon: LOGO_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // 通过 additionalArguments 把环境信息传给 preload，避免 preload 中 require('fs') 在 sandbox 模式下失败
      additionalArguments: [`--momo-env=${IS_DEV ? 'dev' : 'prod'}`]
    }
  });

  mainWindow.on('close', () => {
    app.quit();
  });

  mainWindow.setMenu(null);
  registerShortcutGate(mainWindow);
  mainWindow.loadFile('index.html');
}

process.on('uncaughtException', (error) => {
  sendLog('uncaughtException', error && error.stack ? error.stack : error, 'error');
});

process.on('unhandledRejection', (reason) => {
  sendLog('unhandledRejection', reason && reason.stack ? reason.stack : reason, 'error');
});

app.whenReady().then(() => {
  initServices();
  registerIpcHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  cleanupResolveInterface().catch(() => {});
});
