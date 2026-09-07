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
const apiBaseUrl = isDev ? 'http://localhost:3000' : 'https://momovoicesub.sxrec.com';

// 主进程在低版本等致命场景下通过 additionalArguments 注入 --momo-fatal=<reason>[:<detail>]
// renderer 检测到此字段后直接显示阻断覆盖层，不调用任何业务 IPC
const fatalArg = (typeof process !== 'undefined' && Array.isArray(process.argv))
  ? process.argv.find((a) => typeof a === 'string' && a.startsWith('--momo-fatal='))
  : undefined;
let fatalError = null;
if (fatalArg) {
  const raw = fatalArg.slice('--momo-fatal='.length);
  const sepIdx = raw.indexOf(':');
  const reason = sepIdx >= 0 ? raw.slice(0, sepIdx) : raw;
  const detail = sepIdx >= 0 ? raw.slice(sepIdx + 1) : '';
  if (reason === 'node-too-old') {
    fatalError = {
      reason: 'node-too-old',
      nodeVersion: detail,
      title: '不支持当前达芬奇版本',
      message: `检测到当前达芬奇内置的 Node.js 版本过旧（v${detail}），无法运行本插件。`,
      suggestion: '请升级达芬奇到较新版本（建议 19 及以上）后重新打开插件。'
    };
  } else {
    fatalError = { reason: reason || 'unknown', title: '插件无法启动', message: '发生了未知错误，请联系开发者。', suggestion: '' };
  }
}

contextBridge.exposeInMainWorld('momoVoiceSub', {
  getState: () => ipcRenderer.invoke('app:getState'),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  loadBuiltinPoly: () => ipcRenderer.invoke('poly:loadBuiltin'),
  exportPolyDict: (entries) => ipcRenderer.invoke('poly:exportDict', entries),
  importPolyDict: () => ipcRenderer.invoke('poly:importDict'),
  toggleFavorite: (shortName) => ipcRenderer.invoke('settings:toggleFavorite', shortName),
  listVoices: (settings) => ipcRenderer.invoke('tts:listVoices', settings),
  testConnection: (settings) => ipcRenderer.invoke('tts:testConnection', settings),
  previewVoice: (shortName) => ipcRenderer.invoke('tts:previewVoice', shortName),
  localTestConnection: () => ipcRenderer.invoke('local:testConnection'),
  // GPT-SoVITS 整合包引擎（托管模式）
  engineDetect: (payload) => ipcRenderer.invoke('engine:detect', payload),
  engineScanModels: (payload) => ipcRenderer.invoke('engine:scanModels', payload),
  engineScanRefAudios: (payload) => ipcRenderer.invoke('engine:scanRefAudios', payload),
  engineLookupPromptText: (payload) => ipcRenderer.invoke('engine:lookupPromptText', payload),
  engineBrowseFolder: () => ipcRenderer.invoke('engine:browseFolder'),
  engineBrowseAudio: (payload) => ipcRenderer.invoke('engine:browseAudio', payload),
  engineArchiveRefAudio: (payload) => ipcRenderer.invoke('engine:archiveRefAudio', payload),
  engineReadAudioDuration: (payload) => ipcRenderer.invoke('engine:readAudioDuration', payload),
  exportLocalVoices: (payload) => ipcRenderer.invoke('voice:exportVoices', payload),
  importLocalVoices: () => ipcRenderer.invoke('voice:importVoices'),
  saveRefAudios: (payload) => ipcRenderer.invoke('voice:saveRefAudios', payload),
  engineStart: (payload) => ipcRenderer.invoke('engine:start', payload),
  engineWaitReady: (payload) => ipcRenderer.invoke('engine:waitReady', payload),
  engineStop: () => ipcRenderer.invoke('engine:stop'),
  engineStatus: () => ipcRenderer.invoke('engine:status'),
  engineClearLogs: () => ipcRenderer.invoke('engine:clearLogs'),
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
  // 退出插件（低版本达芬奇阻断提示后调用）
  quitApp: () => ipcRenderer.invoke('app:quit'),
  // 环境信息（供 renderer 构造网页 URL，如登录页/定价页，以及 API 请求）
  webBaseUrl: webBaseUrl,
  apiBaseUrl: apiBaseUrl,
  isDev: isDev,
  // 致命错误（低版本达芬奇等），renderer 检测到后直接显示阻断层
  fatalError: fatalError,
  // Cloud 账号
  cloudLogin: (email, password) => ipcRenderer.invoke('cloud:login', { email, password }),
  cloudLogout: () => ipcRenderer.invoke('cloud:logout'),
  cloudGetState: () => ipcRenderer.invoke('cloud:getState'),
  cloudGetQuota: () => ipcRenderer.invoke('cloud:getQuota'),
  cloudRefreshVoices: () => ipcRenderer.invoke('cloud:refreshVoices'),
  cloudRegisterDevice: () => ipcRenderer.invoke('cloud:registerDevice'),
  cloudSendHeartbeat: (payload) => ipcRenderer.invoke('cloud:sendHeartbeat', payload),
  onLog: (callback) => {
    ipcRenderer.on('app:log', (_event, payload) => callback(payload));
  },
  // GPT-SoVITS 引擎进程日志（托管模式实时输出）
  onEngineLog: (callback) => {
    ipcRenderer.on('engine:log', (_event, payload) => callback(payload));
  }
});
