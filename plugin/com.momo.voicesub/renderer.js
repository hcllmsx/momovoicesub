'use strict';

const state = {
  settings: null,
  voices: [],
  subtitleTracks: [],
  audioTracks: [],
  settingsBaseline: null,
  busy: false,
  refreshHintTimer: null,
  scrollbarTimer: null
};

const $ = (id) => document.getElementById(id);

function setResult(id, message, kind = '') {
  const el = $(id);
  el.textContent = message;
  el.className = `result ${kind}`.trim();
}

function friendlyErrorMessage(error) {
  let message = typeof error === 'string' ? error : (error && error.message) || '操作失败。';
  message = message.replace(/^Error invoking remote method '[^']+': Error:\s*/i, '');

  if (/No current timeline/i.test(message)) {
    return '当前项目没有选中的时间线。请先创建并打开一条时间线。';
  }
  if (/No current Resolve project/i.test(message)) {
    return '当前没有打开项目。请先打开或创建一个项目。';
  }
  if (/GetCurrentTimecode|Not supported on current page/i.test(message)) {
    return '当前页面不能读取播放头位置。请切换到“快编”或“剪辑”页面后再插入配音。';
  }
  if (/Failed to import audio/i.test(message)) {
    return message.replace(/Failed to import audio:/i, '导入音频失败：');
  }
  if (/Failed to append audio to timeline/i.test(message)) {
    return '音频已生成，但插入时间线失败。请检查目标音频轨是否锁定或不可用。';
  }
  if (/Azure Speech key is required/i.test(message)) {
    return '请先在设置中填写 Azure Speech Key。';
  }
  if (/Azure region or endpoint is required/i.test(message)) {
    return '请先在设置中填写 Azure 区域或 Endpoint。';
  }

  return message;
}

function log(message) {
  const output = $('logOutput');
  const line = typeof message === 'object'
    ? `[${message.time || new Date().toISOString()}] [${message.level || 'info'}] ${message.message}${message.detail ? `\n${message.detail}` : ''}`
    : `[${new Date().toISOString()}] [renderer] ${message}`;
  output.textContent = output.textContent ? `${output.textContent}\n${line}` : line;
  output.scrollTop = output.scrollHeight;
}

function toggleLogPanel() {
  document.querySelector('.log-panel').classList.toggle('visible');
}

function showScrollbarsTemporarily() {
  if (document.documentElement.scrollHeight <= document.documentElement.clientHeight) return;
  document.documentElement.classList.add('scrollbars-visible');
  clearTimeout(state.scrollbarTimer);
  state.scrollbarTimer = setTimeout(() => {
    document.documentElement.classList.remove('scrollbars-visible');
  }, 1200);
}

function setupStableScrollbars() {
  window.addEventListener('wheel', showScrollbarsTemporarily, { passive: true });
  window.addEventListener('scroll', showScrollbarsTemporarily, { passive: true });
  window.addEventListener('mousemove', (event) => {
    if (window.innerWidth - event.clientX <= 20) {
      showScrollbarsTemporarily();
    }
  });
}

function setBusy(isBusy) {
  state.busy = isBusy;
  document.querySelectorAll('button').forEach((button) => {
    button.disabled = isBusy;
  });
  if (!isBusy) updateSaveButton();
}

function option(value, text) {
  const el = document.createElement('option');
  el.value = value;
  el.textContent = text;
  return el;
}

function populateTracks() {
  const audioSelects = [$('subtitleAudioTrack'), $('manualAudioTrack')];
  for (const select of audioSelects) {
    select.innerHTML = '';
    select.appendChild(option('auto', '自动：Momo VoiceSub'));
    for (const track of state.audioTracks) {
      select.appendChild(option(String(track.index), `${track.index}. ${track.name || 'Audio'} (${track.subtype || 'audio'})`));
    }
  }

  $('subtitleTrack').innerHTML = '';
  for (const track of state.subtitleTracks) {
    $('subtitleTrack').appendChild(option(String(track.index), `${track.index}. ${track.name} · ${track.itemCount} 条`));
  }
}

function stylesForVoice(shortName) {
  const voice = state.voices.find((item) => item.shortName === shortName);
  return voice?.styles || [];
}

function populateStyleSelect(select, styles) {
  select.innerHTML = '';
  select.appendChild(option('', '默认'));
  for (const style of styles) {
    select.appendChild(option(style, style));
  }
}

function populateVoices() {
  const voiceSelects = [$('subtitleVoice'), $('manualVoice'), $('defaultVoice')];
  for (const select of voiceSelects) {
    const current = select.value;
    select.innerHTML = '';
    if (!state.voices.length) {
      select.appendChild(option(state.settings?.defaultVoice || 'zh-CN-XiaoxiaoNeural', state.settings?.defaultVoice || 'zh-CN-XiaoxiaoNeural'));
    } else {
      for (const voice of state.voices) {
        select.appendChild(option(voice.shortName, `${voice.localName || voice.displayName} · ${voice.shortName}`));
      }
    }
    select.value = current || state.settings?.defaultVoice || select.options[0]?.value || '';
  }

  populateStyleSelect($('subtitleStyle'), stylesForVoice($('subtitleVoice').value));
  populateStyleSelect($('manualStyle'), stylesForVoice($('manualVoice').value));
}

function voiceSettings(prefix) {
  return {
    voice: $(`${prefix}Voice`).value,
    style: $(`${prefix}Style`).value,
    rate: `${$(`${prefix}Rate`).value}%`,
    pitch: `${$(`${prefix}Pitch`).value}%`
  };
}

function loadSettingsToForm() {
  const settings = state.settings || {};
  $('azureRegion').value = settings.region || '';
  $('azureEndpoint').value = settings.endpoint || '';
  $('rememberKey').checked = Boolean(settings.rememberKey);
  $('cacheDir').value = settings.cacheDir || '';
  $('subtitleOverwrite').value = settings.overwriteMode || 'skip';
  $('subtitleRate').value = Number.parseInt(settings.defaultRate || '0', 10) || 0;
  $('manualRate').value = Number.parseInt(settings.defaultRate || '0', 10) || 0;
  $('subtitlePitch').value = Number.parseInt(settings.defaultPitch || '0', 10) || 0;
  $('manualPitch').value = Number.parseInt(settings.defaultPitch || '0', 10) || 0;
  updateRangeLabels();
}

function settingsSnapshotFromForm() {
  return {
    ...readSettingsFromForm(false),
    azureKeyDraft: $('azureKey').value.trim()
  };
}

function captureSettingsBaseline() {
  state.settingsBaseline = settingsSnapshotFromForm();
  updateSaveButton();
}

function settingsAreDirty() {
  if (!state.settingsBaseline) return false;
  return JSON.stringify(settingsSnapshotFromForm()) !== JSON.stringify(state.settingsBaseline);
}

function updateSaveButton() {
  const button = $('saveSettings');
  if (!button) return;
  const dirty = settingsAreDirty();
  button.disabled = state.busy || !dirty;
  button.classList.toggle('dirty-disabled', !state.busy && !dirty);
}

function readSettingsFromForm(includeKey = true) {
  const settings = {
    region: $('azureRegion').value.trim(),
    endpoint: $('azureEndpoint').value.trim(),
    rememberKey: $('rememberKey').checked,
    defaultVoice: $('defaultVoice').value || $('subtitleVoice').value,
    defaultStyle: '',
    defaultRate: `${$('subtitleRate').value}%`,
    defaultPitch: `${$('subtitlePitch').value}%`,
    overwriteMode: $('subtitleOverwrite').value
  };

  if (includeKey && $('azureKey').value.trim()) {
    settings.azureKey = $('azureKey').value.trim();
  }

  return settings;
}

function updateRangeLabels() {
  for (const prefix of ['subtitle', 'manual']) {
    $(`${prefix}RateValue`).textContent = `${$(`${prefix}Rate`).value}%`;
    $(`${prefix}PitchValue`).textContent = `${$(`${prefix}Pitch`).value}%`;
  }
  updateSaveButton();
}

function showRefreshHint(message = '已刷新') {
  const hint = $('refreshHint');
  hint.textContent = message;
  hint.classList.add('visible');
  clearTimeout(state.refreshHintTimer);
  state.refreshHintTimer = setTimeout(() => {
    hint.classList.remove('visible');
  }, 1600);
}

async function refreshState() {
  const appState = await window.momoVoiceSub.getState();
  state.appVersion = appState.version || '';
  state.settings = appState.settings;
  state.voices = appState.settings.voices || [];
  state.subtitleTracks = appState.resolve.subtitleTracks || [];
  state.audioTracks = appState.resolve.audioTracks || [];
  $('appVersion').textContent = state.appVersion ? `v${state.appVersion}` : '';

  $('resolveStatus').textContent = appState.resolve.ok
    ? `${appState.resolve.projectName} / ${appState.resolve.timelineName}`
    : appState.resolve.error;

  loadSettingsToForm();
  populateTracks();
  populateVoices();
  captureSettingsBaseline();

  if (!state.subtitleTracks.length) {
    setResult('subtitleResult', '当前时间线没有可读取的字幕轨。', 'error');
  }
}

async function saveSettings() {
  setBusy(true);
  try {
    state.settings = await window.momoVoiceSub.saveSettings(readSettingsFromForm(true));
    $('azureKey').value = '';
    loadSettingsToForm();
    populateVoices();
    captureSettingsBaseline();
    setResult('settingsResult', state.settings.hasAzureKey ? '设置已保存，密钥可用于本机调用。' : '设置已保存，但还没有可用密钥。', 'ok');
  } catch (error) {
    setResult('settingsResult', friendlyErrorMessage(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function testAzure() {
  setBusy(true);
  try {
    const result = await window.momoVoiceSub.testConnection(readSettingsFromForm(true));
    setResult('settingsResult', `连接成功，可用音色 ${result.count} 个。`, 'ok');
  } catch (error) {
    setResult('settingsResult', friendlyErrorMessage(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function refreshVoices() {
  setBusy(true);
  try {
    state.voices = await window.momoVoiceSub.listVoices(readSettingsFromForm(true));
    populateVoices();
    setResult('settingsResult', `已刷新 ${state.voices.length} 个音色。`, 'ok');
  } catch (error) {
    setResult('settingsResult', friendlyErrorMessage(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function openDevTools() {
  try {
    await window.momoVoiceSub.openDevTools();
  } catch (error) {
    setResult('settingsResult', friendlyErrorMessage(error), 'error');
  }
}

async function copyLog() {
  try {
    await window.momoVoiceSub.copyLog($('logOutput').textContent);
    log('运行日志已复制到剪贴板');
  } catch (error) {
    log(friendlyErrorMessage(error));
  }
}

async function exportLog() {
  try {
    const result = await window.momoVoiceSub.exportLog($('logOutput').textContent);
    if (!result.canceled) {
      log(`运行日志已导出：${result.filePath}`);
    }
  } catch (error) {
    log(friendlyErrorMessage(error));
  }
}

async function runCacheAction({ action, confirmMessage, successMessage }) {
  if (confirmMessage && !await window.momoVoiceSub.confirm({ message: confirmMessage })) {
    return;
  }

  setBusy(true);
  setResult('settingsResult', '正在清理缓存...');
  try {
    const result = await action();
    setResult('settingsResult', successMessage(result), 'ok');
  } catch (error) {
    setResult('settingsResult', friendlyErrorMessage(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function deleteUnusedCache() {
  await runCacheAction({
    action: () => window.momoVoiceSub.deleteUnusedCurrentProjectCache(),
    successMessage: (result) => {
      if (result.conservative) {
        return `已扫描 ${result.scanned} 个缓存文件，但发现 ${result.unresolved} 个时间线片段无法确认对应缓存。为避免误删，本次保留全部缓存。`;
      }
      return `已扫描 ${result.scanned} 个缓存文件，删除 ${result.deleted} 个未使用文件，保留 ${result.kept} 个正在使用的文件。`;
    }
  });
}

async function deleteCurrentProjectCache() {
  await runCacheAction({
    action: () => window.momoVoiceSub.deleteCurrentProjectCache(),
    confirmMessage: '确定删除当前项目的所有配音缓存吗？时间线里的片段不会被主动删除，但之后重复生成会重新调用 TTS。',
    successMessage: (result) => `已删除当前项目缓存 ${result.deleted} 个文件。`
  });
}

async function deleteAllProjectCache() {
  await runCacheAction({
    action: () => window.momoVoiceSub.deleteAllProjectCache(),
    confirmMessage: '确定删除所有项目的配音缓存吗？这个操作会清空默默配音助手的全部本机音频缓存。',
    successMessage: (result) => `已删除所有项目缓存 ${result.deleted} 个文件。`
  });
}

async function generateSubtitles() {
  if (!$('subtitleTrack').value) {
    setResult('subtitleResult', '请选择字幕轨。', 'error');
    return;
  }

  setBusy(true);
  setResult('subtitleResult', '正在生成字幕配音...');
  try {
    const result = await window.momoVoiceSub.generateFromSubtitles({
      subtitleTrackIndex: $('subtitleTrack').value,
      audioTrackIndex: $('subtitleAudioTrack').value,
      overwriteMode: $('subtitleOverwrite').value,
      voiceSettings: voiceSettings('subtitle')
    });
    setResult('subtitleResult', `完成：共 ${result.total} 条，插入 ${result.inserted} 条，跳过 ${result.skipped} 条。目标音频轨：${result.audioTrackIndex}`, 'ok');
    await refreshState();
  } catch (error) {
    setResult('subtitleResult', friendlyErrorMessage(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function insertManual() {
  const text = $('manualText').value.trim();
  if (!text) {
    setResult('manualResult', '请输入要生成配音的文字。', 'error');
    return;
  }

  setBusy(true);
  setResult('manualResult', '正在生成并插入...');
  try {
    const result = await window.momoVoiceSub.insertManual({
      text,
      audioTrackIndex: $('manualAudioTrack').value,
      voiceSettings: voiceSettings('manual')
    });
    setResult('manualResult', `已插入到 ${result.currentTimecode}（帧 ${result.recordFrame}），目标音频轨：${result.audioTrackIndex}`, 'ok');
    await refreshState();
  } catch (error) {
    setResult('manualResult', friendlyErrorMessage(error), 'error');
  } finally {
    setBusy(false);
  }
}

function setupEvents() {
  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((item) => item.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      $(button.dataset.tab).classList.add('active');
    });
  });

  $('refreshState').addEventListener('click', async () => {
    try {
      await refreshState();
      showRefreshHint();
    } catch (error) {
      showRefreshHint('刷新失败');
      log(friendlyErrorMessage(error));
    }
  });
  $('saveSettings').addEventListener('click', saveSettings);
  $('testAzure').addEventListener('click', testAzure);
  $('refreshVoices').addEventListener('click', refreshVoices);
  $('openDevTools').addEventListener('click', openDevTools);
  $('deleteUnusedCache').addEventListener('click', deleteUnusedCache);
  $('deleteCurrentProjectCache').addEventListener('click', deleteCurrentProjectCache);
  $('deleteAllProjectCache').addEventListener('click', deleteAllProjectCache);
  $('generateSubtitles').addEventListener('click', generateSubtitles);
  $('insertManual').addEventListener('click', insertManual);
  $('copyLog').addEventListener('click', copyLog);
  $('exportLog').addEventListener('click', exportLog);

  for (const id of ['azureRegion', 'azureEndpoint', 'azureKey', 'rememberKey', 'defaultVoice', 'subtitleOverwrite']) {
    $(id).addEventListener('input', updateSaveButton);
    $(id).addEventListener('change', updateSaveButton);
  }

  for (const id of ['subtitleRate', 'subtitlePitch', 'manualRate', 'manualPitch']) {
    $(id).addEventListener('input', updateRangeLabels);
  }

  $('subtitleVoice').addEventListener('change', () => populateStyleSelect($('subtitleStyle'), stylesForVoice($('subtitleVoice').value)));
  $('manualVoice').addEventListener('change', () => populateStyleSelect($('manualStyle'), stylesForVoice($('manualVoice').value)));

  window.addEventListener('beforeunload', () => {
    window.momoVoiceSub.cleanupResolveInterface();
  });

  window.momoVoiceSub.onLog((payload) => log(payload));
  window.momoVoiceSub.onToggleLog(toggleLogPanel);
}

window.addEventListener('DOMContentLoaded', async () => {
  setupStableScrollbars();
  setupEvents();
  try {
    await refreshState();
    log('插件已启动');
  } catch (error) {
    $('resolveStatus').textContent = friendlyErrorMessage(error);
    log(friendlyErrorMessage(error));
  }
});
