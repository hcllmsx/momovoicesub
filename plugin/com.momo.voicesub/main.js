'use strict';

const path = require('path');
const fs = require('fs/promises');
const { app, BrowserWindow, ipcMain, safeStorage, Menu, clipboard, dialog, shell } = require('electron');
const WorkflowIntegration = require('./WorkflowIntegration.node');
const { SettingsStore } = require('./lib/settings-store');
const { AzureTtsProvider } = require('./lib/azure-tts');
const { ResolveAdapter } = require('./lib/resolve-adapter');
const packageInfo = require('./package.json');

const PLUGIN_ID = 'com.momo.voicesub';
const LOGO_PATH = path.join(__dirname, 'momovoicesub-logo.png');

let mainWindow = null;
let resolveObj = null;
let projectManagerObj = null;
let settingsStore = null;
let ttsProvider = null;
let resolveAdapter = null;

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
  return JSON.stringify(copy);
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
  ttsProvider = new AzureTtsProvider({
    getSettings: () => settingsStore.load(),
    getAzureKey: () => settingsStore.getAzureKey(),
    fetchImpl: globalThis.fetch
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
    return { settings, resolve: resolveState, version: packageInfo.version };
  });

  registerLoggedHandler('settings:load', async () => settingsStore.getRedacted());

  registerLoggedHandler('settings:save', async (_event, settings) => {
    const saved = await settingsStore.save(settings || {});
    sendLog('设置已保存');
    return saved;
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

  registerLoggedHandler('resolve:getSummary', async () => resolveAdapter.getSummary());
  registerLoggedHandler('resolve:listSubtitleTracks', async () => resolveAdapter.listSubtitleTracks());
  registerLoggedHandler('resolve:listAudioTracks', async () => resolveAdapter.listAudioTracks());
  registerLoggedHandler('resolve:getSubtitleItems', async (_event, trackIndex) => {
    return resolveAdapter.getSubtitleItems(trackIndex);
  });

  registerLoggedHandler('job:generateFromSubtitles', async (_event, payload) => {
    sendLog('开始字幕批量配音');
    const voiceSettings = normalizeVoiceSettings(payload.voiceSettings);
    if (payload.voiceSettings?.polyphonicDict) voiceSettings.polyphonicDict = payload.voiceSettings.polyphonicDict;
    if (payload.voiceSettings?.enablePolyphonic !== undefined) voiceSettings.enablePolyphonic = payload.voiceSettings.enablePolyphonic;
    const result = await resolveAdapter.generateFromSubtitleTrack({
      subtitleTrackIndex: Number(payload.subtitleTrackIndex),
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
    const key = String(input.key || '').toLowerCase();
    if ((input.control || input.meta) && key === 'f9') {
      event.preventDefault();
      window.webContents.send('app:toggleLog');
      return;
    }

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
      preload: path.join(__dirname, 'preload.js')
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
