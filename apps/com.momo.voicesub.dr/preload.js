'use strict';

const { contextBridge, ipcRenderer } = require('electron/renderer');

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
