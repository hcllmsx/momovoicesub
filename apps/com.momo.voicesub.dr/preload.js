'use strict';

const { contextBridge, ipcRenderer } = require('electron/renderer');

// 从 main.js 通过 additionalArguments 注入的环境信息中读取。
// 不能在 preload 中用 require('fs') / require('path')，因为 Electron 20+ 默认 sandbox 模式下这些 Node 内置模块不可用。
// main.js 在创建 BrowserWindow 时通过 additionalArguments 传入 --momo-env=dev|prod
const envArg = (typeof process !== 'undefined' && Array.isArray(process.argv))
  ? process.argv.find((a) => typeof a === 'string' && a.startsWith('--momo-env='))
  : undefined;
const isDev = envArg === '--momo-env=dev';
const webBaseUrl = isDev ? 'http://localhost:3001' : 'https://momovoicesub.sxrec.com';

contextBridge.exposeInMainWorld('momoVoiceSub', {
  getState: () => ipcRenderer.invoke('app:getState'),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  loadBuiltinPoly: () => ipcRenderer.invoke('poly:loadBuiltin'),
  toggleFavorite: (shortName) => ipcRenderer.invoke('settings:toggleFavorite', shortName),
  listVoices: (settings) => ipcRenderer.invoke('tts:listVoices', settings),
  testConnection: (settings) => ipcRenderer.invoke('tts:testConnection', settings),
  previewVoice: (shortName) => ipcRenderer.invoke('tts:previewVoice', shortName),
  getSubtitleItems: (trackIndex) => ipcRenderer.invoke('resolve:getSubtitleItems', trackIndex),
  importSrt: () => ipcRenderer.invoke('resolve:importSrt'),
  getSummary: () => ipcRenderer.invoke('resolve:getSummary'),
  listSubtitleTracks: () => ipcRenderer.invoke('resolve:listSubtitleTracks'),
  listAudioTracks: () => ipcRenderer.invoke('resolve:listAudioTracks'),
  generateFromSubtitles: (payload) => ipcRenderer.invoke('job:generateFromSubtitles', payload),
  insertManual: (payload) => ipcRenderer.invoke('job:insertManual', payload),
  deleteUnusedCurrentProjectCache: () => ipcRenderer.invoke('cache:deleteUnusedCurrentProject'),
  deleteCurrentProjectCache: () => ipcRenderer.invoke('cache:deleteCurrentProject'),
  deleteAllProjectCache: () => ipcRenderer.invoke('cache:deleteAllProjects'),
  openCacheFolder: () => ipcRenderer.invoke('cache:openFolder'),
  openDevTools: () => ipcRenderer.invoke('debug:openDevTools'),
  copyLog: (logText) => ipcRenderer.invoke('debug:copyLog', logText),
  exportLog: (logText) => ipcRenderer.invoke('debug:exportLog', logText),
  confirm: (options) => ipcRenderer.invoke('app:confirm', options),
  cleanupResolveInterface: () => ipcRenderer.invoke('resolve:cleanupResolveInterface'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  // 环境信息（供 renderer 构造网页 URL，如登录页/定价页）
  webBaseUrl: webBaseUrl,
  isDev: isDev,
  // Cloud 账号
  cloudLogin: (email, password) => ipcRenderer.invoke('cloud:login', { email, password }),
  cloudLogout: () => ipcRenderer.invoke('cloud:logout'),
  cloudGetState: () => ipcRenderer.invoke('cloud:getState'),
  cloudGetQuota: () => ipcRenderer.invoke('cloud:getQuota'),
  cloudRefreshVoices: () => ipcRenderer.invoke('cloud:refreshVoices'),
  cloudRegisterDevice: () => ipcRenderer.invoke('cloud:registerDevice'),
  onLog: (callback) => {
    ipcRenderer.on('app:log', (_event, payload) => callback(payload));
  }
});
