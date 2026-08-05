'use strict';

const AVATAR_MAP = {
  Female: 'img/woman-default.jpg',
  Male: 'img/man-default.jpg'
};

const OVERWRITE_OPTIONS = [
  { value: 'skip', label: '跳过已存在' },
  { value: 'replace', label: '重新生成并替换' },
  { value: 'allowDuplicate', label: '允许重复插入' }
];

const PAUSE_MS_OPTIONS = [
  { value: 'none', label: '强制不停顿' },
  { value: '50ms', label: '50ms' },
  { value: '100ms', label: '100ms' },
  { value: '250ms', label: '250ms' },
  { value: '500ms', label: '500ms' },
  { value: '1s', label: '1秒' },
  { value: '2s', label: '2秒' }
];

const STYLE_CN = {
  'general': '通用', 'chat': '聊天', 'cheerful': '愉快', 'sad': '悲伤',
  'angry': '愤怒', 'fearful': '恐惧', 'excited': '激动', 'friendly': '友好',
  'gentle': '温柔', 'lyrical': '抒情', 'serious': '严肃', 'poetry-reading': '诗歌朗读',
  'customercare': '客服', 'newscast': '新闻', 'assistant': '助手',
  'embarrassed': '尴尬', 'calm': '平静', 'hopeful': '希望', 'disgruntled': '不满',
  'whispering': '低语', 'shouting': '喊叫', 'unfriendly': '不友好',
  'terrified': '惊恐', 'sorrowful': '悲伤', 'narration-professional': '专业叙述',
  'narration-relaxed': '轻松叙述', 'documentary-narration': '纪录片旁白',
  'live-commercial': '直播带货', 'affectionate': '亲切', 'envy': '嫉妒',
  'depressed': '沮丧', 'advertisement_upbeat': '广告愉快',
  'sports_commentary': '体育评论', 'sports_commentary_excited': '激动评论'
};

const VOICE_TYPE_CATS = {
  'hd': '高清 HD',
  'expressive': '多情感',
  'multilingual': '多语言',
  'standard': '标准'
};

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// subs 结构：{ [subKey]: { label: string, locales: string[] | null } }
// locales 为 null 表示匹配组内全部 locale
const LOCALE_GROUPS = [
  { id: 'zh', label: '中文', match: (l) => l && (l.startsWith('zh-') || l.startsWith('yue-') || l.startsWith('wuu-')),
    subs: {
      'zh-CN': { label: '普通话', locales: ['zh-CN'] },
      'yue':   { label: '粤语',   locales: ['zh-HK', 'yue-CN'] },
      'zh-TW': { label: '国语(台湾)', locales: ['zh-TW'] },
    } },
  { id: 'en', label: 'English', match: (l) => l && l.startsWith('en-'),
    subs: {
      'en-US': { label: '美国',   locales: ['en-US'] },
      'en-GB': { label: '英国',   locales: ['en-GB'] },
      'en-AU': { label: '澳洲',   locales: ['en-AU'] },
      'en-CA': { label: '加拿大', locales: ['en-CA'] },
      'en-IN': { label: '印度',   locales: ['en-IN'] },
    } },
  { id: 'ja', label: '日本語', match: (l) => l === 'ja-JP', subs: {} },
  { id: 'ko', label: '한국어', match: (l) => l === 'ko-KR', subs: {} },
  { id: 'fr', label: 'Français', match: (l) => l && l.startsWith('fr-'),
    subs: {
      'fr-FR': { label: '法国',   locales: ['fr-FR'] },
      'fr-CA': { label: '加拿大', locales: ['fr-CA'] },
      'fr-CH': { label: '瑞士',   locales: ['fr-CH'] },
    } },
  { id: 'de', label: 'Deutsch', match: (l) => l && l.startsWith('de-'),
    subs: {
      'de-DE': { label: '德国',   locales: ['de-DE'] },
      'de-AT': { label: '奥地利', locales: ['de-AT'] },
      'de-CH': { label: '瑞士',   locales: ['de-CH'] },
    } },
  { id: 'es', label: 'Español', match: (l) => l && l.startsWith('es-'),
    subs: {
      'es-ES': { label: '西班牙', locales: ['es-ES'] },
      'es-MX': { label: '墨西哥', locales: ['es-MX'] },
    } },
  { id: 'pt', label: 'Português', match: (l) => l && l.startsWith('pt-'),
    subs: {
      'pt-BR': { label: '巴西',   locales: ['pt-BR'] },
      'pt-PT': { label: '葡萄牙', locales: ['pt-PT'] },
    } },
  { id: 'it', label: 'Italiano', match: (l) => l === 'it-IT', subs: {} },
  { id: 'ru', label: 'Русский', match: (l) => l === 'ru-RU', subs: {} },
  { id: 'ar', label: 'العربية', match: (l) => l && l.startsWith('ar-'),
    subs: {
      'ar-SA': { label: '沙特',     locales: ['ar-SA'] },
      'ar-EG': { label: '埃及',     locales: ['ar-EG'] },
      'ar-AE': { label: '阿联酋',   locales: ['ar-AE'] },
      'ar-DZ': { label: '阿尔及利亚', locales: ['ar-DZ'] },
      'ar-IQ': { label: '伊拉克',   locales: ['ar-IQ'] },
      'ar-KW': { label: '科威特',   locales: ['ar-KW'] },
      'ar-MA': { label: '摩洛哥',   locales: ['ar-MA'] },
      'ar-QA': { label: '卡塔尔',   locales: ['ar-QA'] },
      'ar-SY': { label: '叙利亚',   locales: ['ar-SY'] },
    } },
  { id: 'other', label: '其他', match: (l) => {
    if (!l) return true;
    const known = ['zh-', 'yue-', 'wuu-', 'en-', 'ja-JP', 'ko-KR', 'fr-', 'de-', 'es-', 'pt-', 'it-IT', 'ru-RU', 'ar-'];
    return !known.some(p => l.startsWith(p) || l === p);
  }, subs: {} }
];

/** 判断 locale 是否被某个 sub 匹配 */
function subMatchesLocale(subDef, locale) {
  return subDef.locales ? subDef.locales.includes(locale) : false;
}

const state = {
  settings: null,
  voices: [],
  subtitleTracks: [],
  audioTracks: [],
  settingsBaseline: null,
  busy: false,
  refreshHintTimer: null,
  subtitleItems: [],
  subtitleAnnotations: new Map(),
  manualAnnotations: [],
  polyphonicDict: [],
  builtinPolyDict: [],
  builtinPolyExpanded: false,
  presets: [],
  defaultPresetId: '',
  selectedSubtitleTrack: null,
  selectedAudioTrack: 'auto',
  selectedOverwrite: 'skip',
  selectedManualAudioTrack: 'auto',
  selectedManualOverwrite: 'skip',
  loadedSubtitleTrack: null,
  srtItems: [],
  srtFileName: '',
  appVersion: '',
  updateStatus: 'idle', // idle | checking | latest | available | error
  updateLatestVersion: '', // 远程最新版本号
  initialized: false,
  disabledFrames: new Set(),
  // 当前激活的标签页 ID（subtitles / manual / settings），供 setBusy 定位触发按钮
  currentTab: 'subtitles',
  // 当前 Resolve 时间线名，用于检测时间线切换并联动字幕列表
  currentTimelineName: ''
};

const voicePickers = {};
let polyPopupCallback = null;
let activeSubtitleFrame = null;
// 渲染期间抑制 focus 事件触发的行激活，避免右键禁用等操作误触发"第x行"提示
let suppressActivation = false;

function $(id) { return document.getElementById(id); }

function tag(text, value, active = false, cls = '') {
  const el = document.createElement('span');
  el.className = `tag${active ? ' active' : ''}${cls ? ' ' + cls : ''}`;
  el.textContent = text;
  el.dataset.value = value;
  return el;
}

function friendlyErrorMessage(error) {
  let message = typeof error === 'string' ? error : (error && error.message) || '操作失败。';
  message = message.replace(/^Error invoking remote method '[^']+': Error:\s*/i, '');
  if (/No current timeline/i.test(message)) return '当前项目没有选中的时间线。请先创建并打开一条时间线。';
  if (/No current Resolve project/i.test(message)) return '当前没有打开项目。请先打开或创建一个项目。';
  if (/GetCurrentTimecode|Not supported on current page/i.test(message)) return '当前页面不能读取播放头位置。请切换到"快编"或"剪辑"页面后再插入配音。';
  if (/Failed to import audio/i.test(message)) return message.replace(/Failed to import audio:/i, '导入音频失败：');
  if (/Failed to append audio to timeline/i.test(message)) return '音频已生成，但插入时间线失败。请检查目标音频轨是否锁定或不可用。';
  if (/Azure Speech key is required/i.test(message)) return '请先在设置中填写 密钥。';
  if (/Azure region or endpoint is required/i.test(message)) return '请先在设置中填写 位置/区域。';
  // 云端鉴权相关错误
  if (/TOKEN_EXPIRED/.test(message)) return '云端登录已过期，请重新登录。';
  if (/NOT_LOGGED_IN|未登录云端账号/.test(message)) return '请先登录云端账号。';
  if (/BANNED|账号已被封禁/.test(message)) return '账号已被封禁，请联系管理员。';
  if (/设备数已达上限/.test(message)) return message; // 设备数超限，原样返回（已含中文说明）
  // 瞬态网络错误（连接池复用、流损坏、超时等），重试通常即可解决
  if (/Body is unusable|Body has already been read|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|UND_ERR|network|网络/i.test(message)) {
    return message + '\n\n这是网络瞬时波动导致的，请尝试重新生成。';
  }
  return message;
}

/**
 * 检测是否是云端鉴权错误（token 过期 / 未登录），是则弹登录窗口
 * @returns {boolean} 是否为鉴权错误
 */
function handleCloudAuthError(error) {
  const msg = typeof error === 'string' ? error : (error?.message || '');
  if (/TOKEN_EXPIRED|NOT_LOGGED_IN|未登录云端账号/.test(msg)) {
    showToast('请先登录云端账号', 'info');
    const popup = $('loginPopup');
    if (popup) popup.classList.remove('hidden');
    return true;
  }
  return false;
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
  const logEl = document.querySelector('.log-panel');
  if (!logEl) return;
  const wasVisible = logEl.classList.contains('visible');
  logEl.classList.toggle('visible');
  // 首次显示时默认展开为大尺寸，无需用户再点"展开"按钮
  if (!wasVisible) {
    logEl.classList.add('expanded');
  }
}

function styleCn(style) { return STYLE_CN[style] || style; }

function setBusy(isBusy, btnId) {
  state.busy = isBusy;
  // 不再使用全屏 cursor:wait（体验差），改为在触发按钮上显示旋转加载动画
  // 保留所有按钮 disabled，防止并发操作
  document.querySelectorAll('button').forEach((b) => { b.disabled = isBusy; });

  // 给触发按钮加 loading 状态（旋转动画 + 文字保留）
  // 优先用传入的 btnId，否则找当前 active tab 的主操作按钮
  const targetBtnId = btnId
    || (state.currentTab === 'manual' ? 'insertManual' : 'generateSubtitles');
  const btn = $(targetBtnId);
  if (btn) {
    if (isBusy) {
      btn.classList.add('btn-loading');
      // 保存原始文字，加 spinner
      if (!btn.dataset.originalText) {
        btn.dataset.originalText = btn.textContent;
      }
      btn.innerHTML = '<span class="btn-spinner"></span><span class="btn-loading-text">处理中...</span>';
    } else {
      btn.classList.remove('btn-loading');
      if (btn.dataset.originalText) {
        btn.textContent = btn.dataset.originalText;
        delete btn.dataset.originalText;
      }
    }
  }
}

function setResult(id, message, kind = '', autoCloseMs = 0) {
  if (!message) return;
  showToast(message, kind);
}

/**
 * 自定义确认对话框（替代原生 dialog.showMessageBox）
 * @param {object} options
 * @param {string} options.message - 主提示文案
 * @param {string} [options.detail] - 补充说明
 * @param {string} [options.confirmText='确定'] - 确认按钮文字
 * @param {string} [options.cancelText='取消'] - 取消按钮文字
 * @param {boolean} [options.danger=false] - 是否为危险操作（确认按钮显示红色）
 * @returns {Promise<boolean>} 用户点击确定返回 true，取消返回 false
 */
function showConfirmDialog({ message, detail, confirmText = '确定', cancelText = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'popup-overlay confirm-dialog-overlay';

    const panel = document.createElement('div');
    panel.className = 'popup-panel popup-sm confirm-dialog-panel';

    const iconWrap = document.createElement('div');
    iconWrap.className = danger ? 'confirm-dialog-icon danger' : 'confirm-dialog-icon';
    iconWrap.innerHTML = danger
      ? '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>'
      : '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';

    const content = document.createElement('div');
    content.className = 'confirm-dialog-content';
    const msgEl = document.createElement('div');
    msgEl.className = 'confirm-dialog-message';
    msgEl.textContent = message || '确定执行这个操作吗？';
    content.appendChild(msgEl);
    if (detail) {
      const detailEl = document.createElement('div');
      detailEl.className = 'confirm-dialog-detail';
      detailEl.textContent = detail;
      content.appendChild(detailEl);
    }

    const body = document.createElement('div');
    body.className = 'confirm-dialog-body';
    body.appendChild(iconWrap);
    body.appendChild(content);

    const actions = document.createElement('div');
    actions.className = 'confirm-dialog-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = cancelText;
    const confirmBtn = document.createElement('button');
    confirmBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';
    confirmBtn.textContent = confirmText;
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);

    panel.appendChild(body);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    let settled = false;
    function close(result) {
      if (settled) return;
      settled = true;
      overlay.remove();
      document.removeEventListener('keydown', escHandler);
      resolve(result);
    }
    function escHandler(e) {
      if (e.key === 'Escape') close(false);
    }

    cancelBtn.addEventListener('click', () => close(false));
    confirmBtn.addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    document.addEventListener('keydown', escHandler);

    // 自动聚焦确认按钮，回车直接确认
    requestAnimationFrame(() => {
      confirmBtn.focus();
    });
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); close(true); }
    });
  });
}

// 汉语拼音标调转换函数：将带声调数字的拼音（如 da 4）智能自动换算生成为带标准声调符号的拼音（如 dà）
function phoneticToPinyin(phoneticStr) {
  const cleaned = phoneticStr.trim().toLowerCase().replace(/\s+/g, '');
  const match = cleaned.match(/^([a-züü]+)([1-5])$/);
  if (!match) return phoneticStr;

  let word = match[1];
  const tone = parseInt(match[2], 10);
  if (tone === 5) {
    return word;
  }

  const toneMap = {
    'a': ['ā', 'á', 'ǎ', 'à'],
    'o': ['ō', 'ó', 'ǒ', 'ò'],
    'e': ['ē', 'é', 'ě', 'è'],
    'i': ['ī', 'í', 'ǐ', 'ì'],
    'u': ['ū', 'ú', 'ǔ', 'ù'],
    'v': ['ǖ', 'ǘ', 'ǚ', 'ǜ'],
    'ü': ['ǖ', 'ǘ', 'ǚ', 'ǜ']
  };

  let pos = -1;
  if (word.indexOf('a') !== -1) {
    pos = word.indexOf('a');
  } else if (word.indexOf('o') !== -1) {
    pos = word.indexOf('o');
  } else if (word.indexOf('e') !== -1) {
    pos = word.indexOf('e');
  } else if (word.indexOf('ui') !== -1) {
    pos = word.indexOf('i');
  } else if (word.indexOf('iu') !== -1) {
    pos = word.indexOf('u');
  } else {
    for (let i = 0; i < word.length; i++) {
      if ('iuvü'.indexOf(word[i]) !== -1) {
        pos = i;
        break;
      }
    }
  }

  if (pos !== -1) {
    const charToReplace = word[pos];
    const tonedChar = toneMap[charToReplace][tone - 1];
    word = word.slice(0, pos) + tonedChar + word.slice(pos + 1);
  }

  return word;
}

// 静默规整与治愈自定义字典里的旧无空格脏数据（如 da4 自动升级为 da 4）并全自动落盘
function sanitizePolyphonicDict(dict) {
  if (!dict || !dict.length) return dict;
  let isDirty = false;
  const sanitized = dict.map(entry => {
    let ph = (entry.phonetic || '').trim();
    if (ph && !ph.includes(' ')) {
      const replaced = ph.replace(/^([a-zA-Züü]+)([1-5])$/i, '$1 $2');
      if (replaced !== ph) {
        isDirty = true;
        return { ...entry, phonetic: replaced };
      }
    }
    return entry;
  });
  if (isDirty) {
    state.polyphonicDict = sanitized;
    setTimeout(() => {
      savePolyDictAutomatically().catch(() => {});
    }, 100);
  }
  return sanitized;
}

// 全自动、静默持久化用户自定义多音字词典到硬盘文件，消除数据无故丢失风险
async function savePolyDictAutomatically() {
  try {
    const settingsToSave = readSettingsFromForm(true);
    settingsToSave.polyphonicDict = state.polyphonicDict;
    state.settings = await window.momoVoiceSub.saveSettings(settingsToSave);
    log('用户多音字词典已全自动静默持久化到硬盘');
  } catch (error) {
    log('用户多音字词典自动落盘失败: ' + error.message);
  }
}

function showRefreshHint(message = '已刷新达芬奇状态') {
  showToast(message, 'ok');
}

function updateRangeLabels() {
  for (const prefix of ['subtitle', 'manual']) {
    const rate = $(`${prefix}Rate`);
    const pitch = $(`${prefix}Pitch`);
    const vol = $(`${prefix}Volume`);
    const sd = $(`${prefix}Styledegree`);
    if (rate) $(`${prefix}RateValue`).textContent = `${rate.value}%`;
    if (pitch) $(`${prefix}PitchValue`).textContent = `${pitch.value}%`;
    if (vol) $(`${prefix}VolumeValue`).textContent = `${vol.value}%`;
    if (sd) $(`${prefix}StyledegreeValue`).textContent = `${sd.value}%`;
  }
}

function getPolyphonicDict() {
  const user = (state.settings && state.settings.polyphonicDict) || [];
  const all = [...user];
  const existingKeys = new Set(all.map(e => `${e.char}_${e.phonetic}`));
  for (const builtin of state.builtinPolyDict) {
    const key = `${builtin.char}_${builtin.phonetic}`;
    if (!existingKeys.has(key)) {
      all.push(builtin);
      existingKeys.add(key);
    }
  }
  return all;
}

function findPolyEntries(char) {
  return getPolyphonicDict().filter(e => e.char === char);
}

// ─── Annotation Preview ───

function renderAnnotatedPreview(text, annotations) {
  if (!annotations || !annotations.length) return escHtml(text);
  const sorted = [...annotations].sort((a, b) => a.start - b.start);
  let result = '';
  let pos = 0;
  for (const ann of sorted) {
    if (ann.start > pos) result += escHtml(text.slice(pos, ann.start));
    if (ann.start >= text.length) continue;
    const char = text[ann.start];
    if (ann.type === 'polyphonic' && ann.phonetic) {
      result += `<span class="ann-poly">${escHtml(char)}<span class="ann-poly-tag">[${escHtml(ann.phonetic)}]</span></span>`;
    } else if (ann.type === 'pause') {
      result += `<span class="ann-pause">⏸${ann.duration || 500}ms</span>`;
    } else {
      result += escHtml(char);
    }
    pos = ann.end;
  }
  if (pos < text.length) result += escHtml(text.slice(pos));
  return result;
}

function renderAnnotatedRow(text, annotations) {
  if (!annotations || !annotations.length) return escHtml(text);
  const sorted = [...annotations].sort((a, b) => a.start - b.start);
  let result = '';
  let pos = 0;
  for (const ann of sorted) {
    if (ann.start > pos) result += escHtml(text.slice(pos, ann.start));
    if (ann.start >= text.length) continue;
    const char = text[ann.start];
    if (ann.type === 'polyphonic' && ann.phonetic) {
      result += `<mark class="ann-poly-inline">${escHtml(char)}[${escHtml(ann.phonetic)}]</mark>`;
    } else if (ann.type === 'pause') {
      result += `<mark class="ann-pause-inline">⏸${ann.duration || 500}ms</mark>`;
    } else {
      result += escHtml(char);
    }
    pos = ann.end;
  }
  if (pos < text.length) result += escHtml(text.slice(pos));
  return result;
}

// ─── Node Version Warning ───

function showNodeWarning(warning) {
  const banner = $('nodeWarningBanner');
  if (!banner) return;

  if (!warning) {
    banner.classList.add('hidden');
    return;
  }

  const titleEl = $('nodeWarningTitle');
  const msgEl = $('nodeWarningMessage');
  const sugEl = $('nodeWarningSuggestion');
  if (titleEl) titleEl.textContent = warning.title || '';
  if (msgEl) msgEl.textContent = warning.message || '';
  if (sugEl) sugEl.textContent = warning.suggestion || '';
  banner.classList.remove('hidden');
}

// ─── Toast System ───

function showToast(message, kind) {
  kind = kind || 'info';
  const area = document.getElementById('toastArea');
  if (!area) return;
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  area.appendChild(el);
  
  requestAnimationFrame(() => el.classList.add('toast-show'));
  
  setTimeout(() => {
    el.classList.remove('toast-show');
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

function highlightText(text) {
  if (!text) return '';
  const escaped = escapeHtml(text);
  let count = 0;
  return escaped.replace(/(?:(.)\[([a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ1-4\s]+)\]|(\[pause:(\d+)(ms)?\]))/g, (match, char, phonetic, pauseFull, pauseMs) => {
    const idx = count++;
    if (char) {
      return `<span class="poly-highlight" data-idx="${idx}">${char}[${phonetic}]<span class="ann-remove" data-idx="${idx}">×</span></span>`;
    } else {
      return `<span class="ann-pause" data-idx="${idx}">⏸ ${pauseMs}ms<span class="ann-remove" data-idx="${idx}">×</span></span>`;
    }
  });
}

function removeAnnotationByIndex(annotatedText, targetIndex) {
  if (!annotatedText) return '';
  const regex = /(?:(.)\[([a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ1-4\s]+)\]|(\[pause:\d+(?:ms)?\]))/g;
  let match;
  let currentIndex = 0;
  let result = '';
  let lastIndex = 0;
  
  while ((match = regex.exec(annotatedText)) !== null) {
    if (currentIndex === targetIndex) {
      result += annotatedText.slice(lastIndex, match.index);
      if (match[1]) {
        result += match[1];
      }
      lastIndex = regex.lastIndex;
      result += annotatedText.slice(lastIndex);
      return result;
    }
    currentIndex++;
  }
  return annotatedText;
}

function updateAnnotationByIndex(annotatedText, targetIndex, newPhoneticOrDuration) {
  if (!annotatedText) return '';
  const regex = /(?:(.)\[([a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ1-4\s]+)\]|(\[pause:(\d+)(ms)?\]))/g;
  let match;
  let currentIndex = 0;
  let result = '';
  let lastIndex = 0;
  
  while ((match = regex.exec(annotatedText)) !== null) {
    if (currentIndex === targetIndex) {
      result += annotatedText.slice(lastIndex, match.index);
      if (match[1]) {
        // 多音字，修改拼音标注
        result += `${match[1]}[${newPhoneticOrDuration}]`;
      } else {
        // 停顿标记，修改停顿毫秒数
        result += `[pause:${newPhoneticOrDuration}]`;
      }
      lastIndex = regex.lastIndex;
      result += annotatedText.slice(lastIndex);
      return result;
    }
    currentIndex++;
  }
  return annotatedText;
}

function updateSubtitleHighlighter(ta, hl) {
  if (!ta || !hl) return;
  const frame = Number(ta.dataset.frame);
  const item = state.subtitleItems.find(s => s.startFrame === frame);
  
  const text = item ? item.text : ta.value;
  if (!text) {
    hl.classList.add('hidden');
    hl.innerHTML = '';
    return;
  }
  
  const { annotations } = parseTextAndGenerateAnnotations(text);
  
  if (annotations && annotations.length > 0) {
    hl.classList.remove('hidden');
    const highlighted = highlightText(text);
    hl.innerHTML = highlighted + (highlighted.endsWith('\n') ? ' ' : '');
  } else {
    hl.classList.add('hidden');
    hl.innerHTML = '';
  }
}

function getAnnotatedPos(annotatedText, plainPos) {
  if (!annotatedText) return plainPos;
  const regex = /(?:\[[a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ1-4\s]+\]|\[pause:\d+(?:ms)?\])/g;
  let match;
  let skippedLength = 0;
  while ((match = regex.exec(annotatedText)) !== null) {
    const matchStart = match.index;
    const matchLength = match[0].length;
    if (matchStart - skippedLength <= plainPos) {
      skippedLength += matchLength;
    } else {
      break;
    }
  }
  return plainPos + skippedLength;
}

function syncAnnotatedText(oldAnnotated, newPlain) {
  if (!oldAnnotated) return newPlain;
  const { cleanText: oldPlain, annotations } = parseTextAndGenerateAnnotations(oldAnnotated);
  if (oldPlain === newPlain) return oldAnnotated;

  const list = [];
  for (let i = 0; i < oldPlain.length; i++) {
    list.push({
      char: oldPlain[i],
      phoneme: null,
      breaks: []
    });
  }

  for (const ann of annotations) {
    if (ann.type === 'phoneme') {
      const idx = ann.start;
      if (list[idx]) {
        list[idx].phoneme = ann.phonetic;
      }
    } else if (ann.type === 'break') {
      const idx = Math.min(ann.start, oldPlain.length - 1);
      if (idx >= 0 && list[idx]) {
        list[idx].breaks.push(ann.duration);
      } else {
        list.headerBreaks = list.headerBreaks || [];
        list.headerBreaks.push(ann.duration);
      }
    }
  }

  let oldIdx = 0;
  let result = '';

  if (list.headerBreaks) {
    for (const ms of list.headerBreaks) {
      result += `[pause:${ms}]`;
    }
  }

  for (let i = 0; i < newPlain.length; i++) {
    const newChar = newPlain[i];
    let foundIdx = -1;
    for (let j = oldIdx; j < list.length; j++) {
      if (list[j].char === newChar) {
        foundIdx = j;
        break;
      }
    }

    if (foundIdx !== -1) {
      const item = list[foundIdx];
      result += item.char;
      if (item.phoneme) {
        result += `[${item.phoneme}]`;
      }
      for (const ms of item.breaks) {
        result += `[pause:${ms}]`;
      }
      oldIdx = foundIdx + 1;
    } else {
      result += newChar;
    }
  }

  return result;
}

function updateManualHighlighter() {
  const ta = $('manualText');
  const hl = $('manualTextHighlight');
  const title = $('manualPreviewTitle');
  if (!ta || !hl) return;
  
  const text = state.manualTextWithAnnotations || ta.value;
  if (!text) {
    if (title) title.classList.add('hidden');
    hl.classList.add('hidden');
    hl.innerHTML = '';
    localStorage.removeItem('manualTextWithAnnotations'); // 清空后彻底清退存储，避免脏残留
    return;
  }
  
  const { annotations } = parseTextAndGenerateAnnotations(text);
  
  // 全自动实时将带标注文本静默同步持久化至 localStorage，消灭重启数据丢失Bug
  localStorage.setItem('manualTextWithAnnotations', state.manualTextWithAnnotations || '');
  
  // 只有当存在纠音或停顿等有效标注时，才展现效果预览区
  if (annotations && annotations.length > 0) {
    if (title) title.classList.remove('hidden');
    hl.classList.remove('hidden');
    const highlighted = highlightText(text);
    hl.innerHTML = highlighted + (highlighted.endsWith('\n') ? ' ' : '');
  } else {
    if (title) title.classList.add('hidden');
    hl.classList.add('hidden');
    hl.innerHTML = '';
  }
}

function parseTextAndGenerateAnnotations(rawText) {
  const finalAnns = [];
  
  // 联合正则：同时捕获 字[拼音] 以及 [pause:停顿毫秒数]
  const regex = /(?:(.)\[([a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ1-4\s]+)\]|\[pause:(\d+)(ms)?\])/g;
  let match;
  const matches = [];
  
  while ((match = regex.exec(rawText)) !== null) {
    if (match[1]) {
      // 捕获到多音字
      matches.push({
        start: match.index,
        end: regex.lastIndex,
        type: 'phoneme',
        char: match[1],
        phonetic: match[2]
      });
    } else if (match[3]) {
      // 捕获到停顿
      matches.push({
        start: match.index,
        end: regex.lastIndex,
        type: 'break',
        duration: Number.parseInt(match[3], 10) || 500
      });
    }
  }
  
  let cleanText = "";
  let lastIdx = 0;
  
  for (const m of matches) {
    cleanText += rawText.slice(lastIdx, m.start);
    const start = cleanText.length;
    
    if (m.type === 'phoneme') {
      cleanText += m.char;
      const end = cleanText.length;
      
      const allDict = getPolyphonicDict();
      const matchedEntry = allDict.find(e => e.char === m.char && (e.pinyin === m.phonetic || e.phonetic === m.phonetic));
      let phonetic = matchedEntry ? matchedEntry.phonetic : m.phonetic;
      if (phonetic) {
        const cleanPh = phonetic.trim().replace(/\s+/g, '').toLowerCase();
        if (/^([a-züü]+)[1-5]$/.test(cleanPh)) {
          phonetic = cleanPh.replace(/^([a-züü]+)([1-5])$/, '$1 $2');
        }
      }
      
      finalAnns.push({
        start,
        end,
        type: 'phoneme',
        phonetic,
        char: m.char
      });
    } else if (m.type === 'break') {
      // 停顿在 Azure TTS 中是一个 position 标记，发给后端的 annotations 中其 start 与 end 需保持一致且不占文本位
      finalAnns.push({
        start,
        end: start,
        type: 'break',
        duration: m.duration
      });
    }
    
    lastIdx = m.end;
  }
  
  if (lastIdx < rawText.length) {
    cleanText += rawText.slice(lastIdx);
  }
  
  return { cleanText, annotations: finalAnns };
}

// ─── Voice Picker (Complete Redesign) ───

/**
 * 移除微软语音 API 返回的技术后缀，不影响原始数据
 * 例："晓晓 Dragon HD Flash Latest" → "晓晓"
 */
function cleanVoiceName(name) {
  if (!name) return name;
  return name
    .replace(/\b(Dragon|HD|Flash|Latest|Neural|Multilingual|Online|TTS|V\d+|\d+[KkMm]Hz)\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function createVoicePicker(container, options) {
  const {
    mode = 'compact', onSelect, onPreview, onToggleFavorite
  } = options;

  let selected = options.selected || '';
  let pendingSelected = selected;
  let filterText = '';
  let filterLocaleGroup = 'zh';
  let filterLocaleSub = 'zh-CN';
  let filterGender = 'all';
  let filterVoiceType = 'all';
  let filterStyle = 'all';
  let showFavoritesOnly = false;
  let voices = options.voices || [];
  let favorites = options.favorites || [];
  let isOpen = false;

  function useVoices() { return voices; }

  function localeLabel(locale) {
    const map = {
      'zh-CN': '普通话', 'zh-HK': '粤语(香港)', 'zh-TW': '国语(台湾)',
      'yue-CN': '粤语', 'wuu-CN': '吴语(上海)',
      // 中文方言/地方口音
      'zh-CN-liaoning': '辽宁', 'zh-CN-guangxi': '广西',
      'zh-CN-henan': '河南', 'zh-CN-shaanxi': '陕西',
      'zh-CN-shandong': '山东', 'zh-CN-sichuan': '四川',
      // 英语
      'en-US': '美国', 'en-GB': '英国', 'en-AU': '澳洲',
      'en-CA': '加拿大', 'en-IN': '印度',
      'ja-JP': '日本', 'ko-KR': '韩国',
      'fr-FR': '法国', 'fr-CA': '加拿大(法)', 'fr-CH': '瑞士(法)',
      'de-DE': '德国', 'de-AT': '奥地利', 'de-CH': '瑞士(德)',
      'es-ES': '西班牙', 'es-MX': '墨西哥',
      'pt-BR': '巴西', 'pt-PT': '葡萄牙',
      'it-IT': '意大利', 'ru-RU': '俄罗斯',
      'ar-SA': '沙特', 'ar-EG': '埃及', 'ar-AE': '阿联酋', 'ar-DZ': '阿尔及利亚',
      'ar-IQ': '伊拉克', 'ar-KW': '科威特', 'ar-MA': '摩洛哥', 'ar-QA': '卡塔尔',
      'ar-SY': '叙利亚', 'ar-BH': '巴林', 'ar-JO': '约旦', 'ar-LB': '黎巴嫩',
      'ar-OM': '阿曼', 'ar-TN': '突尼斯', 'ar-YE': '也门'
    };
    return map[locale] || locale;
  }

  function isChineseLocale(locale) {
    return locale && (locale.startsWith('zh-') || locale.startsWith('yue-') || locale.startsWith('wuu-'));
  }

  function getLocaleGroups() {
    return LOCALE_GROUPS.map(g => {
      const count = voices.filter(v => g.match(v.locale)).length;
      return { ...g, count };
    }).filter(g => g.count > 0 || g.id === 'all');
  }

  function getActiveSubLocales() {
    const group = LOCALE_GROUPS.find(g => g.id === filterLocaleGroup);
    if (!group || !Object.keys(group.subs).length) return [];

    // 1. 预定义的 subs
    const result = Object.entries(group.subs)
      .map(([key, subDef]) => {
        const count = voices.filter(v => group.match(v.locale) && subMatchesLocale(subDef, v.locale)).length;
        return [key, { label: subDef.label, count }];
      })
      .filter(([, { count }]) => count > 0);

    // 2. 收集已被预定义 subs 覆盖的所有 locale
    const coveredLocales = new Set(
      Object.values(group.subs).flatMap(subDef => subDef.locales || [])
    );

    // 3. 找出未被覆盖的 locale，每个单独作为子分类追加
    const uncovered = {};
    for (const v of voices) {
      if (group.match(v.locale) && v.locale && !coveredLocales.has(v.locale)) {
        uncovered[v.locale] = (uncovered[v.locale] || 0) + 1;
      }
    }
    for (const [loc, count] of Object.entries(uncovered)) {
      result.push([loc, { label: localeLabel(loc), count }]);
    }

    return result.sort((a, b) => b[1].count - a[1].count);
  }

  function getAllStyles() {
    const styleSet = new Set();
    for (const v of voices) {
      if (v.styles) v.styles.forEach(s => styleSet.add(s));
    }
    return Array.from(styleSet).sort();
  }

  /**
   * 按 Azure 官方音色技术模型分类。
   *
   * - HD 高清音色：ShortName 含 ":"（DragonHD 系列，如 Yunye:DragonHDFlashLatestNeural）
   * - 多语言音色：ShortName 含 Multilingual
   * - 多情感音色：有 StyleList（支持情感样式切换）
   * - 标准神经音色：其他普通 Neural 音色
   *
   * 判断顺序很重要：HD 优先（HD 音色也可能有 styles），
   * 然后多语言，然后多情感，最后标准。
   */
  function voiceTypeCat(voice) {
    const sn = voice.shortName || '';
    if (sn.includes(':')) return 'hd';
    if (/Multilingual/i.test(sn)) return 'multilingual';
    if (voice.styles && voice.styles.length > 0) return 'expressive';
    return 'standard';
  }

  function filteredVoices() {
    let result = voices.filter((v) => {
      if (filterText) {
        const q = filterText.toLowerCase();
        const name = cleanVoiceName(v.localName || v.displayName || v.shortName).toLowerCase();
        if (!name.includes(q) && !v.shortName.toLowerCase().includes(q) && !(v.locale || '').toLowerCase().includes(q)) {
          return false;
        }
      }
      if (filterLocaleGroup !== 'all') {
        const group = LOCALE_GROUPS.find(g => g.id === filterLocaleGroup);
        if (!group || !group.match(v.locale)) return false;
      }
      if (filterLocaleSub !== null) {
        const group = LOCALE_GROUPS.find(g => g.id === filterLocaleGroup);
        const subDef = group && group.subs[filterLocaleSub];
        if (subDef) {
          // 预定义的 sub：按 locales 数组匹配
          if (!subMatchesLocale(subDef, v.locale)) return false;
        } else {
          // 动态追加的未覆盖 locale：直接按 locale 匹配
          if (v.locale !== filterLocaleSub) return false;
        }
      }
      if (filterGender !== 'all' && v.gender !== filterGender) return false;
      if (showFavoritesOnly && !favorites.includes(v.shortName)) return false;
      if (filterVoiceType !== 'all') {
        if (voiceTypeCat(v) !== filterVoiceType) return false;
      }
      if (filterStyle !== 'all') {
        if (!(v.styles || []).includes(filterStyle)) return false;
      }
      return true;
    });
    if (filterLocaleGroup === 'all' && !filterText) {
      result.sort((a, b) => {
        const aCN = isChineseLocale(a.locale);
        const bCN = isChineseLocale(b.locale);
        if (aCN && !bCN) return -1;
        if (!aCN && bCN) return 1;
        return 0;
      });
    }
    return result;
  }

  function renderCard(voice) {
    const isSelected = voice.shortName === pendingSelected;
    const isFav = favorites.includes(voice.shortName);
    const avatarSrc = AVATAR_MAP[voice.gender] || 'img/woman-default.jpg';
    const styleTags = (voice.styles || []).slice(0, 2);
    const extraStyles = (voice.styles || []).length - 2;

    const card = document.createElement('div');
    card.className = `vp-card${isSelected ? ' selected' : ''}`;
    card.dataset.shortName = voice.shortName;

    card.innerHTML = `
      <img class="vp-card-avatar" src="${avatarSrc}" alt="" loading="lazy">
      <div class="vp-card-info">
        <div class="vp-card-name">${cleanVoiceName(voice.localName || voice.displayName || voice.shortName)}</div>
        <div class="vp-card-meta">
          <span class="vp-card-tag">${localeLabel(voice.locale) || voice.locale}</span>
          <span class="vp-card-tag">${voice.gender === 'Female' ? '女声' : voice.gender === 'Male' ? '男声' : voice.gender || ''}</span>
          ${styleTags.map(s => `<span class="vp-card-tag style-tag">${styleCn(s)}</span>`).join('')}
          ${extraStyles > 0 ? `<span class="vp-card-tag">+${extraStyles}</span>` : ''}
        </div>
      </div>
      <div class="vp-card-actions">
        <button class="vp-card-preview-btn" title="试听">▶</button>
        <button class="vp-card-fav-btn${isFav ? ' favorited' : ''}" title="${isFav ? '取消收藏' : '收藏'}">${isFav ? '❤' : '♡'}</button>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.vp-card-preview-btn') || e.target.closest('.vp-card-fav-btn')) return;
      pendingSelected = voice.shortName;
      renderGrid();
    });

    card.querySelector('.vp-card-preview-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (onPreview) onPreview(voice.shortName);
    });

    card.querySelector('.vp-card-fav-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (onToggleFavorite) onToggleFavorite(voice.shortName);
    });

    return card;
  }

  function renderGrid() {
    const grid = container.querySelector('.vp-grid');
    const filtered = filteredVoices();
    grid.innerHTML = '';
    if (!voices.length) {
      // 音色列表完全为空（未登录云端且未填 Azure key）
      const empty = document.createElement('div');
      empty.className = 'vp-grid-empty';
      empty.textContent = '请自填 key 或者登录账号以刷新音色列表';
      grid.appendChild(empty);
      return;
    }
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'vp-grid-empty';
      empty.textContent = showFavoritesOnly ? '暂无收藏的音色' : '没有匹配的音色';
      grid.appendChild(empty);
      return;
    }
    for (const voice of filtered) {
      grid.appendChild(renderCard(voice));
    }
  }

  function updateTrigger() {
    const trigger = container.querySelector('.vp-trigger');
    if (!trigger) return;
    const voice = voices.find(v => v.shortName === selected);
    const avatar = trigger.querySelector('.vp-trigger-avatar');
    const name = trigger.querySelector('.vp-trigger-name');
    const locale = trigger.querySelector('.vp-trigger-locale');
    if (avatar) avatar.src = voice ? (AVATAR_MAP[voice.gender] || 'img/woman-default.jpg') : 'img/woman-default.jpg';
    if (name) name.textContent = voice ? cleanVoiceName(voice.localName || voice.displayName || voice.shortName) : '选择音色';
    if (locale) locale.textContent = voice ? (localeLabel(voice.locale) || voice.locale || '') : '';
  }

  function renderCompact() {
    const selectedVoice = voices.find(v => v.shortName === selected);
    const avatarSrc = selectedVoice ? (AVATAR_MAP[selectedVoice.gender] || 'img/woman-default.jpg') : 'img/woman-default.jpg';
    const displayName = selectedVoice ? cleanVoiceName(selectedVoice.localName || selectedVoice.displayName || selectedVoice.shortName) : '选择音色';
    const localeTxt = selectedVoice ? (localeLabel(selectedVoice.locale) || '') : '';

    container.innerHTML = `
      <button class="vp-trigger" data-action="open">
        <img class="vp-trigger-avatar" src="${avatarSrc}" alt="">
        <div class="vp-trigger-info">
          <span class="vp-trigger-name">${displayName}</span>
          <span class="vp-trigger-locale">${localeTxt}</span>
        </div>
        <span class="vp-trigger-arrow">▼</span>
      </button>
      <div class="vp-modal-overlay">
        <div class="vp-modal-panel">
          <div class="vp-filter-bar">
            ${renderFilterBarHTML()}
          </div>
          <div class="vp-grid"></div>
          <div class="vp-modal-footer">
            <button class="vp-modal-cancel">取消</button>
            <button class="vp-modal-confirm">确认选择</button>
          </div>
        </div>
      </div>
    `;

    renderGrid();
    bindFilterEvents();

    container.querySelector('[data-action="open"]').addEventListener('click', () => openModal());
    container.querySelector('.vp-modal-overlay').addEventListener('click', (e) => {
      if (e.target === container.querySelector('.vp-modal-overlay')) closeModal();
    });
    container.querySelector('.vp-modal-cancel').addEventListener('click', () => cancelSelection());
    container.querySelector('.vp-modal-confirm').addEventListener('click', () => confirmSelection());
  }

  function renderFull() {
    container.innerHTML = `
      <div class="vp-filter-bar">
        ${renderFilterBarHTML()}
      </div>
      <div class="vp-grid"></div>
    `;
    renderGrid();
    bindFilterEvents();
  }

  function renderFilterBarHTML() {
    const groups = getLocaleGroups();

    const localeHTML = groups.map(g =>
      `<span class="tag${filterLocaleGroup === g.id ? ' active' : ''}" data-locale-group="${g.id}">${g.label} (${g.count})</span>`
    ).join('');

    let subLocaleHTML = '';
    if (filterLocaleGroup !== 'all' && getActiveSubLocales().length > 0) {
      subLocaleHTML = `
      <div class="vp-filter-rows">
        <div class="vp-filter-group">
          <span class="vp-filter-label">子类</span>
          <span class="tag${filterLocaleSub === null ? ' active' : ''}" data-locale-sub="">全部</span>
          ${getActiveSubLocales().map(([key, { label, count }]) =>
            `<span class="tag${filterLocaleSub === key ? ' active' : ''}" data-locale-sub="${key}">${label} (${count})</span>`
          ).join('')}
        </div>
      </div>`;
    }

    return `
      <input class="vp-filter-search" type="text" placeholder="搜索音色..." value="${filterText}">
      <div class="vp-filter-rows">
        <div class="vp-filter-group">
          <span class="vp-filter-label">语种</span>
          ${localeHTML}
        </div>
      </div>
      ${subLocaleHTML}
      <div class="vp-filter-rows vp-filter-rows-spaced">
        <div class="vp-filter-group">
          <span class="vp-filter-label">性别</span>
          <span class="tag${filterGender === 'all' ? ' active' : ''}" data-gender="all">全部</span>
          <span class="tag${filterGender === 'Female' ? ' active' : ''}" data-gender="Female">女声</span>
          <span class="tag${filterGender === 'Male' ? ' active' : ''}" data-gender="Male">男声</span>
        </div>
        <div class="vp-filter-group">
          <span class="vp-filter-label">类型</span>
          <span class="tag${filterVoiceType === 'all' ? ' active' : ''}" data-voice-type="all">全部</span>
          <span class="tag${filterVoiceType === 'hd' ? ' active' : ''}" data-voice-type="hd">高清 HD</span>
          <span class="tag${filterVoiceType === 'expressive' ? ' active' : ''}" data-voice-type="expressive">多情感</span>
          <span class="tag${filterVoiceType === 'multilingual' ? ' active' : ''}" data-voice-type="multilingual">多语言</span>
          <span class="tag${filterVoiceType === 'standard' ? ' active' : ''}" data-voice-type="standard">标准</span>
        </div>
        <button class="vp-fav-btn${showFavoritesOnly ? ' active' : ''}">❤ 收藏</button>
      </div>
    `;
  }

  function refreshFilterBar() {
    const bar = container.querySelector('.vp-filter-bar');
    if (!bar) return;
    bar.innerHTML = renderFilterBarHTML();
    bindFilterEvents();
    renderGrid();
  }

  function bindFilterEvents() {
    const search = container.querySelector('.vp-filter-search');
    if (search) search.addEventListener('input', () => { filterText = search.value; renderGrid(); });

    container.querySelectorAll('[data-locale-group]').forEach(el => {
      el.addEventListener('click', () => {
        filterLocaleGroup = el.dataset.localeGroup;
        filterLocaleSub = null;
        filterText = '';
        refreshFilterBar();
      });
    });
    container.querySelectorAll('[data-locale-sub]').forEach(el => {
      el.addEventListener('click', () => {
        filterLocaleSub = el.dataset.localeSub || null;
        refreshFilterBar();
      });
    });


    container.querySelectorAll('[data-gender]').forEach(el => {
      el.addEventListener('click', () => {
        container.querySelectorAll('[data-gender]').forEach(t => t.classList.remove('active'));
        el.classList.add('active');
        filterGender = el.dataset.gender;
        renderGrid();
      });
    });

    container.querySelectorAll('[data-voice-type]').forEach(el => {
      el.addEventListener('click', () => {
        container.querySelectorAll('[data-voice-type]').forEach(t => t.classList.remove('active'));
        el.classList.add('active');
        filterVoiceType = el.dataset.voiceType;
        renderGrid();
      });
    });

    const favBtn = container.querySelector('.vp-fav-btn');
    if (favBtn) favBtn.addEventListener('click', () => { showFavoritesOnly = !showFavoritesOnly; favBtn.classList.toggle('active'); renderGrid(); });
  }

  function openModal() {
    if (isOpen) return;
    pendingSelected = selected;
    isOpen = true;
    const overlay = container.querySelector('.vp-modal-overlay');
    overlay.classList.add('open');
    renderGrid();
    document.addEventListener('keydown', handleKeydown);
  }

  function closeModal() {
    isOpen = false;
    const overlay = container.querySelector('.vp-modal-overlay');
    if (overlay) overlay.classList.remove('open');
    document.removeEventListener('keydown', handleKeydown);
  }

  function confirmSelection() {
    if (selected !== pendingSelected) {
      selected = pendingSelected;
      updateTrigger();
      if (onSelect) onSelect(selected);
    }
    closeModal();
  }

  function cancelSelection() {
    pendingSelected = selected;
    closeModal();
  }

  function handleKeydown(e) {
    if (e.key === 'Escape') cancelSelection();
    if (e.key === 'Enter') confirmSelection();
  }

  function render() {
    if (mode === 'full') renderFull();
    else renderCompact();
  }

  function getSelected() { return selected; }
  function setSelected(value) { selected = value; render(); }

  function update(newVoices, newFavorites) {
    voices = newVoices || voices;
    favorites = newFavorites || favorites;
    const oldSelectedExists = voices.some(v => v.shortName === selected);
    if (!oldSelectedExists && voices.length) selected = voices[0].shortName;
    render();
  }

  function refreshFavorites(newFavorites) {
    favorites = newFavorites;
    container.querySelectorAll('.vp-card').forEach((card) => {
      const shortName = card.dataset.shortName;
      const btn = card.querySelector('.vp-card-fav-btn');
      if (!btn) return;
      const isFav = favorites.includes(shortName);
      btn.classList.toggle('favorited', isFav);
      btn.textContent = isFav ? '❤' : '♡';
      btn.title = isFav ? '取消收藏' : '收藏';
    });
    if (showFavoritesOnly) renderGrid();
  }

  function destroy() {
    closeModal();
    container.innerHTML = '';
  }

  render();
  return { getSelected, setSelected, update, refreshFavorites, destroy, useVoices };
}

// ─── Favorites ───

async function toggleFavorite(shortName) {
  try {
    const favorites = await window.momoVoiceSub.toggleFavorite(shortName);
    state.settings.favoriteVoices = favorites;
    for (const key of Object.keys(voicePickers)) {
      voicePickers[key].refreshFavorites(favorites);
    }
  } catch (error) {
    log(`收藏失败: ${friendlyErrorMessage(error)}`);
    showToast(`收藏失败: ${friendlyErrorMessage(error)}`, 'error');
  }
}

// ─── Track Tags ───

function populateTrackTags() {
  const trackContainer = $('subtitleTrackTags');
  if (trackContainer) trackContainer.innerHTML = '';

  if (!state.subtitleTracks.length) {
    const emptyTag = tag('无字幕轨', 'empty', true);
    emptyTag.classList.add('tag-disabled');
    emptyTag.style.pointerEvents = 'none';
    if (trackContainer) trackContainer.appendChild(emptyTag);
  }

  for (const track of state.subtitleTracks) {
    const t = tag(`${track.name || '字幕轨'} (${track.itemCount}条)`, String(track.index), state.selectedSubtitleTrack === String(track.index));
    t.addEventListener('click', () => {
      if (trackContainer) trackContainer.querySelectorAll('.tag').forEach(el => el.classList.remove('active'));
      t.classList.add('active');
      state.selectedSubtitleTrack = t.dataset.value;
      loadSubtitleTable();
      updateImportSrtBtnVisibility();
    });
    if (trackContainer) trackContainer.appendChild(t);
  }
  // 已导入 SRT 时，在末尾追加「本地SRT」标签（作为虚拟字幕源，点击切换查看）
  if (state.srtItems && state.srtItems.length) {
    const srtTag = tag('📄 本地SRT', 'srt', state.selectedSubtitleTrack === 'srt');
    srtTag.addEventListener('click', () => {
      if (trackContainer) trackContainer.querySelectorAll('.tag').forEach(el => el.classList.remove('active'));
      srtTag.classList.add('active');
      switchToSrtMode();
    });
    if (trackContainer) trackContainer.appendChild(srtTag);
  }
  if (state.selectedSubtitleTrack && trackContainer && !trackContainer.querySelector('.active')) {
    state.selectedSubtitleTrack = null;
  }
  updateImportSrtBtnVisibility();

  const audioContainer = $('subtitleAudioTrackTags');
  if (audioContainer) audioContainer.innerHTML = '';
  const autoTag = tag('自动', 'auto', state.selectedAudioTrack === 'auto');
  autoTag.addEventListener('click', () => {
    if (audioContainer) audioContainer.querySelectorAll('.tag').forEach(el => el.classList.remove('active'));
    autoTag.classList.add('active');
    state.selectedAudioTrack = 'auto';
  });
  if (audioContainer) audioContainer.appendChild(autoTag);
  for (const track of state.audioTracks) {
    const val = String(track.index);
    const t = tag(`${track.name || 'Audio'}`, val, state.selectedAudioTrack === val);
    t.addEventListener('click', () => {
      if (audioContainer) audioContainer.querySelectorAll('.tag').forEach(el => el.classList.remove('active'));
      t.classList.add('active');
      state.selectedAudioTrack = val;
    });
    if (audioContainer) audioContainer.appendChild(t);
  }

  const overwriteContainer = $('subtitleOverwriteTags');
  if (overwriteContainer) overwriteContainer.innerHTML = '';
  for (const opt of OVERWRITE_OPTIONS) {
    const t = tag(opt.label, opt.value, state.selectedOverwrite === opt.value);
    t.addEventListener('click', () => {
      if (overwriteContainer) overwriteContainer.querySelectorAll('.tag').forEach(el => el.classList.remove('active'));
      t.classList.add('active');
      state.selectedOverwrite = t.dataset.value;
    });
    if (overwriteContainer) overwriteContainer.appendChild(t);
  }

  // 手动配音界面：音频轨 + 覆盖策略（与自动配音界面选项一致，仅无字幕轨）
  const manualAudioContainer = $('manualAudioTrackTags');
  if (manualAudioContainer) manualAudioContainer.innerHTML = '';
  const manualAutoTag = tag('自动', 'auto', state.selectedManualAudioTrack === 'auto');
  manualAutoTag.addEventListener('click', () => {
    if (manualAudioContainer) manualAudioContainer.querySelectorAll('.tag').forEach(el => el.classList.remove('active'));
    manualAutoTag.classList.add('active');
    state.selectedManualAudioTrack = 'auto';
  });
  if (manualAudioContainer) manualAudioContainer.appendChild(manualAutoTag);
  for (const track of state.audioTracks) {
    const val = String(track.index);
    const t = tag(`${track.name || 'Audio'}`, val, state.selectedManualAudioTrack === val);
    t.addEventListener('click', () => {
      if (manualAudioContainer) manualAudioContainer.querySelectorAll('.tag').forEach(el => el.classList.remove('active'));
      t.classList.add('active');
      state.selectedManualAudioTrack = val;
    });
    if (manualAudioContainer) manualAudioContainer.appendChild(t);
  }

  const manualOverwriteContainer = $('manualOverwriteTags');
  if (manualOverwriteContainer) manualOverwriteContainer.innerHTML = '';
  for (const opt of OVERWRITE_OPTIONS) {
    const t = tag(opt.label, opt.value, state.selectedManualOverwrite === opt.value);
    t.addEventListener('click', () => {
      if (manualOverwriteContainer) manualOverwriteContainer.querySelectorAll('.tag').forEach(el => el.classList.remove('active'));
      t.classList.add('active');
      state.selectedManualOverwrite = t.dataset.value;
    });
    if (manualOverwriteContainer) manualOverwriteContainer.appendChild(t);
  }
}

// ─── Subtitle Table ───

function updateImportSrtBtnVisibility() {
  const btn = $('subtitleImportSrtBtn');
  if (!btn) return;
  // 无论当前项目是否有字幕轨，都显示「导入SRT」按钮。
  // 已有字幕轨时，仍可用 SRT 作为另一字幕源；再次导入会替换之前导入的 SRT。
  btn.classList.remove('hidden');
}

function switchToSrtMode() {
  state.selectedSubtitleTrack = 'srt';
  state.loadedSubtitleTrack = 'srt';
  state.subtitleItems = (state.srtItems || []).slice();
  state.subtitleAnnotations = new Map();
  state.disabledFrames = new Set();
  for (const item of state.subtitleItems) {
    state.subtitleAnnotations.set(item.startFrame, JSON.parse(JSON.stringify(item.annotations || [])));
  }
  renderSubtitleTable();
  updateImportSrtBtnVisibility();
}

async function importSrtFile() {
  try {
    const result = await window.momoVoiceSub.importSrt();
    if (!result || !result.items || !result.items.length) {
      // 用户取消文件选择
      return;
    }
    state.srtItems = result.items;
    state.srtFileName = result.fileName || '';
    switchToSrtMode();
    // 刷新字幕轨区，显示「本地SRT」标签
    populateTrackTags();
    showToast(`SRT 导入成功：${result.items.length} 条字幕${state.srtFileName ? `（${state.srtFileName}）` : ''}`, 'ok');
  } catch (error) {
    log(`SRT 导入失败: ${friendlyErrorMessage(error)}`);
    showToast(`SRT 导入失败: ${friendlyErrorMessage(error)}`, 'error');
  }
}

async function loadSubtitleTable() {
  const wrap = $('subtitleTable');
  if (!state.selectedSubtitleTrack) {
    wrap.innerHTML = '<div class="table-placeholder">请选择字幕轨</div>';
    return;
  }
  // SRT 模式：字幕列表由 switchToSrtMode/importSrtFile 负责渲染，此处直接返回
  if (state.selectedSubtitleTrack === 'srt') {
    return;
  }
  try {
    // 仅在切换字幕轨时重置禁用集合，同一字幕轨的多次加载（如生成完成后刷新）应保留禁用状态
    const trackChanged = state.loadedSubtitleTrack !== state.selectedSubtitleTrack;
    const freshItems = await window.momoVoiceSub.getSubtitleItems(Number(state.selectedSubtitleTrack));

    if (trackChanged) {
      // 切换到新字幕轨：完全使用 DR 返回的数据
      state.subtitleItems = freshItems;
      state.subtitleAnnotations = new Map();
      state.disabledFrames = new Set();
    } else {
      // 同一字幕轨刷新（如配音完成后自动刷新）：
      // DR 返回的是纯文本，若直接覆盖会丢失 item.text 中内联的 [拼音] / [pause:] 标注。
      // 以 DR 返回的结构（帧号、时间码等）为准，但若本地已有标注/编辑过的文本则保留。
      const oldByFrame = new Map();
      for (const old of state.subtitleItems) {
        oldByFrame.set(old.startFrame, old);
      }
      state.subtitleItems = freshItems.map(fresh => {
        const old = oldByFrame.get(fresh.startFrame);
        if (old && old.text && old.text !== fresh.text) {
          // 本地文本与 DR 返回不同 → 用户在插件内做过纠音标注或编辑，保留本地版本
          return { ...fresh, text: old.text };
        }
        return fresh;
      });
    }

    state.loadedSubtitleTrack = state.selectedSubtitleTrack;
    state.subtitleAnnotations = new Map();
    for (const item of state.subtitleItems) {
      state.subtitleAnnotations.set(item.startFrame, JSON.parse(JSON.stringify(item.annotations || [])));
    }
    renderSubtitleTable();
  } catch (error) {
    wrap.innerHTML = `<div class="table-placeholder error">加载失败: ${friendlyErrorMessage(error)}</div>`;
    log(friendlyErrorMessage(error));
  }
}

function renderSubtitleTable() {
  const wrap = $('subtitleTable');
  if (!state.subtitleItems.length) {
    const placeholderMsg = state.selectedSubtitleTrack === 'srt'
      ? '请点击上方「📂 导入SRT」按钮选择字幕文件'
      : '该字幕轨没有字幕';
    wrap.innerHTML = `<div class="table-placeholder">${placeholderMsg}</div>`;
    return;
  }

  // 1. 不再在渲染时强制激活第一行，保留"未选中任何行"的整轨状态
  const hasActive = state.subtitleItems.some(item => item.startFrame === activeSubtitleFrame);
  if (!hasActive) {
    activeSubtitleFrame = null;
  }

  let html = '<table class="subtitle-table"><thead><tr><th class="subtitle-index">#</th><th class="subtitle-timecode">时间码</th><th class="subtitle-text">文本</th></tr></thead><tbody>';
  for (const item of state.subtitleItems) {
    const tc = framesToTimecode(item.startFrame);
    const isActive = activeSubtitleFrame === item.startFrame;
    const isDisabled = state.disabledFrames.has(item.startFrame);
    const rowClass = [isActive ? 'is-active-row' : '', isDisabled ? 'is-disabled-row' : ''].filter(Boolean).join(' ');
    
    // 渲染时只将不含中括号等标记的纯净汉字填入 textarea 视图中，确保打字无光标漂移
    const { cleanText } = parseTextAndGenerateAnnotations(item.text);
    
    html += `<tr data-frame="${item.startFrame}" class="${rowClass}" title="右键以临时 禁用/启用 此列">
       <td class="subtitle-index">${item.index + 1}</td>
       <td class="subtitle-timecode">${tc}</td>
       <td class="subtitle-text">
         <div class="sub-textarea-wrap">
           <textarea class="subtitle-text-input" spellcheck="false" title="" data-frame="${item.startFrame}"${isDisabled ? ' disabled' : ''}>${escapeHtml(cleanText)}</textarea>
         </div>
         <!-- 字幕行内效果效果预览卡片，默认隐藏，只有需要它显示时才按需显示 -->
         <div class="subtitle-preview-box hidden" title="" data-frame="${item.startFrame}"></div>
       </td>
     </tr>`;
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;

  // 右键行（非文本输入区域）切换禁用/启用状态
  wrap.querySelectorAll('tr[data-frame]').forEach(row => {
    row.addEventListener('contextmenu', (e) => {
      // 如果点击的是 textarea 或预览区域，不做切换
      if (e.target.closest('.subtitle-text-input') || e.target.closest('.subtitle-preview-box')) {
        return;
      }
      e.preventDefault();
      const frame = Number(row.dataset.frame);
      if (state.disabledFrames.has(frame)) {
        state.disabledFrames.delete(frame);
      } else {
        state.disabledFrames.add(frame);
      }
      // 抑制 re-render 期间浏览器自动 focus textarea 导致的"第x行"误触发
      suppressActivation = true;
      renderSubtitleTable();
      // 延迟一帧解除抑制，确保异步 focus 事件也被拦截
      setTimeout(() => { suppressActivation = false; }, 0);
    });
  });

  wrap.querySelectorAll('.subtitle-text-input').forEach(textarea => {
    const frame = Number(textarea.dataset.frame);
    const hl = wrap.querySelector(`.subtitle-preview-box[data-frame="${frame}"]`);
    const item = state.subtitleItems.find(s => s.startFrame === frame);
    
    // 初始化高亮
    updateSubtitleHighlighter(textarea, hl);

    textarea.addEventListener('input', () => {
      activeSubtitleFrame = frame;
      const newPlain = textarea.value;
      if (item) {
        item.text = syncAnnotatedText(item.text, newPlain);
      }
      updateSubtitleHighlighter(textarea, hl);
    });

    // 绑定多重事件（focus、click、select），确保在用户进行点击、选中文字或打字时，100% 正确激活对应行
    const activateRow = () => {
      // 渲染期间（如右键禁用触发的 re-render）浏览器可能自动 focus 新 textarea，需抑制
      if (suppressActivation) return;
      activeSubtitleFrame = frame;
      wrap.querySelectorAll('tr').forEach(r => r.classList.remove('is-active-row'));
      const row = textarea.closest('tr');
      if (row) row.classList.add('is-active-row');
      updateSubtitleToolbar();
    };

    textarea.addEventListener('focus', activateRow);
    textarea.addEventListener('click', activateRow);
    textarea.addEventListener('select', activateRow);
    
    // 绑定字幕预览区的点击事件委托，实现极致的一键撤销与重新弹窗修改
    if (hl) {
      hl.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.ann-remove');
        const polyTag = e.target.closest('.poly-highlight');
        const pauseTag = e.target.closest('.ann-pause');
        
        if (removeBtn) {
          // 1. 点击了右上角微型 "×" 按钮，直接撤销抹除该标注
          e.stopPropagation();
          const idx = parseInt(removeBtn.dataset.idx, 10);
          if (item) {
            item.text = removeAnnotationByIndex(item.text, idx);
            const { cleanText } = parseTextAndGenerateAnnotations(item.text);
            textarea.value = cleanText;
            updateSubtitleHighlighter(textarea, hl);
            showToast('已撤销配置', 'ok');
          }
        } else if (polyTag) {
          // 2. 点击了多音字标签本身，重新弹出拼音选择弹窗修改
          const idx = parseInt(polyTag.dataset.idx, 10);
          const char = polyTag.textContent.slice(0, 1);
          openPolyPopup({
            title: `修改「${char}」的读音`,
            char,
            onSelect: (entry) => {
              const phonetic = entry.phonetic || entry.pinyin;
              if (item) {
                item.text = updateAnnotationByIndex(item.text, idx, phonetic);
                const { cleanText } = parseTextAndGenerateAnnotations(item.text);
                textarea.value = cleanText;
                updateSubtitleHighlighter(textarea, hl);
                showToast(`发音已修改为 ${entry.pinyin}`, 'ok');
              }
              $('polyPopup').classList.add('hidden');
            }
          });
        } else if (pauseTag) {
          // 3. 点击了停顿标签本身，重新弹出停顿选择弹窗修改
          const idx = parseInt(pauseTag.dataset.idx, 10);
          openPausePopup((duration) => {
            const durMs = Number.parseInt(duration, 10) || 500;
            if (item) {
              item.text = updateAnnotationByIndex(item.text, idx, durMs);
              const { cleanText } = parseTextAndGenerateAnnotations(item.text);
              textarea.value = cleanText;
              updateSubtitleHighlighter(textarea, hl);
              showToast(`停顿时间已修改为 ${durMs}ms`, 'ok');
            }
          });
        }
      });
    }
  });

  // 点击表格非文本输入区域 → 回到整轨模式
  wrap.addEventListener('click', (e) => {
    if (e.target.closest('.subtitle-text-input') || e.target.closest('.subtitle-preview-box')) return;
    if (activeSubtitleFrame !== null) {
      activeSubtitleFrame = null;
      suppressActivation = true;
      renderSubtitleTable();
      setTimeout(() => { suppressActivation = false; }, 0);
    }
  });

  // 3. 更新模式指示器与禁用按钮状态（按钮为静态 HTML 元素，此处仅更新文本/可见性）
  updateSubtitleToolbar();
}

function updateSubtitleToolbar() {
  const disableBtn = $('subtitleDisableAllBtn');
  const modeLabel = $('subtitleModeLabel');

  if (!disableBtn || !modeLabel) return;

  // 全部禁用按钮文字切换
  const allDisabled = state.disabledFrames.size === state.subtitleItems.length && state.subtitleItems.length > 0;
  if (allDisabled) {
    disableBtn.innerHTML = '✅ 全部启用';
    disableBtn.title = '取消禁用所有字幕条目';
  } else {
    disableBtn.innerHTML = '🚫 全部禁用';
    disableBtn.title = '一键禁用所有字幕条目，之后可单独右键行序号/时间码启用需要的条目';
  }

  // 模式指示器：始终显示当前是整轨还是单行模式
  if (activeSubtitleFrame !== null && activeSubtitleFrame !== undefined) {
    const item = state.subtitleItems.find(s => s.startFrame === activeSubtitleFrame);
    const idx = item ? item.index + 1 : '?';
    modeLabel.textContent = `📍 第${idx}行`;
    modeLabel.title = '当前操作仅针对该行字幕，点击此处返回整轨模式';
    modeLabel.classList.add('is-active-mode');
  } else {
    modeLabel.textContent = '📋 整轨';
    modeLabel.title = '纠音/停顿操作将对整轨字幕生效，右键行序号/时间码可禁用该行';
    modeLabel.classList.remove('is-active-mode');
  }
}

function toggleDisableAll() {
  if (state.disabledFrames.size === state.subtitleItems.length) {
    state.disabledFrames = new Set();
  } else {
    state.disabledFrames = new Set(state.subtitleItems.map(item => item.startFrame));
  }
  renderSubtitleTable();
}

function framesToTimecode(frames) {
  const fps = 24;
  const h = Math.floor(frames / (3600 * fps));
  const m = Math.floor((frames % (3600 * fps)) / (60 * fps));
  const s = Math.floor((frames % (60 * fps)) / fps);
  const f = frames % fps;
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
}

function pad(n) { return String(n).padStart(2, '0'); }

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Polyphonic Popup ───

function openPolyPopup(options) {
  const { title, char, onSelect, globalOption } = options;
  $('polyPopupTitle').textContent = title || '选择读音';
  const body = $('polyPopupBody');
  const entries = findPolyEntries(char);
  if (!entries.length) {
    body.innerHTML = `<div class="poly-popup-empty">未找到「${char}」的多音字记录</div>`;
  } else {
    body.innerHTML = '<div class="poly-popup-options">' +
      entries.map((e, i) =>
        `<div class="poly-popup-option" data-pinyin="${e.pinyin}" data-phonetic="${e.phonetic}">
          <div>
            <span class="poly-opt-pinyin">${e.pinyin}</span>
            <span class="poly-opt-context">（${e.context || ''}）</span>
          </div>
          <span class="poly-opt-select">选择</span>
        </div>`
      ).join('') + '</div>';

    body.querySelectorAll('.poly-popup-option').forEach(el => {
      el.addEventListener('click', () => {
        body.querySelectorAll('.poly-popup-option').forEach(o => o.classList.remove('selected'));
        el.classList.add('selected');
        const selectedEntry = entries[Array.from(el.parentNode.children).indexOf(el)];
        const isGlobal = $('polyPopupGlobal') ? $('polyPopupGlobal').checked : false;
        if (onSelect) onSelect(selectedEntry, isGlobal);
      });
    });
  }

  const globalRow = $('polyPopupGlobal');
  if (globalRow) {
    globalRow.checked = false;
    globalRow.parentElement.style.display = globalOption !== undefined ? 'flex' : 'none';
  }

  $('polyPopup').classList.remove('hidden');
  $('polyPopupClose').onclick = () => $('polyPopup').classList.add('hidden');
}

function openPausePopup(onSelect) {
  const body = $('pausePopup').querySelector('.popup-body');
  body.innerHTML = '<div class="pause-options">' +
    PAUSE_MS_OPTIONS.map(opt =>
      `<button class="btn btn-sm btn-outline" data-pause="${opt.value}">${opt.label}</button>`
    ).join('') + '</div>';

  body.querySelectorAll('[data-pause]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (onSelect) onSelect(btn.dataset.pause);
      $('pausePopup').classList.add('hidden');
    });
  });

  $('pausePopup').classList.remove('hidden');
  $('pausePopupClose').onclick = () => $('pausePopup').classList.add('hidden');
}

function parseTextToTokens(text) {
  const tokens = [];
  const regex = /(.)\[([a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ1-4\s]+)\]/g;
  let match;
  const matches = [];
  while ((match = regex.exec(text)) !== null) {
    matches.push({
      start: match.index,
      end: regex.lastIndex,
      char: match[1],
      phonetic: match[2]
    });
  }
  
  const allDict = getPolyphonicDict();
  const polySet = new Set(allDict.map(e => e.char));
  
  let lastIdx = 0;
  for (const m of matches) {
    if (m.start > lastIdx) {
      const part = text.slice(lastIdx, m.start);
      for (const char of part) {
        tokens.push({
          char,
          isPoly: polySet.has(char),
          isCorrected: false,
          phonetic: ''
        });
      }
    }
    tokens.push({
      char: m.char,
      isPoly: true,
      isCorrected: true,
      phonetic: m.phonetic
    });
    lastIdx = m.end;
  }
  
  if (lastIdx < text.length) {
    const part = text.slice(lastIdx);
    for (const char of part) {
      tokens.push({
        char,
        isPoly: polySet.has(char),
        isCorrected: false,
        phonetic: ''
      });
    }
  }
  
  return tokens;
}

// ─── 通用多音字与停顿业务处理逻辑 ───

function handleSingleCorrect(ta) {
  if (!ta) return;
  const plainStart = ta.selectionStart;
  const plainEnd = ta.selectionEnd;
  if (plainStart === plainEnd) {
    log('请先在文本中选中要纠音的字');
    showToast('请先在文本中选中要纠音的字', 'info');
    return;
  }
  const selectedText = ta.value.slice(plainStart, plainEnd).trim();
  if (selectedText.length !== 1) {
    log('请选择单个汉字进行纠音');
    showToast('请选择单个汉字进行纠音', 'info');
    return;
  }

  const allDict = getPolyphonicDict();
  const matches = allDict.filter(e => e.char === selectedText);
  if (!matches.length) {
    log(`「${selectedText}」未找到多音字记录，可先在设置中添加`);
    showToast(`「${selectedText}」未找到多音字记录，可先先在设置中添加`, 'info');
    return;
  }

  const char = selectedText;
  openPolyPopup({
    title: `选择「${char}」的读音`,
    char,
    onSelect: (entry) => {
      const phonetic = entry.phonetic || entry.pinyin;
      
      // 1. 兼容获取对应的底层标注完整数据
      let annotatedText = "";
      let isManual = (ta.id === 'manualText');
      let item = null;
      let frame = null;
      
      if (isManual) {
        annotatedText = state.manualTextWithAnnotations || ta.value;
      } else {
        frame = Number(ta.dataset.frame);
        item = state.subtitleItems.find(s => s.startFrame === frame);
        annotatedText = item ? item.text : ta.value;
      }
      
      const start = getAnnotatedPos(annotatedText, plainStart);
      const end = getAnnotatedPos(annotatedText, plainEnd);
      const before = annotatedText.slice(0, end);
      const after = annotatedText.slice(end);
      
      const nextMatch = after.match(/^\[([a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ1-4\s]+)\]/);
      let newVal = "";
      if (nextMatch) {
        newVal = before + `[${phonetic}]` + after.slice(nextMatch[0].length);
      } else {
        newVal = before + `[${phonetic}]` + after;
      }
      
      // 2. 存回各自的底层变量中
      if (isManual) {
        state.manualTextWithAnnotations = newVal;
      } else if (item) {
        item.text = newVal;
      }
      
      // 3. 将剥离标记后的干净普通汉字刷入文本框视图
      const { cleanText } = parseTextAndGenerateAnnotations(newVal);
      ta.value = cleanText;
      
      // 4. 完美保持用户的汉字选择选区
      ta.setSelectionRange(plainStart, plainEnd);
      
      // 5. 条件触发高亮层预览刷新
      if (isManual) {
        updateManualHighlighter();
      } else {
        const hl = document.querySelector(`.subtitle-preview-box[data-frame="${frame}"]`);
        if (hl) updateSubtitleHighlighter(ta, hl);
      }
      
      log(`已标注「${char}」读音为 ${entry.pinyin}`);
      showToast(`已标注「${char}」读音为 ${entry.pinyin}`, 'ok');
      $('polyPopup').classList.add('hidden');
    }
  });
}

function handleBatchCorrect(ta) {
  if (!ta) return;
  const text = ta.value;
  if (!text) {
    log('请先输入文本');
    showToast('请先输入文本', 'info');
    return;
  }

  const allDict = getPolyphonicDict();
  const polySet = new Set(allDict.map(e => e.char));
  
  let hasPoly = false;
  for (const char of text) {
    if (polySet.has(char)) {
      hasPoly = true;
      break;
    }
  }
  if (!hasPoly) {
    log('文本中未检测到已知多音字');
    showToast('文本中未检测到已知多音字', 'info');
    return;
  }
  const container = $('batchCorrectContent');
  if (!container) return;
  container.innerHTML = '';
  
  const tokens = parseTextToTokens(text);
  tokens.forEach((tok) => {
    const span = document.createElement('span');
    span.textContent = tok.isCorrected ? `${tok.char}[${tok.phonetic}]` : tok.char;
    
    if (tok.isPoly) {
      span.className = 'batch-poly-char' + (tok.isCorrected ? ' is-corrected' : '');
      span.addEventListener('click', () => {
        openPolyPopup({
          title: `选择「${tok.char}」的读音`,
          char: tok.char,
          onSelect: (entry) => {
            const phonetic = entry.phonetic || entry.pinyin;
            tok.isCorrected = true;
            tok.phonetic = phonetic;
            
            span.textContent = `${tok.char}[${phonetic}]`;
            span.classList.add('is-corrected');
            $('polyPopup').classList.add('hidden');
          }
        });
      });
    }
    container.appendChild(span);
  });

  const popup = $('batchCorrectPopup');
  popup.classList.remove('hidden');

  $('batchCorrectClose').onclick = () => popup.classList.add('hidden');
  
  $('batchCorrectConfirm').onclick = () => {
    let resultText = '';
    tokens.forEach(tok => {
      if (tok.isCorrected) {
        resultText += `${tok.char}[${tok.phonetic}]`;
      } else {
        resultText += tok.char;
      }
    });
    
    if (ta.id === 'manualText') {
      state.manualTextWithAnnotations = resultText;
      const { cleanText } = parseTextAndGenerateAnnotations(resultText);
      ta.value = cleanText;
      updateManualHighlighter();
    } else {
      const frame = Number(ta.dataset.frame);
      const item = state.subtitleItems.find(s => s.startFrame === frame);
      if (item) {
        item.text = resultText;
      }
      const { cleanText } = parseTextAndGenerateAnnotations(resultText);
      ta.value = cleanText;
      const hl = document.querySelector(`.subtitle-preview-box[data-frame="${frame}"]`);
      if (hl) updateSubtitleHighlighter(ta, hl);
    }
    
    popup.classList.add('hidden');
    log('批量多音字纠音已成功写入文本框！');
    showToast('批量多音字纠音已成功写入文本框', 'ok');
  };
}

function handleSubtitleTrackBatchCorrect() {
  if (!state.subtitleItems || !state.subtitleItems.length) {
    log('字幕列表为空，无法进行批量纠音');
    showToast('字幕列表为空，无法进行批量纠音', 'info');
    return;
  }

  // 1. 解析每行的 tokens，并检查是否有至少一个多音字
  const rowsData = state.subtitleItems.map((item, index) => {
    return {
      item,
      index,
      tokens: parseTextToTokens(item.text)
    };
  });

  let hasPoly = false;
  for (const row of rowsData) {
    if (row.tokens.some(tok => tok.isPoly)) {
      hasPoly = true;
      break;
    }
  }

  if (!hasPoly) {
    log('整轨字幕中未检测到已知多音字');
    showToast('整轨字幕中未检测到已知多音字', 'info');
    return;
  }

  const container = $('batchCorrectContent');
  if (!container) return;
  container.innerHTML = '';

  // 3. 过滤并只渲染含有已知多音字的项目行，节省空间并消除视觉疲劳
  const filteredRows = rowsData.filter(row => row.tokens.some(tok => tok.isPoly));
  
  filteredRows.forEach((rowData) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'batch-correct-row';

    const label = document.createElement('div');
    label.className = 'batch-correct-row-label';
    label.textContent = `第 ${rowData.index + 1} 行`;
    rowEl.appendChild(label);

    const wordsContainer = document.createElement('div');
    wordsContainer.className = 'batch-correct-row-words';

    rowData.tokens.forEach((tok) => {
      const span = document.createElement('span');
      span.textContent = tok.isCorrected ? `${tok.char}[${tok.phonetic}]` : tok.char;

      if (tok.isPoly) {
        span.className = 'batch-poly-char' + (tok.isCorrected ? ' is-corrected' : '');
        span.addEventListener('click', () => {
          openPolyPopup({
            title: `选择「${tok.char}」的读音`,
            char: tok.char,
            onSelect: (entry) => {
              const phonetic = entry.phonetic || entry.pinyin;
              tok.isCorrected = true;
              tok.phonetic = phonetic;

              span.textContent = `${tok.char}[${phonetic}]`;
              span.classList.add('is-corrected');
              $('polyPopup').classList.add('hidden');
            }
          });
        });
      }
      wordsContainer.appendChild(span);
    });

    rowEl.appendChild(wordsContainer);
    container.appendChild(rowEl);
  });

  const popup = $('batchCorrectPopup');
  popup.classList.remove('hidden');

  $('batchCorrectClose').onclick = () => popup.classList.add('hidden');

  $('batchCorrectConfirm').onclick = () => {
    // 4. 用户点击确定，将修改后带标注的文本精确回写到各行对应的底层数据中，并同步视图与预览高亮
    rowsData.forEach((rowData) => {
      let resultText = '';
      rowData.tokens.forEach((tok) => {
        if (tok.isCorrected) {
          resultText += `${tok.char}[${tok.phonetic}]`;
        } else {
          resultText += tok.char;
        }
      });

      // 回写底层数据
      rowData.item.text = resultText;

      // 刷新对应行的文本框内容
      const frame = rowData.item.startFrame;
      const ta = document.querySelector(`.subtitle-text-input[data-frame="${frame}"]`);
      if (ta) {
        const { cleanText } = parseTextAndGenerateAnnotations(resultText);
        ta.value = cleanText;

        // 刷新对应行的高亮预览层
        const hl = document.querySelector(`.subtitle-preview-box[data-frame="${frame}"]`);
        if (hl) {
          updateSubtitleHighlighter(ta, hl);
        }
      }
    });

    popup.classList.add('hidden');
    log('整轨批量多音字纠音已成功写入各字幕行！');
    showToast('整轨批量纠音已成功写入各字幕行', 'ok');
  };
}

function handleInsertPause(ta) {
  if (!ta) return;
  const plainPos = ta.selectionStart;
  openPausePopup((duration) => {
    const durMs = Number.parseInt(duration, 10) || 500;
    
    // 1. 获取对应的底层带标记完整文本
    let annotatedText = "";
    let isManual = (ta.id === 'manualText');
    let item = null;
    let frame = null;
    
    if (isManual) {
      annotatedText = state.manualTextWithAnnotations || ta.value;
    } else {
      frame = Number(ta.dataset.frame);
      item = state.subtitleItems.find(s => s.startFrame === frame);
      annotatedText = item ? item.text : ta.value;
    }
    
    const pos = getAnnotatedPos(annotatedText, plainPos);
    const before = annotatedText.slice(0, pos);
    const after = annotatedText.slice(pos);
    const newVal = before + `[pause:${durMs}]` + after;
    
    // 2. 存回对应位置
    if (isManual) {
      state.manualTextWithAnnotations = newVal;
    } else if (item) {
      item.text = newVal;
    }
    
    // 3. 将剥离标记后的干净文本填入文本框
    const { cleanText } = parseTextAndGenerateAnnotations(newVal);
    ta.value = cleanText;
    ta.setSelectionRange(plainPos, plainPos);
    
    // 4. 条件触发预览刷新
    if (isManual) {
      updateManualHighlighter();
    } else {
      const hl = document.querySelector(`.subtitle-preview-box[data-frame="${frame}"]`);
      if (hl) updateSubtitleHighlighter(ta, hl);
    }
    
    log(`已在位置 ${plainPos} 插入停顿标记：[pause:${durMs}]`);
    showToast(`已插入停顿 ${durMs}ms`, 'ok');
  });
}

// ─── 手动配音操作映射 ───

function handleManualSingleCorrect() {
  handleSingleCorrect($('manualText'));
}

function handleManualBatchCorrect() {
  handleBatchCorrect($('manualText'));
}

function handleManualInsertPause() {
  handleInsertPause($('manualText'));
}

// ─── 自动配音操作映射 ───

function handleSubtitleSingleCorrect() {
  if (activeSubtitleFrame === null || activeSubtitleFrame === undefined) {
    log('请先在字幕列表中点击选择要纠音的字幕行');
    showToast('请先在字幕列表中点击选择要纠音的字幕行', 'info');
    return;
  }
  const ta = document.querySelector(`.subtitle-text-input[data-frame="${activeSubtitleFrame}"]`);
  if (ta) {
    handleSingleCorrect(ta);
  }
}

function handleSubtitleBatchCorrect() {
  if (activeSubtitleFrame === null || activeSubtitleFrame === undefined) {
    handleSubtitleTrackBatchCorrect();
    return;
  }
  const ta = document.querySelector(`.subtitle-text-input[data-frame="${activeSubtitleFrame}"]`);
  if (ta) {
    handleBatchCorrect(ta);
  }
}

function handleSubtitleInsertPause() {
  if (activeSubtitleFrame === null || activeSubtitleFrame === undefined) {
    log('请先在字幕列表中点击选择要插入停顿的字幕行');
    showToast('请先在字幕列表中点击选择要插入停顿的字幕行', 'info');
    return;
  }
  const ta = document.querySelector(`.subtitle-text-input[data-frame="${activeSubtitleFrame}"]`);
  if (ta) {
    handleInsertPause(ta);
  }
}

// ─── Style / Role Tags ───

function stylesForVoice(shortName) {
  const voice = state.voices.find(v => v.shortName === shortName);
  return { styles: voice?.styles || [], roles: voice?.roles || [] };
}

function populateStyleTags(prefix, styles) {
  const container = $(`${prefix}StyleTags`);
  if (!container) return;
  container.innerHTML = '';
  const defaultTag = tag('默认', '', true);
  defaultTag.addEventListener('click', () => {
    container.querySelectorAll('.tag').forEach(t => t.classList.remove('active'));
    defaultTag.classList.add('active');
    onStyleChange(prefix, '');
  });
  container.appendChild(defaultTag);

  for (const style of styles) {
    const t = tag(styleCn(style), style);
    t.addEventListener('click', () => {
      container.querySelectorAll('.tag').forEach(item => item.classList.remove('active'));
      t.classList.add('active');
      onStyleChange(prefix, style);
    });
    container.appendChild(t);
  }

  // 默认选中“默认”风格，隐藏风格程度调节区
  onStyleChange(prefix, '');
}

function populateRoleTags(prefix, roles) {
  const container = $(`${prefix}RoleTags`);
  if (!container) return;
  container.innerHTML = '';
  const defaultTag = tag('默认', '', true);
  defaultTag.addEventListener('click', () => {
    container.querySelectorAll('.tag').forEach(t => t.classList.remove('active'));
    defaultTag.classList.add('active');
  });
  container.appendChild(defaultTag);
  for (const role of roles) {
    const t = tag(role, role);
    t.addEventListener('click', () => {
      container.querySelectorAll('.tag').forEach(item => item.classList.remove('active'));
      t.classList.add('active');
    });
    container.appendChild(t);
  }

  const area = $(`${prefix}RoleArea`);
  if (area) area.classList.toggle('hidden', !roles || !roles.length);
}

function onStyleChange(prefix, style) {
  const sdArea = $(`${prefix}StyledegreeArea`);
  if (sdArea) sdArea.classList.toggle('hidden', !style);
}

// ─── Populate Voices ───

function populateVoices() {
  const voices = state.voices;
  const favorites = state.settings?.favoriteVoices || [];
  const defaultVoice = state.settings?.defaultVoice || 'zh-CN-XiaoxiaoNeural';

  function makeOptions(prefix) {
    return {
      mode: 'compact',
      selected: state.settings?.[prefix === 'defaultVoice' ? 'defaultVoice' : `${prefix}Voice`] || defaultVoice,
      voices,
      favorites,
      onSelect: (shortName) => {
        if (prefix !== 'defaultVoice') {
          const info = stylesForVoice(shortName);
          populateStyleTags(prefix, info.styles);
          populateRoleTags(prefix, info.roles);
        }
        if (prefix === 'defaultVoice') updateSaveButton();
      },
      onPreview: (shortName) => playPreview(shortName),
      onToggleFavorite: (shortName) => toggleFavorite(shortName)
    };
  }

  if (!voicePickers.subtitle) {
    voicePickers.subtitle = createVoicePicker($('subtitleVoiceContainer'), makeOptions('subtitle'));
  } else {
    voicePickers.subtitle.update(voices, favorites);
  }

  if (!voicePickers.manual) {
    voicePickers.manual = createVoicePicker($('manualVoiceContainer'), makeOptions('manual'));
  } else {
    voicePickers.manual.update(voices, favorites);
  }

  // 确保当 voices 真正加载更新完毕后，根据下拉框当前选中的预设（或默认预设）重新绘制风格与参数
  // 仅在首次初始化时应用预设，避免后续 refreshState（如生成完成后）误重置用户手动调整的音色
  if (!state.initialized) {
    for (const prefix of ['subtitle', 'manual']) {
      const sel = $(`${prefix}PresetSelect`);
      const activePresetId = sel && sel.value ? sel.value : state.defaultPresetId;
      if (activePresetId) {
        applyPresetToPanel(prefix, activePresetId);
        if (sel) sel.value = activePresetId;
      }
    }
  }
}

function playPreview(shortName) {
  const audio = $('previewAudio');

  // 1. 停止当前正在播放的音频并重置所有试听按钮状态
  audio.pause();
  document.querySelectorAll('.vp-card-preview-btn').forEach((b) => {
    b.classList.remove('loading', 'playing');
  });

  const btn = document.querySelector(`.vp-card[data-short-name="${shortName}"] .vp-card-preview-btn`);
  if (btn) btn.classList.add('loading');

  // 记录本次试听标识，防止快速连续点击时旧请求覆盖新状态
  const previewToken = shortName + '|' + Date.now();
  if (btn) btn.dataset.previewToken = previewToken;

  // 用双重 rAF 确保浏览器先完成 loading 状态的绘制，再发起 IPC 调用。
  // 否则缓存命中时 IPC 在同一帧内返回，loading class 还没来得及绘制就被移除，
  // 用户看不到任何转圈动画。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      // 如果用户在 rAF 期间又点了别的试听按钮，放弃本次请求
      if (btn && btn.dataset.previewToken !== previewToken) return;

      window.momoVoiceSub.previewVoice(shortName)
        .then((dataUri) => {
          // 检查此时按钮是否依然属于当前试听
          if (btn && (btn.dataset.previewToken !== previewToken || !btn.classList.contains('loading'))) return;

          audio.src = dataUri;
          audio.onplaying = () => {
            if (btn && btn.dataset.previewToken === previewToken && btn.classList.contains('loading')) {
              btn.classList.remove('loading');
              btn.classList.add('playing');
            }
          };
          audio.onended = () => {
            if (btn) btn.classList.remove('loading', 'playing');
          };
          audio.play().catch(() => {
            if (btn) btn.classList.remove('loading', 'playing');
          });
        })
        .catch((error) => {
          if (btn && btn.dataset.previewToken === previewToken) {
            btn.classList.remove('loading', 'playing');
          }
          if (handleCloudAuthError(error)) {
            showToast('试听失败：请先登录云端账号', 'error');
          } else {
            log(`试听失败: ${friendlyErrorMessage(error)}`);
            showToast(`试听失败: ${friendlyErrorMessage(error)}`, 'error');
          }
        });
    });
  });
}

// ─── Voice Settings ───

function voiceSettings(prefix) {
  const picker = voicePickers[prefix];
  const voice = picker ? picker.getSelected() : '';
  const styleContainer = $(`${prefix}StyleTags`);
  const roleContainer = $(`${prefix}RoleTags`);
  const style = styleContainer ? (styleContainer.querySelector('.active')?.dataset?.value || '') : '';
  const role = roleContainer ? (roleContainer.querySelector('.active')?.dataset?.value || '') : '';

  return {
    voice,
    style,
    styledegree: `${$(`${prefix}Styledegree`)?.value || '100'}%`,
    role,
    rate: `${$(`${prefix}Rate`)?.value || '0'}%`,
    pitch: `${$(`${prefix}Pitch`)?.value || '0'}%`,
    volume: `${$(`${prefix}Volume`)?.value || '100'}%`,
    annotations: prefix === 'manual' ? (state.manualAnnotations || []) : undefined,
    polyphonicDict: getPolyphonicDict(),
    enablePolyphonic: prefix === 'subtitle' ? $('subtitlePolyToggle').checked : $('manualPolyToggle').checked
  };
}

// ─── Generate Subtitles ───

async function generateSubtitles() {
  if (!state.selectedSubtitleTrack) {
    setResult('subtitleResult', '请选择字幕轨。', 'error');
    return;
  }

  setBusy(true);
  setResult('subtitleResult', '正在生成字幕配音...');

  try {
    // 根据禁用状态过滤字幕条目
    const enabledItems = state.subtitleItems.filter(item => !state.disabledFrames.has(item.startFrame));
    const disabledCount = state.subtitleItems.length - enabledItems.length;
    
    if (enabledItems.length === 0) {
      setResult('subtitleResult', '所有字幕已被禁用，请至少启用一条字幕后再生成配音。', 'error');
      setBusy(false);
      return;
    }

    const subtitleItems = enabledItems.map(item => {
      const { cleanText, annotations } = parseTextAndGenerateAnnotations(item.text);
      return {
        ...item,
        text: cleanText,
        annotations: annotations
      };
    });

    const payload = {
      audioTrackIndex: state.selectedAudioTrack,
      overwriteMode: state.selectedOverwrite,
      voiceSettings: voiceSettings('subtitle'),
      subtitleItems
    };
    // SRT 模式不传 subtitleTrackIndex（后端只用 subtitleItems）；字幕轨模式传索引
    if (state.selectedSubtitleTrack !== 'srt') {
      payload.subtitleTrackIndex = Number(state.selectedSubtitleTrack);
    }
    const result = await window.momoVoiceSub.generateFromSubtitles(payload);

    setResult('subtitleResult', `完成：共 ${result.total} 条，插入 ${result.inserted} 条，跳过 ${result.skipped} 条${disabledCount > 0 ? `，忽略已禁用 ${disabledCount} 条` : ''}。目标音频轨：${result.audioTrackIndex}`, 'ok');
    await refreshState();
  } catch (error) {
    if (handleCloudAuthError(error)) {
      setResult('subtitleResult', '云端登录已过期，请重新登录后重试。', 'error');
    } else {
      setResult('subtitleResult', friendlyErrorMessage(error), 'error');
    }
  } finally {
    setBusy(false);
  }
}

// ─── Insert Manual ───

async function insertManual() {
  const rawText = (state.manualTextWithAnnotations || $('manualText').value).trim();
  if (!rawText) {
    setResult('manualResult', '请输入要生成配音的文字。', 'error');
    return;
  }

  setBusy(true);
  setResult('manualResult', '正在生成并插入...');

  try {
    const { cleanText, annotations } = parseTextAndGenerateAnnotations(rawText);
    const settings = voiceSettings('manual');
    settings.annotations = annotations;

    const result = await window.momoVoiceSub.insertManual({
      text: cleanText,
      audioTrackIndex: state.selectedManualAudioTrack,
      voiceSettings: settings,
      overwriteMode: state.selectedManualOverwrite
    });

    setResult('manualResult', `已插入到 ${result.currentTimecode}（帧 ${result.recordFrame}），目标音频轨：${result.audioTrackIndex}`, 'ok');
    await refreshState();
  } catch (error) {
    if (handleCloudAuthError(error)) {
      setResult('manualResult', '云端登录已过期，请重新登录后重试。', 'error');
    } else {
      setResult('manualResult', friendlyErrorMessage(error), 'error');
    }
  } finally {
    setBusy(false);
  }
}

// ─── Parameters & Voice Presets Management ───
function renderPresetsGrid() {
  const grid = $('presetsGrid');
  if (!grid) return;
  
  let html = '';
  state.presets.forEach(preset => {
    const isDefault = preset.id === state.defaultPresetId;
    const currentVoice = voicePickers.subtitle ? voicePickers.subtitle.getSelected() : '';
    const isActive = preset.voice === currentVoice;
    const isSystemDefault = preset.id === 'preset-default';
    const voiceCleaned = cleanVoiceName(preset.voice.split('-').pop() || preset.voice);
    const styleLabel = preset.style ? styleCn(preset.style) : '默认';
    
    let metaHtml = `<span class="preset-tag">${voiceCleaned}</span>`;
    metaHtml += `<span class="preset-tag">${styleLabel}</span>`;
    
    if (preset.rate && preset.rate !== '0%') {
      metaHtml += `<span class="preset-tag">语速 ${preset.rate}</span>`;
    }
    if (preset.pitch && preset.pitch !== '0%') {
      metaHtml += `<span class="preset-tag">音调 ${preset.pitch}</span>`;
    }
    if (preset.volume && preset.volume !== '100%') {
      metaHtml += `<span class="preset-tag">音量 ${preset.volume}</span>`;
    }
    
    // 默认预设不可改名，渲染为 span 文本
    const titleHtml = isSystemDefault
      ? `<span class="preset-card-name-label">内置预设</span>`
      : `<input type="text" class="preset-card-name" value="${preset.name}" data-id="${preset.id}" placeholder="预设名称" spellcheck="false">`;
      
    // 默认预设不可删除，直接不渲染删除按钮
    const deleteHtml = isSystemDefault
      ? ''
      : `<div class="preset-card-delete" title="删除预设" data-id="${preset.id}">×</div>`;
      
    html += `
      <div class="preset-card ${isActive ? 'is-active' : ''} ${isDefault ? 'is-default-preset' : ''}" data-id="${preset.id}">
        <div class="preset-card-header">
          ${titleHtml}
          <span class="preset-card-star" title="${isDefault ? '当前已是默认预设' : '设为默认预设'}" data-id="${preset.id}">★</span>
        </div>
        <div class="preset-card-meta">${metaHtml}</div>
        ${deleteHtml}
      </div>
    `;
  });
  
  grid.innerHTML = html;
  
  // 绑定事件
  grid.querySelectorAll('.preset-card-name').forEach(inp => {
    inp.addEventListener('click', (e) => e.stopPropagation());
    inp.addEventListener('input', () => {
      const id = inp.dataset.id;
      const preset = state.presets.find(p => p.id === id);
      if (preset) {
        preset.name = inp.value.trim();
      }
    });
    inp.addEventListener('change', () => {
      const id = inp.dataset.id;
      const preset = state.presets.find(p => p.id === id);
      if (preset) {
        preset.name = inp.value.trim();
        savePresetsAutomatically();
      }
    });
  });
  
  grid.querySelectorAll('.preset-card').forEach(card => {
    card.addEventListener('click', (e) => {
      // 点击名称输入框、删除按钮、星星时不触发卡片点击
      const tgt = e.target;
      if (tgt && tgt.closest && (tgt.closest('.preset-card-name') || tgt.closest('.preset-card-delete') || tgt.closest('.preset-card-star'))) return;
      const id = card.dataset.id;
      if (!id) return;
      const preset = state.presets.find(p => p.id === id);
      if (!preset || !preset.voice) return;
      // 将自动配音与手动配音的当前音色切换为该预设的音色（不修改默认预设）
      for (const prefix of ['subtitle', 'manual']) {
        const picker = voicePickers[prefix];
        if (picker) picker.setSelected(preset.voice);
        const info = stylesForVoice(preset.voice);
        populateStyleTags(prefix, info.styles);
        populateRoleTags(prefix, info.roles);
      }
      renderPresetsGrid();
      showToast(`已切换音色为「${cleanVoiceName(preset.voice)}」`, 'info');
    });
  });
  
  grid.querySelectorAll('.preset-card-star').forEach(star => {
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = star.dataset.id;
      if (id) {
        state.defaultPresetId = id;
        renderPresetsGrid();
        savePresetsAutomatically();
      }
    });
  });
  
  grid.querySelectorAll('.preset-card-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (id) {
        const confirmed = await showConfirmPopup('确定要删除这个配音预设吗？');
        if (!confirmed) return;
        state.presets = state.presets.filter(p => p.id !== id);
        if (state.defaultPresetId === id) {
          state.defaultPresetId = state.presets[0] ? state.presets[0].id : '';
        }
        renderPresetsGrid();
        savePresetsAutomatically();
      }
    });
  });
}

async function savePresetsAutomatically() {
  try {
    const settings = {
      ...state.settings,
      presets: state.presets,
      defaultPresetId: state.defaultPresetId,
      defaultVoice: state.defaultPresetId ? (state.presets.find(p => p.id === state.defaultPresetId)?.voice || 'zh-CN-XiaoxiaoNeural') : 'zh-CN-XiaoxiaoNeural'
    };
    state.settings = await window.momoVoiceSub.saveSettings(settings);
    updatePresetDropdowns();
    state.settingsBaseline = settingsSnapshotFromForm();
    updateSaveButton();
    log('预设已自动保存');
  } catch (error) {
    log('预设自动保存失败: ' + error.message);
    showToast('预设自动保存失败', 'error');
  }
}

function updatePresetDropdowns() {
  for (const prefix of ['subtitle', 'manual']) {
    const select = $(`${prefix}PresetSelect`);
    if (!select) continue;
    
    // 记住当前用户实际选中的预设 ID
    const currentVal = select.value;
    
    let html = '';
    state.presets.forEach(p => {
      const isDefault = p.id === state.defaultPresetId;
      html += `<option value="${p.id}">${p.name}${isDefault ? ' (默认)' : ''}</option>`;
    });
    select.innerHTML = html;
    
    // 如果之前选中的预设依旧存在，则保持该选中状态，绝不野蛮打断用户当前的音色选择
    if (currentVal && state.presets.some(p => p.id === currentVal)) {
      select.value = currentVal;
    } else if (state.defaultPresetId) {
      // 只有之前选中的预设已被删除或不存在时，才回退到当前最新的默认预设，并同步更新面板音色
      select.value = state.defaultPresetId;
      applyPresetToPanel(prefix, state.defaultPresetId);
    }
  }
}

function applyPresetToPanel(prefix, presetId) {
  if (!presetId) return;
  const preset = state.presets.find(p => p.id === presetId);
  if (!preset) return;
  
  const picker = voicePickers[prefix];
  if (picker) {
    picker.setSelected(preset.voice);
  }
  
  const info = stylesForVoice(preset.voice);
  populateStyleTags(prefix, info.styles);
  populateRoleTags(prefix, info.roles);
  
  const styleBtn = document.querySelector(`#${prefix}StyleTags .tag[data-value="${preset.style || ''}"]`);
  if (styleBtn) {
    document.querySelectorAll(`#${prefix}StyleTags .tag`).forEach(b => b.classList.remove('active'));
    styleBtn.classList.add('active');
    onStyleChange(prefix, preset.style);
  } else {
    // preset 保存的风格在当前音色中不存在，回退选中“默认”
    const defaultStyleBtn = document.querySelector(`#${prefix}StyleTags .tag[data-value=""]`);
    document.querySelectorAll(`#${prefix}StyleTags .tag`).forEach(b => b.classList.remove('active'));
    if (defaultStyleBtn) defaultStyleBtn.classList.add('active');
    onStyleChange(prefix, '');
  }
  
  const roleBtn = document.querySelector(`#${prefix}RoleTags .tag[data-value="${preset.role || ''}"]`);
  if (roleBtn) {
    document.querySelectorAll(`#${prefix}RoleTags .tag`).forEach(b => b.classList.remove('active'));
    roleBtn.classList.add('active');
  } else {
    // preset 保存的角色在当前音色中不存在，回退选中“默认”
    const defaultRoleBtn = document.querySelector(`#${prefix}RoleTags .tag[data-value=""]`);
    document.querySelectorAll(`#${prefix}RoleTags .tag`).forEach(b => b.classList.remove('active'));
    if (defaultRoleBtn) defaultRoleBtn.classList.add('active');
  }
  
  const rate = $(`${prefix}Rate`);
  const pitch = $(`${prefix}Pitch`);
  const vol = $(`${prefix}Volume`);
  const sd = $(`${prefix}Styledegree`);
  
  if (rate) rate.value = Number.parseInt(preset.rate || '0', 10) || 0;
  if (pitch) pitch.value = Number.parseInt(preset.pitch || '0', 10) || 0;
  if (vol) vol.value = Number.parseInt(preset.volume || '100', 10) || 100;
  if (sd) sd.value = Number.parseInt(preset.styleDegree || '100', 10) || 100;
  
  updateRangeLabels();
}

async function savePresetFromPanel(prefix) {
  // 零打断极速自动命名保存，防范 Electron prompt() 不支持报错并提升交互体验
  const presetName = `新预设 ${state.presets.length + 1}`;
  
  const selectedVoice = voicePickers[prefix] ? voicePickers[prefix].getSelected() : 'zh-CN-XiaoxiaoNeural';
  const activeStyle = document.querySelector(`#${prefix}StyleTags .tag.active`);
  const activeRole = document.querySelector(`#${prefix}RoleTags .tag.active`);
  
  const newPreset = {
    id: 'preset-' + Date.now(),
    name: presetName,
    voice: selectedVoice,
    style: activeStyle ? activeStyle.dataset.value : '',
    role: activeRole ? activeRole.dataset.value : '',
    styleDegree: `${$(`${prefix}Styledegree`)?.value || '100'}%`,
    volume: `${$(`${prefix}Volume`)?.value || '100'}%`,
    rate: `${$(`${prefix}Rate`)?.value || '0'}%`,
    pitch: `${$(`${prefix}Pitch`)?.value || '0'}%`
  };
  
  state.presets.push(newPreset);
  if (!state.defaultPresetId) {
    state.defaultPresetId = newPreset.id;
  }
  
  state.settings.presets = state.presets;
  state.settings.defaultPresetId = state.defaultPresetId;
  
  setBusy(true);
  try {
    state.settings = await window.momoVoiceSub.saveSettings(state.settings);
    renderPresetsGrid();
    updatePresetDropdowns();
    $(`${prefix}PresetSelect`).value = newPreset.id;
    showToast(`已存为"${presetName}"，可去设置页重命名。`, 'ok');
  } catch (error) {
    setResult(`${prefix}Result`, friendlyErrorMessage(error), 'error');
  } finally {
    setBusy(false);
  }
}

// ─── Settings ───

function loadSettingsToForm() {
  const settings = state.settings || {};
  $('azureRegion').value = settings.region || '';
  $('rememberKey').checked = Boolean(settings.rememberKey);
  $('cacheDir').value = settings.cacheDir || '';
  if (settings.hasAzureKey) {
    $('azureKey').value = '__SAVED_KEY_PLACEHOLDER__';
  } else {
    $('azureKey').value = '';
  }

  // 仅在首次初始化时将参数滑块重置为全局默认值，避免后续 refreshState（如生成完成后）覆盖用户手动调整的参数
  if (!state.initialized) {
    for (const prefix of ['subtitle', 'manual']) {
      const rate = $(`${prefix}Rate`);
      const pitch = $(`${prefix}Pitch`);
      const vol = $(`${prefix}Volume`);
      const sd = $(`${prefix}Styledegree`);
      if (rate) rate.value = Number.parseInt(settings.defaultRate || '0', 10) || 0;
      if (pitch) pitch.value = Number.parseInt(settings.defaultPitch || '0', 10) || 0;
      if (vol) vol.value = Number.parseInt(settings.defaultVolume || '100', 10) || 100;
      if (sd) sd.value = Number.parseInt(settings.defaultStyledegree || '100', 10) || 100;
    }
  }
  updateRangeLabels();
  
  // 加载并初始化预设
  const prevDefaultVoice = settings.defaultVoice || 'zh-CN-XiaoxiaoNeural';
  const prevDefaultRate = settings.defaultRate || '0%';
  const prevDefaultPitch = settings.defaultPitch || '0%';
  const prevDefaultVolume = settings.defaultVolume || '100%';
  const prevDefaultStyle = settings.defaultStyle || '';
  const prevDefaultRole = settings.defaultRole || '';
  const prevDefaultStyleDegree = settings.defaultStyledegree || '100%';

  state.presets = settings.presets || [
    {
      id: 'preset-default',
      name: '内置预设',
      voice: prevDefaultVoice,
      style: prevDefaultStyle,
      role: prevDefaultRole,
      styleDegree: prevDefaultStyleDegree,
      volume: prevDefaultVolume,
      rate: prevDefaultRate,
      pitch: prevDefaultPitch
    }
  ];

  // 确保系统默认预设 'preset-default' 一定在数组开头，且数据保持最新
  let defaultPreset = state.presets.find(p => p.id === 'preset-default');
  if (!defaultPreset) {
    defaultPreset = {
      id: 'preset-default',
      name: '内置预设',
      voice: prevDefaultVoice,
      style: prevDefaultStyle,
      role: prevDefaultRole,
      styleDegree: prevDefaultStyleDegree,
      volume: prevDefaultVolume,
      rate: prevDefaultRate,
      pitch: prevDefaultPitch
    };
    state.presets.unshift(defaultPreset);
  }

  // ─── 强力防呆兜底健康修复 ───
  let defaultPresetNameChanged = false;
  if (defaultPreset) {
    if (defaultPreset.name !== '内置预设') {
      defaultPreset.name = '内置预设';
      defaultPresetNameChanged = true;
    }
    if (!defaultPreset.voice) defaultPreset.voice = prevDefaultVoice;
    if (defaultPreset.style === undefined || defaultPreset.style === null) defaultPreset.style = prevDefaultStyle;
    if (defaultPreset.role === undefined || defaultPreset.role === null) defaultPreset.role = prevDefaultRole;
    if (defaultPreset.styleDegree === undefined) defaultPreset.styleDegree = prevDefaultStyleDegree;
    if (defaultPreset.volume === undefined) defaultPreset.volume = prevDefaultVolume;
    if (defaultPreset.rate === undefined) defaultPreset.rate = prevDefaultRate;
    if (defaultPreset.pitch === undefined) defaultPreset.pitch = prevDefaultPitch;
  }

  // 同时也对其它的用户预设做防御性健康恢复，确保不包含 undefined / null 导致界面报错
  state.presets.forEach(p => {
    if (!p.voice) p.voice = 'zh-CN-XiaoxiaoNeural';
    if (p.style === undefined || p.style === null) p.style = '';
    if (p.role === undefined || p.role === null) p.role = '';
    if (p.styleDegree === undefined) p.styleDegree = '100%';
    if (p.volume === undefined) p.volume = '100%';
    if (p.rate === undefined) p.rate = '0%';
    if (p.pitch === undefined) p.pitch = '0%';
  });

  state.defaultPresetId = settings.defaultPresetId || 'preset-default';

  // 如果默认预设名字发生了更改，自动静默保存一次，实现物理 settings.json 文件无缝自动升级
  if (defaultPresetNameChanged) {
    setTimeout(() => {
      savePresetsAutomatically().catch(() => {});
    }, 100);
  }
  
  // 渲染设置网格与配音界面下拉选项
  renderPresetsGrid();
  updatePresetDropdowns();

  state.polyphonicDict = sanitizePolyphonicDict(settings.polyphonicDict || []);
  renderPolyDictTable();
}

function settingsSnapshotFromForm() {
  return {
    region: $('azureRegion').value.trim(),
    rememberKey: $('rememberKey').checked,
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
  button.disabled = state.busy || !settingsAreDirty();
}

function readSettingsFromForm(includeKey = true) {
  const settings = {
    region: $('azureRegion').value.trim(),
    endpoint: state.settings?.endpoint || '',
    rememberKey: $('rememberKey').checked,
    defaultVoice: state.defaultPresetId ? (state.presets.find(p => p.id === state.defaultPresetId)?.voice || 'zh-CN-XiaoxiaoNeural') : 'zh-CN-XiaoxiaoNeural',
    presets: state.presets,
    defaultPresetId: state.defaultPresetId,
    defaultStyle: '',
    defaultStyledegree: `${$('subtitleStyledegree')?.value || '100'}%`,
    defaultRole: '',
    defaultVolume: `${$('subtitleVolume')?.value || '100'}%`,
    defaultRate: `${$('subtitleRate')?.value || '0'}%`,
    defaultPitch: `${$('subtitlePitch')?.value || '0'}%`,
    overwriteMode: state.selectedOverwrite || 'skip',
    polyphonicDict: state.polyphonicDict
  };
  if (includeKey) {
    const keyVal = $('azureKey').value.trim();
    if (keyVal && keyVal !== '__SAVED_KEY_PLACEHOLDER__') {
      settings.azureKey = keyVal;
    }
  }
  return settings;
}

async function saveSettings() {
  setBusy(true);
  try {
    state.settings = await window.momoVoiceSub.saveSettings(readSettingsFromForm(true));
    $('azureKey').value = '';
    loadSettingsToForm();
    populateVoices();
    captureSettingsBaseline();
    setResult('settingsResult', state.settings.hasAzureKey ? '设置已保存，密钥可用' : '设置已保存，但没有可用密钥', 'ok');
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
    if (handleCloudAuthError(error)) {
      setResult('settingsResult', '云端登录已过期，请重新登录。', 'error');
    } else {
      setResult('settingsResult', friendlyErrorMessage(error), 'error');
    }
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

// ─── Polyphonic Dictionary Management ───

// 动态多音字读音数据状态数组
let activePinyinRows = [];

// 罗马数字辅助换算
function romanNumber(num) {
  const roman = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
  return roman[num - 1] || String(num);
}

// 动态渲染拼音/注音/上下文示例的子表单块
function renderPinyinRows() {
  const container = $('polyPinyinsContainer');
  if (!container) return;
  
  if (activePinyinRows.length === 0) {
    activePinyinRows = [{ phonetic: '', context: '' }];
  }

  let html = '';
  activePinyinRows.forEach((row, index) => {
    // 自动联动转换生成拼音
    const tonedPinyin = row.phonetic ? phoneticToPinyin(row.phonetic) : '';
    html += `
      <div class="poly-pinyin-block" data-idx="${index}">
        <div class="poly-pinyin-block-header">
          <span>拼音 ${romanNumber(index + 1)}</span>
          ${activePinyinRows.length > 1 ? `<span class="poly-pinyin-block-del" data-idx="${index}" title="删除此拼音">×</span>` : ''}
        </div>
        <div class="poly-pinyin-row">
          <input type="text" class="popup-input pinyin-input-val" placeholder="声调数字，如：xing 2" value="${escapeHtml(row.phonetic)}" data-idx="${index}" spellcheck="false">
          <input type="text" class="popup-input pinyin-display-val" placeholder="拼音符号" value="${escapeHtml(tonedPinyin)}" readonly tabindex="-1" spellcheck="false">
        </div>
        <div class="poly-context-row">
          <input type="text" class="popup-input pinyin-context-val" placeholder="上下文示例（选填，如：行为）" value="${escapeHtml(row.context || '')}" data-idx="${index}" spellcheck="false">
        </div>
      </div>
    `;
  });

  // 在尾部追加虚线添加按钮作为网格的最后一个子格子单元
  html += `
    <div id="addPinyinRowBtn" class="add-pinyin-block-btn" title="添加新的拼音">
      <span>+ 添加拼音</span>
    </div>
  `;

  container.innerHTML = html;

  // 联动绑定子输入控件事件
  container.querySelectorAll('.poly-pinyin-block').forEach(block => {
    const idx = Number(block.dataset.idx);
    const input = block.querySelector('.pinyin-input-val');
    const display = block.querySelector('.pinyin-display-val');
    const contextInput = block.querySelector('.pinyin-context-val');

    // 联动实时声调转换
    input.addEventListener('input', () => {
      const val = input.value;
      activePinyinRows[idx].phonetic = val;
      display.value = val ? phoneticToPinyin(val) : '';
    });

    contextInput.addEventListener('input', () => {
      activePinyinRows[idx].context = contextInput.value;
    });

    // 绑定删除按钮
    const delBtn = block.querySelector('.poly-pinyin-block-del');
    if (delBtn) {
      delBtn.addEventListener('click', () => {
        activePinyinRows.splice(idx, 1);
        renderPinyinRows();
      });
    }
  });

  // 绑定网格最末尾追加按钮的点击事件
  const addBtn = $('addPinyinRowBtn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      activePinyinRows.push({ phonetic: '', context: '' });
      renderPinyinRows();
    });
  }
}

// 根据窗口宽度推断内置字典网格的当前列数（与 CSS media query 保持一致）
function getPolyGridCols() {
  const w = window.innerWidth;
  if (w <= 600) return 1;
  if (w <= 900) return 2;
  return 3;
}

function renderBuiltinPolyTable() {
  const wrap = $('polyBuiltinTable');
  if (!wrap) return;
  const searchTerm = $('polyBuiltinSearch')?.value?.toLowerCase() || '';
  const dict = state.builtinPolyDict || [];

  let filtered = dict;
  if (searchTerm) {
    filtered = dict.filter(e =>
      e.char?.includes(searchTerm) || e.pinyin?.includes(searchTerm)
    );
  }

  if (!filtered.length) {
    wrap.innerHTML = '<div class="table-placeholder">暂无匹配的内置词条</div>';
    return;
  }

  // 按汉字聚合归类（只读展示，不可编辑/删除）
  const groups = {};
  filtered.forEach(e => {
    if (!e.char) return;
    if (!groups[e.char]) groups[e.char] = [];
    groups[e.char].push(e);
  });

  const groupKeys = Object.keys(groups);
  const collapsedCount = getPolyGridCols() * 2; // 默认只显示 2 行
  const expanded = state.builtinPolyExpanded;
  const visibleKeys = expanded ? groupKeys : groupKeys.slice(0, collapsedCount);
  const hasMore = groupKeys.length > collapsedCount;

  let html = '<div class="poly-dict-grid">';
  for (const char of visibleKeys) {
    const entries = groups[char];
    html += `
      <div class="poly-dict-card poly-dict-card-builtin">
        <div class="poly-card-header">
          <span class="poly-card-char">${escapeHtml(char)}</span>
          <span class="poly-card-badge">内置</span>
        </div>
        <div class="poly-card-body">
    `;
    entries.forEach((e, idx) => {
      html += `
        <div class="poly-card-pinyin-row">
          <span class="poly-card-index">${romanNumber(idx + 1)}</span>
          <span class="poly-card-pinyin-val">${escapeHtml(e.pinyin)} <span class="poly-card-phonetic">(${escapeHtml(e.phonetic)})</span></span>
          <span class="poly-card-context-val" title="${escapeHtml(e.context || '')}">${escapeHtml(e.context || '')}</span>
        </div>
      `;
    });
    html += `
        </div>
      </div>
    `;
  }
  html += '</div>';

  if (hasMore) {
    html += `<div class="poly-dict-expand-bar">
      <button class="btn btn-xs btn-ghost poly-dict-expand-btn">${expanded ? '收起' : '展开全部'}（共 ${groupKeys.length} 个汉字）</button>
    </div>`;
  }

  wrap.innerHTML = html;

  const expandBtn = wrap.querySelector('.poly-dict-expand-btn');
  if (expandBtn) {
    expandBtn.addEventListener('click', () => {
      state.builtinPolyExpanded = !state.builtinPolyExpanded;
      renderBuiltinPolyTable();
    });
  }
}

function renderPolyDictTable() {
  const wrap = $('polyDictTable');
  if (!wrap) return;
  const searchTerm = $('polyDictSearch')?.value?.toLowerCase() || '';
  const dict = state.polyphonicDict || [];

  let filtered = dict;
  if (searchTerm) {
    filtered = dict.filter(e =>
      e.char?.includes(searchTerm) || e.pinyin?.includes(searchTerm)
    );
  }

  if (!filtered.length) {
    wrap.innerHTML = '<div class="table-placeholder">暂无词条，点击右上角「+ 添加词条」添加</div>';
    return;
  }

  // 按汉字进行聚合归类合并，高密度呈现
  const groups = {};
  filtered.forEach(e => {
    if (!e.char) return;
    if (!groups[e.char]) groups[e.char] = [];
    groups[e.char].push(e);
  });

  let html = '<div class="poly-dict-grid">';
  for (const [char, entries] of Object.entries(groups)) {
    html += `
      <div class="poly-dict-card">
        <div class="poly-card-header">
          <span class="poly-card-char">${escapeHtml(char)}</span>
          <div class="poly-card-actions">
            <button class="btn btn-xs btn-ghost poly-dict-edit" data-char="${escapeHtml(char)}" title="编辑词条">✎</button>
            <button class="btn btn-xs btn-ghost poly-dict-del text-danger" data-char="${escapeHtml(char)}" title="删除词条">✕</button>
          </div>
        </div>
        <div class="poly-card-body">
    `;
    
    entries.forEach((e, idx) => {
      html += `
        <div class="poly-card-pinyin-row">
          <span class="poly-card-index">${romanNumber(idx + 1)}</span>
          <span class="poly-card-pinyin-val">${escapeHtml(e.pinyin)} <span class="poly-card-phonetic">(${escapeHtml(e.phonetic)})</span></span>
          <span class="poly-card-context-val" title="${escapeHtml(e.context || '')}">${escapeHtml(e.context || '')}</span>
        </div>
      `;
    });
    
    html += `
        </div>
      </div>
    `;
  }
  html += '</div>';
  wrap.innerHTML = html;

  wrap.querySelectorAll('.poly-dict-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const char = btn.dataset.char;
      const confirmed = await showConfirmPopup(`确定要删除多音字「${char}」的所有读音词条吗？`);
      if (confirmed) {
        state.polyphonicDict = state.polyphonicDict.filter(e => e.char !== char);
        renderPolyDictTable();
        renderQuickPolyList();
        await savePolyDictAutomatically();
      }
    });
  });

  wrap.querySelectorAll('.poly-dict-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const char = btn.dataset.char;
      $('polyEntryTitle').textContent = '编辑词条';
      $('polyEntryChar').value = char || '';
      
      // 聚合同一个汉字的所有读音装载入 activePinyinRows
      const sameCharEntries = state.polyphonicDict.filter(e => e.char === char);
      activePinyinRows = sameCharEntries.map(e => {
        const ph = e.phonetic || '';
        const formattedPhonetic = ph.replace(/([a-zü]+)([1-5])/, '$1 $2').trim();
        return {
          phonetic: formattedPhonetic,
          context: e.context || ''
        };
      });

      renderPinyinRows();
      $('polyEntrySave').dataset.editChar = char; // 记住被编辑的字词
      delete $('polyEntrySave').dataset.editIdx;
      $('polyEntryPopup').classList.remove('hidden');
    });
  });
}

function openAddPolyEntry() {
  $('polyEntryTitle').textContent = '添加词条';
  $('polyEntryChar').value = '';
  delete $('polyEntrySave').dataset.editIdx;
  delete $('polyEntrySave').dataset.editChar;

  activePinyinRows = [{ phonetic: '', context: '' }];
  renderPinyinRows();

  $('polyEntryPopup').classList.remove('hidden');
}

// ─── Cache ───

function showConfirmPopup(message) {
  return new Promise((resolve) => {
    const popup = $('confirmPopup');
    $('confirmPopupMessage').textContent = message;
    popup.classList.remove('hidden');

    function cleanup(result) {
      popup.classList.add('hidden');
      $('confirmPopupOk').removeEventListener('click', onOk);
      $('confirmPopupCancel').removeEventListener('click', onCancel);
      $('confirmPopupClose').removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }

    $('confirmPopupOk').addEventListener('click', onOk);
    $('confirmPopupCancel').addEventListener('click', onCancel);
    $('confirmPopupClose').addEventListener('click', onCancel);
  });
}

async function runCacheAction({ action, confirmMessage, successMessage }) {
  try {
    if (confirmMessage) {
      const confirmed = await showConfirmPopup(confirmMessage);
      if (!confirmed) { log('操作已取消'); showToast('操作已取消', 'info'); return; }
    }
    setBusy(true);
    setResult('settingsResult', '正在清理缓存...');
    const result = await action();
    setResult('settingsResult', successMessage(result), 'ok');
  } catch (error) {
    setResult('settingsResult', friendlyErrorMessage(error), 'error');
    log('缓存操作失败：' + friendlyErrorMessage(error));
    showToast('缓存操作失败：' + friendlyErrorMessage(error), 'error');
  } finally {
    setBusy(false);
  }
}

async function deleteUnusedCache() {
  log('开始清理未使用缓存...');
  await runCacheAction({
    action: () => window.momoVoiceSub.deleteUnusedCurrentProjectCache(),
    confirmMessage: '确定删除当前项目中所有未使用的配音缓存吗？',
    successMessage: (result) => result.conservative
      ? `扫描 ${result.scanned} 个缓存，但有 ${result.unresolved} 个片段无法确认，已保留全部`
      : `扫描 ${result.scanned} 个缓存，删除 ${result.deleted} 个，保留 ${result.kept} 个`
  });
}

async function deleteCurrentProjectCache() {
  log('准备删除当前项目缓存...');
  await runCacheAction({
    action: () => window.momoVoiceSub.deleteCurrentProjectCache(),
    confirmMessage: '确定删除当前项目的所有配音缓存吗？',
    successMessage: (result) => `已删除当前项目缓存 ${result.deleted} 个文件。`
  });
}

async function deleteAllProjectCache() {
  log('准备删除全部项目缓存...');
  await runCacheAction({
    action: () => window.momoVoiceSub.deleteAllProjectCache(),
    confirmMessage: '确定删除所有项目的配音缓存吗？\n（不会删除试听缓存）',
    successMessage: (result) => `已删除所有项目缓存 ${result.deleted} 个文件。`
  });
}

async function openCacheFolder() {
  try {
    setBusy(true);
    const result = await window.momoVoiceSub.openCacheFolder();
    if (result && result.ok) {
      log(`已打开缓存目录: ${result.cacheDir}`);
    }
  } catch (error) {
    log(`打开缓存目录失败: ${friendlyErrorMessage(error)}`);
  } finally {
    setBusy(false);
  }
}

// ─── 检查更新 ───

const UPDATE_CHECK_URL = 'https://raw.githubusercontent.com/hcllmsx/momovoicesub/main/VERSION';

/** 比较两个版本号字符串（格式：主.次.修订），返回 1 表示 a > b，-1 表示 a < b，0 表示相等 */
function compareVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

async function checkForUpdate(manual = false) {
  state.updateStatus = 'checking';
  renderUpdateStatus();
  try {
    const resp = await fetch(UPDATE_CHECK_URL, { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const lines = text.split(/\r?\n/);
    let remoteVersion = '';
    for (const line of lines) {
      const m = line.match(/^com\.momo\.voicesub\.dr\.version=(.+)/);
      if (m) { remoteVersion = m[1].trim(); break; }
    }
    if (!remoteVersion) throw new Error('未找到远程 DR 版本号');
    state.updateLatestVersion = remoteVersion;
    const cmp = compareVersion(remoteVersion, state.appVersion);
    if (cmp > 0) {
      state.updateStatus = 'available';
    } else {
      state.updateStatus = 'latest';
      if (manual) showToast('已是最新版本', 'ok');
    }
  } catch (e) {
    log('检查更新失败: ' + (e && e.message ? e.message : e));
    state.updateStatus = 'error';
    if (manual) showToast('检查更新失败', 'error');
  }
  renderUpdateStatus();
}

function renderUpdateStatus() {
  const el = document.getElementById('updateStatus');
  const verNumEl = document.querySelector('#appVersion .app-version-num');
  if (!el) return;
  el.className = 'update-status';
  // 重置版本号颜色
  if (verNumEl) verNumEl.classList.remove('app-version-latest');
  switch (state.updateStatus) {
    case 'idle':
      el.textContent = '';
      el.className += ' update-status-hidden';
      break;
    case 'checking':
      el.textContent = '检查更新中...';
      el.className += ' update-status-checking';
      break;
    case 'latest':
      // 已是最新：不显示额外文字，仅版本号变绿
      if (verNumEl) verNumEl.classList.add('app-version-latest');
      el.textContent = '';
      el.className += ' update-status-hidden';
      break;
    case 'available':
      el.innerHTML = `发现新版本 v${state.updateLatestVersion} — <a class="update-link" href="javascript:void(0)" id="updateLink">前往下载</a>`;
      el.className += ' update-status-available';
      break;
    case 'error':
      el.textContent = '';
      el.className += ' update-status-hidden';
      break;
  }
  // 为新版本绑定跳转链接
  const linkEl = document.getElementById('updateLink');
  if (linkEl) {
    linkEl.addEventListener('click', () => {
      window.momoVoiceSub.openExternal('https://github.com/hcllmsx/momovoicesub/releases/latest');
    });
  }
}

// ─── Refresh State ───

async function refreshState() {
  try {
    const appState = await window.momoVoiceSub.getState();
    state.appVersion = appState.version || '';
    const settingsBtn = document.querySelector('.nav-btn[data-tab="settings"]');
    if (settingsBtn && state.appVersion) {
      settingsBtn.setAttribute('data-tooltip', `插件设置 v${state.appVersion}`);
    }
    state.settings = appState.settings;
    state.voices = appState.settings.voices || [];
    state.subtitleTracks = appState.resolve.subtitleTracks || [];
    state.audioTracks = appState.resolve.audioTracks || [];

    // 检测时间线切换：若与上次缓存的时间线名不同，则视为切到了新时间线，
    // 此时 selectedSubtitleTrack / 已加载的字幕列表都应失效（已导入的 SRT 保留）。
    const timelineChanged = !!appState.resolve.timelineName
      && state.currentTimelineName
      && state.currentTimelineName !== appState.resolve.timelineName;
    state.currentTimelineName = appState.resolve.timelineName || '';

    // 时间线切换后，若当前未处于 SRT 模式，则原 selectedSubtitleTrack 多半
    // 不再属于新时间线，需重置；SRT 模式不受时间线切换影响，保留。
    if (timelineChanged && state.selectedSubtitleTrack !== 'srt') {
      state.selectedSubtitleTrack = null;
      state.loadedSubtitleTrack = null;
    }
    // 选中字幕轨已不在新时间线里（或本身为 null）时，回退到第一条
    if (!state.selectedSubtitleTrack && state.subtitleTracks.length > 0) {
      state.selectedSubtitleTrack = String(state.subtitleTracks[0].index);
    }
    // 若选中了不存在的字幕轨（且不是 SRT 模式），清空选中
    if (state.selectedSubtitleTrack
      && state.selectedSubtitleTrack !== 'srt'
      && !state.subtitleTracks.some(t => String(t.index) === state.selectedSubtitleTrack)) {
      state.selectedSubtitleTrack = null;
      state.loadedSubtitleTrack = null;
    }
    state.polyphonicDict = sanitizePolyphonicDict(appState.settings.polyphonicDict || []);
    // 加载内置多音字字典（仅加载一次，数据源为打包内的 polyphonic-builtin.json）
    if (!state.builtinPolyDict.length) {
      try {
        state.builtinPolyDict = await window.momoVoiceSub.loadBuiltinPoly() || [];
      } catch (e) {
        log('加载内置多音字字典失败: ' + (e && e.message ? e.message : e));
        state.builtinPolyDict = [];
      }
    }
    renderBuiltinPolyTable();
    // 页脚版本号：「momoVoicesub」为指向 GitHub 仓库的超链接
    const appVersionEl = $('appVersion');
    if (appVersionEl) {
      appVersionEl.innerHTML = state.appVersion
        ? `默默配音助手（<a id="appVersionLink" class="app-version-link" href="javascript:void(0)">momoVoicesub</a>） <span class="app-version-num">v${state.appVersion}</span>`
        : '';
      const linkEl = $('appVersionLink');
      if (linkEl) {
        linkEl.addEventListener('click', () => {
          window.momoVoiceSub.openExternal('https://github.com/hcllmsx/momovoicesub');
        });
      }
    }

    showNodeWarning(appState.nodeWarning);

    const resolveOk = appState.resolve.ok;
    const dot = $('resolveDot');
    const statusBtn = $('sidebarStatusBtn');
    const pHeaderText = $('projectHeaderText');
    const statusLabel = $('resolveStatusText');

    if (resolveOk) {
      dot.className = 'dot connected';
      const label = `${appState.resolve.projectName} / ${appState.resolve.timelineName}`;
      if (statusBtn) statusBtn.removeAttribute('title');
      if (statusLabel) statusLabel.textContent = `${appState.resolve.timelineName} (点击刷新)`;
      if (pHeaderText) pHeaderText.textContent = label;
    } else {
      dot.className = 'dot error';
      const errorMsg = appState.resolve.error || '连接失败';
      if (statusBtn) statusBtn.removeAttribute('title');
      if (statusLabel) statusLabel.textContent = `${errorMsg} (点击刷新状态)`;
      if (pHeaderText) pHeaderText.textContent = errorMsg;
    }

    loadSettingsToForm();
    populateTrackTags();
    populateVoices();
    // 启动时自动将默认预设应用到两个面板上，极佳的开箱即用体验
    if (!state.initialized && state.defaultPresetId) {
      applyPresetToPanel('subtitle', state.defaultPresetId);
      applyPresetToPanel('manual', state.defaultPresetId);
      const subSel = $('subtitlePresetSelect');
      const manSel = $('manualPresetSelect');
      if (subSel) subSel.value = state.defaultPresetId;
      if (manSel) manSel.value = state.defaultPresetId;
    }
    state.initialized = true;
    captureSettingsBaseline();
    renderPolyDictTable();

    if (state.selectedSubtitleTrack === 'srt') {
      // SRT 模式：保持已有字幕列表不变，仅刷新按钮可见性
      updateImportSrtBtnVisibility();
    } else if (state.selectedSubtitleTrack && state.subtitleTracks.some(t => String(t.index) === state.selectedSubtitleTrack)) {
      loadSubtitleTable();
      updateImportSrtBtnVisibility();
    } else {
      // 当前时间线无字幕轨且未导入 SRT：清空残留字幕列表，显示「无字幕轨」占位
      // 注意：已导入的 SRT 内容保留在 state.srtItems 中，重启后不再保留（符合需求）
      state.subtitleItems = [];
      state.subtitleAnnotations = new Map();
      state.disabledFrames = new Set();
      state.loadedSubtitleTrack = null;
      const wrap = $('subtitleTable');
      if (wrap) wrap.innerHTML = '<div class="table-placeholder">当前时间线无字幕轨，可点击「📂 导入SRT」加载本地字幕</div>';
      updateImportSrtBtnVisibility();
    }
  } catch (error) {
    log(friendlyErrorMessage(error));
  }
}

// ─── Log Actions ───

async function copyLog() {
  try {
    await window.momoVoiceSub.copyLog($('logOutput').textContent);
    log('运行日志已复制到剪贴板');
    showToast('运行日志已复制到剪贴板', 'ok');
  } catch (error) { log(friendlyErrorMessage(error)); }
}

async function exportLog() {
  try {
    const result = await window.momoVoiceSub.exportLog($('logOutput').textContent);
    if (!result.canceled) { log(`运行日志已导出：${result.filePath}`); showToast('运行日志已导出', 'ok'); }
  } catch (error) { log(friendlyErrorMessage(error)); }
}

function clearLog() { $('logOutput').textContent = ''; }

// ─── Quick Poly List (Manual Sidebar) ───

function renderQuickPolyList() {
  const list = $('polyQuickList');
  if (!list) return;
  const dict = state.polyphonicDict || [];
  if (!dict.length) {
    list.innerHTML = '<div class="poly-quick-empty">暂无自定义词条</div>';
    return;
  }
  list.innerHTML = dict.slice(0, 8).map(e =>
    `<div class="poly-quick-item">
      <div>
        <span class="poly-q-char">${escapeHtml(e.char)}</span>
        <span class="poly-q-pinyin">${escapeHtml(e.pinyin)}</span>
      </div>
      <span class="poly-q-context">${escapeHtml((e.context || '').slice(0, 12))}</span>
    </div>`
  ).join('');
}

// ─── Event Setup ───

function setupEvents() {
  document.querySelectorAll('.nav-btn[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn[data-tab]').forEach(item => item.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(item => item.classList.remove('active'));
      button.classList.add('active');
      $(button.dataset.tab).classList.add('active');

      // 跟踪当前激活的标签页，供 setBusy 选择正确的触发按钮
      state.currentTab = button.dataset.tab;

      // 切到设置页时，根据登录状态自动切换"连接设置"选项卡：
      // 已登录云端 → 显示"登录账号"面板；未登录 → 显示"自填 Key"面板
      if (button.dataset.tab === 'settings') {
        autoSelectAuthTab();
      }
    });
  });

  const handleRefresh = async () => {
    try { await refreshState(); showRefreshHint(); }
    catch { showRefreshHint('刷新失败'); }
  };
  const statusBtnEl = $('sidebarStatusBtn');
  if (statusBtnEl) statusBtnEl.addEventListener('click', handleRefresh);

  const githubBtnEl = $('githubBtn');
  if (githubBtnEl) {
    githubBtnEl.addEventListener('click', () => {
      window.momoVoiceSub.openExternal('https://github.com/hcllmsx/momovoicesub');
    });
  }

  $('saveSettings').addEventListener('click', saveSettings);
  $('testAzure').addEventListener('click', testAzure);
  $('refreshVoices').addEventListener('click', refreshVoices);
  $('openDevTools').addEventListener('click', openDevTools);
  $('showLogPanel').addEventListener('click', toggleLogPanel);
  $('deleteUnusedCache').addEventListener('click', deleteUnusedCache);
  $('deleteCurrentProjectCache').addEventListener('click', deleteCurrentProjectCache);
  $('deleteAllProjectCache').addEventListener('click', deleteAllProjectCache);
  $('openCacheFolder').addEventListener('click', openCacheFolder);
  $('generateSubtitles').addEventListener('click', generateSubtitles);
  $('insertManual').addEventListener('click', insertManual);
  $('copyLog').addEventListener('click', copyLog);
  $('exportLog').addEventListener('click', exportLog);
  $('clearLog').addEventListener('click', clearLog);
  $('toggleExpandLog').addEventListener('click', () => {
    // 右上角按钮：直接关闭整个日志面板（而非收起/展开切换）
    const logPanel = document.querySelector('.log-panel');
    if (logPanel) {
      logPanel.classList.remove('visible');
    }
  });

  const taEl = $('manualText');
  const hlEl = $('manualTextHighlight');
  if (taEl && hlEl) {
    taEl.addEventListener('input', () => {
      const newPlain = taEl.value;
      state.manualTextWithAnnotations = syncAnnotatedText(state.manualTextWithAnnotations, newPlain);
      updateManualHighlighter();
    });

    // 绑定「一键清空」按钮点击逻辑，支持快速文字清除
    const clearBtn = $('manualClearText');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        taEl.value = '';
        state.manualTextWithAnnotations = '';
        updateManualHighlighter();
        showToast('已清空文本输入框', 'ok');
      });
    }
    
    // 绑定手动预览区的点击事件委托，实现极致的一键撤销与重新弹窗修改
    hlEl.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.ann-remove');
      const polyTag = e.target.closest('.poly-highlight');
      const pauseTag = e.target.closest('.ann-pause');
      
      if (removeBtn) {
        // 1. 点击了右上角微型 "×" 按钮，直接撤销抹除该标注
        e.stopPropagation();
        const idx = parseInt(removeBtn.dataset.idx, 10);
        state.manualTextWithAnnotations = removeAnnotationByIndex(state.manualTextWithAnnotations, idx);
        
        const { cleanText } = parseTextAndGenerateAnnotations(state.manualTextWithAnnotations);
        taEl.value = cleanText;
        updateManualHighlighter();
        showToast('已撤销配置', 'ok');
        
      } else if (polyTag) {
        // 2. 点击了多音字标签本身，重新弹出拼音选择弹窗修改
        const idx = parseInt(polyTag.dataset.idx, 10);
        const char = polyTag.textContent.slice(0, 1);
        
        openPolyPopup({
          title: `修改「${char}」的读音`,
          char,
          onSelect: (entry) => {
            const phonetic = entry.phonetic || entry.pinyin;
            state.manualTextWithAnnotations = updateAnnotationByIndex(state.manualTextWithAnnotations, idx, phonetic);
            
            const { cleanText } = parseTextAndGenerateAnnotations(state.manualTextWithAnnotations);
            taEl.value = cleanText;
            updateManualHighlighter();
            showToast(`发音已修改为 ${entry.pinyin}`, 'ok');
            $('polyPopup').classList.add('hidden');
          }
        });
        
      } else if (pauseTag) {
        // 3. 点击了停顿标签本身，重新弹出停顿选择弹窗修改
        const idx = parseInt(pauseTag.dataset.idx, 10);
        openPausePopup((duration) => {
          const durMs = Number.parseInt(duration, 10) || 500;
          state.manualTextWithAnnotations = updateAnnotationByIndex(state.manualTextWithAnnotations, idx, durMs);
          
          const { cleanText } = parseTextAndGenerateAnnotations(state.manualTextWithAnnotations);
          taEl.value = cleanText;
          updateManualHighlighter();
          showToast(`停顿时间已修改为 ${durMs}ms`, 'ok');
        });
      }
    });
  }
  $('manualSingleCorrect').addEventListener('click', handleManualSingleCorrect);
  $('manualBatchCorrect').addEventListener('click', handleManualBatchCorrect);
  $('manualInsertPause').addEventListener('click', handleManualInsertPause);
  
  $('subtitleSingleCorrect').addEventListener('click', handleSubtitleSingleCorrect);
  $('subtitleBatchCorrect').addEventListener('click', handleSubtitleBatchCorrect);
$('subtitleInsertPause').addEventListener('click', handleSubtitleInsertPause);
$('subtitleImportSrtBtn')?.addEventListener('click', importSrtFile);
$('subtitleDisableAllBtn').addEventListener('click', toggleDisableAll);
  $('subtitleModeLabel').addEventListener('click', () => {
    if (activeSubtitleFrame !== null) {
      activeSubtitleFrame = null;
      suppressActivation = true;
      renderSubtitleTable();
      setTimeout(() => { suppressActivation = false; }, 0);
    }
  });

  $('addPolyEntry').addEventListener('click', openAddPolyEntry);
  $('polyEntrySave').addEventListener('click', async () => {
    const char = $('polyEntryChar').value.trim();
    if (!char) { log('请填写汉字'); showToast('请填写汉字', 'info'); return; }

    // 过滤出有有效拼音输入的行
    const validRows = activePinyinRows.filter(row => row.phonetic.trim());
    if (!validRows.length) {
      log('请至少填写一个拼音');
      showToast('请至少填写一个拼音', 'info');
      return;
    }

    // 校验和转换拼音格式
    const entries = [];
    for (let i = 0; i < validRows.length; i++) {
      const row = validRows[i];
      const phoneticInput = row.phonetic.trim();
      
      // 检验拼音数字声调格式是否正确（例如必须以 1-5 的数字结尾）
      const cleaned = phoneticInput.replace(/\s+/g, '').toLowerCase();
      if (!/^([a-züü]+)[1-5]$/.test(cleaned)) {
        log(`拼音格式不正确: "${phoneticInput}"。请使用带声调数字的格式，如 xing 2 或 de 5`);
        showToast(`拼音 "${phoneticInput}" 格式不正确。请使用带声调数字格式，如 xing 2`, 'error');
        return;
      }

      const phonetic = cleaned.replace(/^([a-züü]+)([1-5])$/, '$1 $2');
      const pinyin = phoneticToPinyin(phoneticInput);
      entries.push({
        char,
        pinyin,
        phonetic,
        context: row.context.trim()
      });
    }

    const editChar = $('polyEntrySave').dataset.editChar;
    if (editChar) {
      // 编辑模式下：先过滤清除掉原库中该汉字的所有读音记录，以实现全量覆盖更新
      state.polyphonicDict = state.polyphonicDict.filter(e => e.char !== editChar);
    }

    // 将新生成的一个或多个读音实体项追加到词典中
    state.polyphonicDict.push(...entries);

    renderPolyDictTable();
    renderQuickPolyList();
    $('polyEntryPopup').classList.add('hidden');
    
    // 全自动、无缝静默落盘保存到硬盘，消除丢失Bug
    await savePolyDictAutomatically();
  });

  $('polyEntryCancel').addEventListener('click', () => $('polyEntryPopup').classList.add('hidden'));
  $('polyEntryClose').addEventListener('click', () => $('polyEntryPopup').classList.add('hidden'));
  $('polyPopupClose').addEventListener('click', () => $('polyPopup').classList.add('hidden'));
  $('pausePopupClose').addEventListener('click', () => $('pausePopup').classList.add('hidden'));
  const openPolyBtn = $('openPolyDictFromManual');
  if (openPolyBtn) {
    openPolyBtn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn[data-tab]').forEach(item => item.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(item => item.classList.remove('active'));
      document.querySelector('.nav-btn[data-tab="settings"]').classList.add('active');
      $('settings').classList.add('active');
    });
  }

  for (const id of ['azureRegion', 'azureKey', 'rememberKey']) {
    $(id).addEventListener('input', updateSaveButton);
    $(id).addEventListener('change', updateSaveButton);
  }

  // 绑定参数预设选择和保存事件
  for (const prefix of ['subtitle', 'manual']) {
    const sel = $(`${prefix}PresetSelect`);
    const btn = $(`save${prefix.charAt(0).toUpperCase() + prefix.slice(1)}Preset`);
    if (sel) {
      sel.addEventListener('change', (e) => {
        applyPresetToPanel(prefix, e.target.value);
      });
    }
    if (btn) {
      btn.addEventListener('click', () => {
        savePresetFromPanel(prefix);
      });
    }
  }

  const azureKeyEl = $('azureKey');
  if (azureKeyEl) {
    azureKeyEl.addEventListener('focus', () => {
      if (azureKeyEl.value === '__SAVED_KEY_PLACEHOLDER__') {
        azureKeyEl.value = '';
        updateSaveButton();
      }
    });
    azureKeyEl.addEventListener('blur', () => {
      if (azureKeyEl.value.trim() === '') {
        if (state.settings && state.settings.hasAzureKey) {
          azureKeyEl.value = '__SAVED_KEY_PLACEHOLDER__';
          updateSaveButton();
        }
      }
    });
  }

  for (const id of ['subtitleRate', 'subtitlePitch', 'subtitleStyledegree', 'subtitleVolume',
                    'manualRate', 'manualPitch', 'manualStyledegree', 'manualVolume']) {
    const el = $(id);
    if (el) {
      el.addEventListener('input', updateRangeLabels);
      el.addEventListener('change', updateRangeLabels);
    }
  }

  $('polyDictSearch').addEventListener('input', renderPolyDictTable);
  $('polyBuiltinSearch').addEventListener('input', renderBuiltinPolyTable);

  // 多音字字典管理：内置/自定义选项卡切换
  document.querySelectorAll('.poly-dict-tab').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.poly-dict-tab').forEach(item => item.classList.remove('active'));
      document.querySelectorAll('.poly-dict-panel').forEach(item => item.classList.remove('active'));
      button.classList.add('active');
      const panel = document.querySelector(`.poly-dict-panel[data-poly-panel="${button.dataset.polyTab}"]`);
      if (panel) panel.classList.add('active');
      // 切换到内置选项卡时重新渲染，以适应当前窗口宽度的列数
      if (button.dataset.polyTab === 'builtin') renderBuiltinPolyTable();
    });
  });

  // 连接设置：自填 Key / 登录账号 选项卡切换
  document.querySelectorAll('.auth-tab').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach(item => item.classList.remove('active'));
      document.querySelectorAll('.auth-panel').forEach(item => item.classList.remove('active'));
      document.querySelectorAll('.auth-tab').forEach(item => item.setAttribute('aria-selected', 'false'));
      button.classList.add('active');
      button.setAttribute('aria-selected', 'true');
      const panel = document.querySelector(`.auth-panel[data-auth-panel="${button.dataset.authTab}"]`);
      if (panel) panel.classList.add('active');
    });
  });

  // 登录弹窗：打开/关闭
  const openLoginPopup = () => {
    const popup = $('loginPopup');
    if (!popup) return;
    popup.classList.remove('hidden');
    const emailInput = $('loginEmail');
    if (emailInput) setTimeout(() => emailInput.focus(), 50);
  };
  const closeLoginPopup = () => {
    const popup = $('loginPopup');
    if (popup) popup.classList.add('hidden');
  };
  const openLoginPopupBtn = $('openLoginPopup');
  if (openLoginPopupBtn) openLoginPopupBtn.addEventListener('click', openLoginPopup);
  const loginPopupCloseBtn = $('loginPopupClose');
  if (loginPopupCloseBtn) loginPopupCloseBtn.addEventListener('click', closeLoginPopup);

  // ═══ 云端账号：刷新账号状态 + 配额显示 ═══

  /**
   * 根据认证状态自动切换"连接设置"的选项卡：
   *   1. 有自填 Azure Key → "自填 Key"（优先级最高，配音走本地 key 路线）
   *   2. 无自填 key + 已登录云端 → "登录账号"
   *   3. 都没有 → "自填 Key"（默认，引导用户填写）
   * 仅在用户切到设置页时触发，不干扰用户手动切换。
   */
  async function autoSelectAuthTab() {
    try {
      const hasAzureKey = state.settings?.hasAzureKey;
      if (hasAzureKey) {
        const tabBtn = document.querySelector('.auth-tab[data-auth-tab="apikey"]');
        if (tabBtn && !tabBtn.classList.contains('active')) tabBtn.click();
        return;
      }
      const cloudState = await window.momoVoiceSub.cloudGetState();
      const targetTab = cloudState.isLoggedIn ? 'account' : 'apikey';
      const tabBtn = document.querySelector(`.auth-tab[data-auth-tab="${targetTab}"]`);
      if (tabBtn && !tabBtn.classList.contains('active')) {
        tabBtn.click();
      }
    } catch {
      // 查询失败时不干扰默认状态（保持"自填 Key"激活）
    }
  }

  async function refreshCloudAccount() {
    const loadingDiv = $('accountLoading');
    const loggedOutDiv = $('accountLoggedOut');
    const loggedInDiv = $('accountLoggedIn');
    if (!loggedOutDiv || !loggedInDiv) return;

    // 进入加载态：隐藏 loggedOut/loggedIn，显示 loading
    // 避免 DOMContentLoaded 后异步查询期间闪现"登录账号"按钮
    if (loadingDiv) loadingDiv.classList.remove('hidden');
    loggedOutDiv.classList.add('hidden');
    loggedInDiv.classList.add('hidden');

    try {
      const state = await window.momoVoiceSub.cloudGetState();
      if (!state.isLoggedIn) {
        if (loadingDiv) loadingDiv.classList.add('hidden');
        loggedOutDiv.classList.remove('hidden');
        return;
      }

      // 已登录，获取配额
      const quotaRes = await window.momoVoiceSub.cloudGetQuota();
      if (!quotaRes.isLoggedIn) {
        // token 过期
        if (loadingDiv) loadingDiv.classList.add('hidden');
        loggedOutDiv.classList.remove('hidden');
        showToast('登录已过期，请重新登录', 'info');
        openLoginPopup();
        return;
      }

      if (loadingDiv) loadingDiv.classList.add('hidden');
      loggedOutDiv.classList.add('hidden');
      loggedInDiv.classList.remove('hidden');

      // 更新账号信息
      const emailEl = $('accountEmail');
      if (emailEl) emailEl.textContent = state.email || quotaRes.quota?.email || 'user@example.com';

      const planBadge = $('accountPlanBadge');
      if (planBadge) {
        const plan = quotaRes.quota?.plan || 'free';
        planBadge.textContent = plan === 'free' ? '免费版' : (plan === 'pro' ? '专业版' : plan);
      }

      const planExpire = $('accountPlanExpire');
      if (planExpire) {
        const exp = quotaRes.quota?.expires_at;
        planExpire.textContent = exp ? `有效期至 ${new Date(exp).toLocaleDateString()}` : '长期有效';
      }

      // 更新配额显示
      const std = quotaRes.quota?.std_chars;
      if (std) {
        const stdLabelEl = $('quotaStdLabel');
        if (stdLabelEl) stdLabelEl.textContent = `标准语音（${std.reset_period === 'monthly' ? '本月' : '终身'}）`;
        const leftEl = $('quotaCharsLeft');
        const totalEl = $('quotaCharsTotal');
        const barEl = $('quotaCharsBar');
        if (leftEl) leftEl.textContent = (std.remaining ?? 0).toLocaleString();
        if (totalEl) totalEl.textContent = (std.total ?? 0).toLocaleString();
        if (barEl && std.total > 0) {
          const pct = Math.max(0, Math.min(100, (std.remaining / std.total) * 100));
          barEl.style.width = `${pct}%`;
        }
      }

      // 神经语音配额
      const neural = quotaRes.quota?.neural_chars;
      if (neural) {
        const neuralLabelEl = $('quotaNeuralLabel');
        if (neuralLabelEl) neuralLabelEl.textContent = `神经语音（${neural.reset_period === 'monthly' ? '本月' : '终身'}）`;
        const nLeftEl = $('quotaNeuralLeft');
        const nTotalEl = $('quotaNeuralTotal');
        const nBarEl = $('quotaNeuralBar');
        if (nLeftEl) nLeftEl.textContent = (neural.remaining ?? 0).toLocaleString();
        if (nTotalEl) nTotalEl.textContent = (neural.total ?? 0).toLocaleString();
        if (nBarEl && neural.total > 0) {
          const nPct = Math.max(0, Math.min(100, (neural.remaining / neural.total) * 100));
          nBarEl.style.width = `${nPct}%`;
        }
      }

      const dev = quotaRes.quota?.devices;
      if (dev) {
        const devEl = $('quotaDevices');
        const devMaxEl = $('quotaDevicesMax');
        if (devEl) devEl.textContent = String(dev.count ?? 0);
        if (devMaxEl) devMaxEl.textContent = dev.is_unlimited ? '无限制' : String(dev.max ?? 0);
      }

      // 已登录状态下，后台静默注册/刷新设备绑定（确保 Web 端能看到本机）
      window.momoVoiceSub.cloudRegisterDevice().catch(err => {
        log(`[云端] 设备注册失败: ${err.message}`);
      });
    } catch (err) {
      log(`[云端] 刷新账号状态失败: ${err.message}`);
      // 查询失败时降级为未登录状态（隐藏 loading，显示登录按钮）
      if (loadingDiv) loadingDiv.classList.add('hidden');
      loggedOutDiv.classList.remove('hidden');
      loggedInDiv.classList.add('hidden');
    }
  }

  // ═══ 登录表单：调用云端 API ═══
  const signinForm = $('loginSigninForm');
  if (signinForm) {
    signinForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('loginEmail')?.value?.trim();
      const password = $('loginPassword')?.value;
      if (!email || !password) {
        showToast('请输入邮箱和密码', 'error');
        return;
      }

      const submitBtn = signinForm.querySelector('.login-submit');
      const originalText = submitBtn?.textContent;
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.classList.add('btn-loading');
        submitBtn.innerHTML = '<span class="btn-spinner"></span><span class="btn-loading-text">登录中...</span>';
      }

      try {
        await window.momoVoiceSub.cloudLogin(email, password);
        showToast('登录成功', 'ok');
        closeLoginPopup();
        if ($('loginPassword')) $('loginPassword').value = '';
        await refreshCloudAccount();
        // 自动切换到"登录账号"面板
        const accountTab = document.querySelector('.auth-tab[data-auth-tab="account"]');
        if (accountTab) accountTab.click();
      } catch (err) {
        showToast(err.message || '登录失败', 'error');
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.classList.remove('btn-loading');
          submitBtn.textContent = originalText || '登录';
        }
      }
    });
  }

  // 微信登录（暂未启用）
  const wechatBtn = $('loginWechat');
  if (wechatBtn) {
    wechatBtn.addEventListener('click', () => {
      showToast('微信扫码登录暂未启用，请用邮箱登录', 'info');
    });
  }

  // 跳转到官网注册
  const signupWebLink = $('openSignupWeb');
  if (signupWebLink) {
    signupWebLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.momoVoiceSub.openExternal(window.momoVoiceSub.webBaseUrl + '/login');
    });
  }

  // 忘记密码 → 跳转官网
  const forgotLink = $('loginForgot');
  if (forgotLink) {
    forgotLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.momoVoiceSub.openExternal(window.momoVoiceSub.webBaseUrl + '/login');
    });
  }

  // 用户协议 → 在浏览器打开
  const termsLink = $('openTerms');
  if (termsLink) {
    termsLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.momoVoiceSub.openExternal(window.momoVoiceSub.webBaseUrl + '/terms');
    });
  }

  // 隐私政策 → 在浏览器打开
  const privacyLink = $('openPrivacy');
  if (privacyLink) {
    privacyLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.momoVoiceSub.openExternal(window.momoVoiceSub.webBaseUrl + '/privacy');
    });
  }

  // 退出登录
  const logoutBtn = $('accountLogout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      const confirmed = await showConfirmDialog({
        message: '确认退出云端登录？',
        detail: '退出后将无法使用云端配音配额，音色列表也会被清空。',
        confirmText: '退出登录',
        danger: true,
      });
      if (!confirmed) return;
      await window.momoVoiceSub.cloudLogout();
      // 退出后清空内存中的音色列表并重绘，让 UI 与实际可用状态一致
      state.voices = [];
      populateVoices();
      await refreshCloudAccount();
      showToast('已退出登录', 'info');
    });
  }

  // 刷新配额
  const refreshQuotaBtn = $('refreshQuota');
  if (refreshQuotaBtn) {
    refreshQuotaBtn.addEventListener('click', async () => {
      refreshQuotaBtn.disabled = true;
      try {
        await refreshCloudAccount();
        showToast('配额已刷新', 'ok');
      } catch (err) {
        showToast(err.message || '刷新失败', 'error');
      } finally {
        refreshQuotaBtn.disabled = false;
      }
    });
  }

  // 续费/升级 → 跳转官网
  const buyPlanBtn = $('openBuyPlan');
  if (buyPlanBtn) {
    buyPlanBtn.addEventListener('click', () => {
      window.momoVoiceSub.openExternal(window.momoVoiceSub.webBaseUrl + '/pricing');
    });
  }

  // 刷新音色（云端模式）
  const cloudRefreshVoicesBtn = $('cloudRefreshVoicesBtn');
  if (cloudRefreshVoicesBtn) {
    cloudRefreshVoicesBtn.addEventListener('click', async () => {
      cloudRefreshVoicesBtn.disabled = true;
      const originalText = cloudRefreshVoicesBtn.textContent;
      cloudRefreshVoicesBtn.textContent = '刷新中...';
      try {
        const voices = await window.momoVoiceSub.cloudRefreshVoices();
        state.voices = voices;
        populateVoices();
        showToast(`已刷新 ${voices.length} 个音色`, 'ok');
      } catch (err) {
        showToast(err.message || '刷新音色失败', 'error');
      } finally {
        cloudRefreshVoicesBtn.disabled = false;
        cloudRefreshVoicesBtn.textContent = originalText || '刷新音色';
      }
    });
  }

  // 初始化时检查云端登录状态
  refreshCloudAccount().catch(err => log(`[云端] 初始化失败: ${err.message}`));

  window.addEventListener('beforeunload', () => {
    window.momoVoiceSub.cleanupResolveInterface();
  });

  window.momoVoiceSub.onLog((payload) => log(payload));

  document.addEventListener('click', (e) => {
    if (e.target === $('polyPopup')) $('polyPopup').classList.add('hidden');
    if (e.target === $('pausePopup')) $('pausePopup').classList.add('hidden');
    if (e.target === $('loginPopup')) $('loginPopup').classList.add('hidden');
  });

  // Esc 键关闭登录弹窗
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const lp = $('loginPopup');
      if (lp && !lp.classList.contains('hidden')) lp.classList.add('hidden');
    }
  });
}

// ─── Init ───

window.addEventListener('DOMContentLoaded', async () => {
  setupEvents();

  const nodeWarningClose = $('nodeWarningClose');
  if (nodeWarningClose) {
    nodeWarningClose.addEventListener('click', () => {
      const banner = $('nodeWarningBanner');
      if (banner) banner.classList.add('hidden');
    });
  }

  // 恢复手动配音的上次文本记忆，消除重启自动清空之缺陷
  try {
    const savedAnnotatedText = localStorage.getItem('manualTextWithAnnotations');
    if (savedAnnotatedText) {
      state.manualTextWithAnnotations = savedAnnotatedText;
      const { cleanText } = parseTextAndGenerateAnnotations(savedAnnotatedText);
      const taEl = $('manualText');
      if (taEl) {
        taEl.value = cleanText;
      }
    }
  } catch (err) {
    log('恢复上次文本失败: ' + err.message);
  }

  try {
    await refreshState();
    renderQuickPolyList();
    updateManualHighlighter();
    checkForUpdate(); // 启动后异步检查更新
    // 点击版本号手动检查更新（排除 momoVoicesub 链接点击）
    const appVerEl = document.getElementById('appVersion');
    if (appVerEl) {
      appVerEl.addEventListener('click', (e) => {
        if (e.target && (e.target.id === 'appVersionLink' || (e.target).closest('#appVersionLink'))) return;
        checkForUpdate(true);
      });
    }
    log('插件已启动');
  } catch (error) {
    $('resolveStatus').textContent = friendlyErrorMessage(error);
    log(friendlyErrorMessage(error));
  }
});
