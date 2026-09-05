// @ts-ignore
import uxp from "uxp";
import { SettingsStore, VoiceInfo, LocalTtsSettings, DEFAULT_LOCAL_TTS } from "./lib/settings-store";
import { AzureTtsProvider, styleNameCn } from "./lib/azure-tts";
import { CloudClient } from "./lib/cloud-client";
import { CloudStore } from "./lib/cloud-store";
import { CloudTtsProvider } from "./lib/cloud-tts-provider";
import { DelegatingTtsProvider } from "./lib/delegating-tts-provider";
import { LocalTtsProvider, probeGptSoVits, stripAnnotations } from "./lib/local-tts-provider";
import {
  detect as engineDetect,
  scanModels as engineScanModels,
  scanReferenceAudios as engineScanReferenceAudios,
  lookupPromptText as engineLookupPromptText,
  launchGptSoVitsService,
  ScannedModel
} from "./lib/gptsovits-engine";
import { PremiereAdapter, SubtitleItem } from "./adapter/premiere-adapter";
import { promptLangToLocale } from "./lib/preview-text";
import polyphonicBuiltin from "./lib/polyphonic-builtin.json";

declare const require: any;
// 构建时由 Vite define 注入，取自项目根目录 VERSION 文件中的 com.momo.voicesub.pr.version 字段
declare const __APP_VERSION__: string;
// 云端环境地址（dev→localhost，prod→生产域名），由 Vite define 注入
declare const __API_BASE_URL__: string;
declare const __WEB_BASE_URL__: string;
declare const __IS_DEV__: boolean;

// 外部链接（用户协议/隐私政策/注册等）统一用生产域名，
// 因为 dev 本地没有这些页面，且 UXP openExternal 对 http 协议有限制
const WEB_PUBLIC_URL = 'https://momovoicesub.sxrec.com';
// 引用全局宿主
const ppro = require("premierepro");
// UXP shell 模块：用于用系统默认应用打开试听 wav 文件
const uxpShell = (uxp as any).shell;

// 实例化模块
const settingsStore = new SettingsStore();
const premiereAdapter = new PremiereAdapter();
const cloudClient = new CloudClient();
const cloudStore = new CloudStore();
let localProvider: LocalTtsProvider;
let ttsProvider: DelegatingTtsProvider;
let cachedEffectiveChannel = '';

function toggleHidden(el: Element | null, hidden: boolean) {
  if (el) el.classList.toggle('hidden', hidden);
}

function isLocalChannelActive(): boolean {
  return cachedEffectiveChannel === 'local';
}

// 全局状态管理
const state = {
  currentTab: "subtitles",
  projectName: "无活动工程",
  sequenceName: "无活动序列",
  fps: 24,
  audioTracks: [] as any[],
  captionTracks: [] as any[],

  // 当前加载的字幕轨索引
  activeCaptionTrackIndex: -2, // -2 表示初始未加载, -1 表示无轨道, >=0 表示选定的索引

  // 字幕列表
  subtitleItems: [] as SubtitleItem[],

  // 手动导入的 SRT 字幕备份
  // 当用户从「无字幕轨(手动SRT模式)」切换到某个字幕轨时，备份当前手动导入的 SRT；
  // 切回手动模式时恢复，避免用户辛苦导入的 SRT 因切换轨道而丢失。
  manualSrtItemsBackup: [] as SubtitleItem[],

  // 「连读」分组：集合内存放「与上一行合并为同一句话」的字幕 id。
  // 配音时同一连读组会拼成一段完整文本一次性送 TTS，从而得到连贯的语气。
  linkedIds: new Set<number>(),

  // 选中的音色
  selectedVoice: null as VoiceInfo | null,

  // 参数预设列表
  presets: [] as any[],
  defaultPresetId: 'preset-default',
  currentPresetName: "",

  // 音色列表（缓存）
  voices: [] as VoiceInfo[],
  localVoices: [] as VoiceInfo[],
  favoriteVoices: [] as string[],

  // ─── 标注编辑追踪（与达芬奇版对齐：文本框显示干净文字，底层存储带标注文本） ───
  // 最后聚焦的字幕输入框 id（点击按钮时焦点会转移到按钮，需提前记录）
  lastFocusedSubtitleId: 0 as number,
  // 最后聚焦的字幕选区（基于 cleanText 的位置）
  lastSubtitleSelection: { start: 0, end: 0 } as { start: number, end: number },
  // 手动配音文本框最后的选区（基于 cleanText 的位置）
  lastManualSelection: { start: 0, end: 0 } as { start: number, end: number },
  // 手动配音底层带标注文本（文本框只显示其 cleanText）
  manualTextWithAnnotations: "" as string,

  // 内置多音字字典是否已展开（默认收起，只显示2行）
  builtinPolyExpanded: false as boolean,

  // 更新检查
  updateStatus: 'idle' as string, // idle | checking | latest | available | error
  updateLatestVersion: '' as string
};

// ─── 音色选择器与声音形象辅助定义（与达芬奇版对齐） ───
const AVATAR_CONFIG: Record<string, { value: string; label: string; gender: string; img: string }> = {
  woman: { value: 'woman', label: '青年女声', gender: 'Female', img: './img/woman-default.jpg' },
  man: { value: 'man', label: '青年男声', gender: 'Male', img: './img/man-default.jpg' },
  littleGirl: { value: 'littleGirl', label: '小女孩', gender: 'Female', img: './img/littleGirl-default.jpg' },
  littleBoy: { value: 'littleBoy', label: '小男孩', gender: 'Male', img: './img/littleBoy-default.jpg' },
  grandma: { value: 'grandma', label: '老奶奶', gender: 'Female', img: './img/grandma-default.jpg' },
  grandpa: { value: 'grandpa', label: '老爷爷', gender: 'Male', img: './img/grandpa-default.jpg' }
};

const PROMPT_LANG_MAP: Record<string, string> = {
  zh: '中文',
  en: '英文',
  ja: '日文',
  ko: '韩文',
  yue: '粤语'
};

// 头像图片路径
const AVATAR_MAP: Record<string, string> = {
  Female: "./img/woman-default.jpg",
  Male: "./img/man-default.jpg",
  woman: "./img/woman-default.jpg",
  man: "./img/man-default.jpg",
  littleGirl: "./img/littleGirl-default.jpg",
  littleBoy: "./img/littleBoy-default.jpg",
  grandma: "./img/grandma-default.jpg",
  grandpa: "./img/grandpa-default.jpg"
};

function getVoiceAvatar(voice?: any): string {
  if (!voice) return "./img/woman-default.jpg";
  if (voice.avatar) return voice.avatar;
  if (voice.avatarType && AVATAR_CONFIG[voice.avatarType]) {
    return AVATAR_CONFIG[voice.avatarType].img;
  }
  if (voice.gender && AVATAR_MAP[voice.gender]) {
    return AVATAR_MAP[voice.gender];
  }
  return "./img/woman-default.jpg";
}

// 语种分组定义：match 函数判断 locale 是否属于该组，subs 为子分类
interface LocaleSubDef { label: string; locales: string[] | null }
interface LocaleGroupDef {
  id: string;
  label: string;
  match: (l: string) => boolean;
  subs: Record<string, LocaleSubDef>;
}

const LOCALE_GROUPS: LocaleGroupDef[] = [
  { id: 'all', label: '全部', match: () => true, subs: {} },
  {
    id: 'zh', label: '中文', match: (l) => !!l && (l.startsWith('zh-') || l.startsWith('yue-') || l.startsWith('wuu-')),
    subs: {
      'zh-CN': { label: '普通话', locales: ['zh-CN'] },
      'yue': { label: '粤语', locales: ['zh-HK', 'yue-CN'] },
      'zh-TW': { label: '国语(台湾)', locales: ['zh-TW'] },
    }
  },
  {
    id: 'en', label: 'English', match: (l) => !!l && l.startsWith('en-'),
    subs: {
      'en-US': { label: '美国', locales: ['en-US'] },
      'en-GB': { label: '英国', locales: ['en-GB'] },
      'en-AU': { label: '澳洲', locales: ['en-AU'] },
      'en-CA': { label: '加拿大', locales: ['en-CA'] },
      'en-IN': { label: '印度', locales: ['en-IN'] },
    }
  },
  { id: 'ja', label: '日本語', match: (l) => l === 'ja-JP', subs: {} },
  { id: 'ko', label: '한국어', match: (l) => l === 'ko-KR', subs: {} },
  {
    id: 'fr', label: 'Français', match: (l) => !!l && l.startsWith('fr-'),
    subs: {
      'fr-FR': { label: '法国', locales: ['fr-FR'] },
      'fr-CA': { label: '加拿大', locales: ['fr-CA'] },
      'fr-CH': { label: '瑞士', locales: ['fr-CH'] },
    }
  },
  {
    id: 'de', label: 'Deutsch', match: (l) => !!l && l.startsWith('de-'),
    subs: {
      'de-DE': { label: '德国', locales: ['de-DE'] },
      'de-AT': { label: '奥地利', locales: ['de-AT'] },
      'de-CH': { label: '瑞士', locales: ['de-CH'] },
    }
  },
  {
    id: 'es', label: 'Español', match: (l) => !!l && l.startsWith('es-'),
    subs: {
      'es-ES': { label: '西班牙', locales: ['es-ES'] },
      'es-MX': { label: '墨西哥', locales: ['es-MX'] },
    }
  },
  {
    id: 'pt', label: 'Português', match: (l) => !!l && l.startsWith('pt-'),
    subs: {
      'pt-BR': { label: '巴西', locales: ['pt-BR'] },
      'pt-PT': { label: '葡萄牙', locales: ['pt-PT'] },
    }
  },
  { id: 'it', label: 'Italiano', match: (l) => l === 'it-IT', subs: {} },
  { id: 'ru', label: 'Русский', match: (l) => l === 'ru-RU', subs: {} },
  {
    id: 'ar', label: 'العربية', match: (l) => !!l && l.startsWith('ar-'),
    subs: {
      'ar-SA': { label: '沙特', locales: ['ar-SA'] },
      'ar-EG': { label: '埃及', locales: ['ar-EG'] },
      'ar-AE': { label: '阿联酋', locales: ['ar-AE'] },
      'ar-DZ': { label: '阿尔及利亚', locales: ['ar-DZ'] },
      'ar-IQ': { label: '伊拉克', locales: ['ar-IQ'] },
      'ar-KW': { label: '科威特', locales: ['ar-KW'] },
      'ar-MA': { label: '摩洛哥', locales: ['ar-MA'] },
      'ar-QA': { label: '卡塔尔', locales: ['ar-QA'] },
      'ar-SY': { label: '叙利亚', locales: ['ar-SY'] },
    }
  },
  {
    id: 'other', label: '其他', match: (l) => {
      if (!l) return true;
      const known = ['zh-', 'yue-', 'wuu-', 'en-', 'ja-JP', 'ko-KR', 'fr-', 'de-', 'es-', 'pt-', 'it-IT', 'ru-RU', 'ar-'];
      return !known.some(p => l.startsWith(p) || l === p);
    }, subs: {}
  }
];

/** 判断 locale 是否被某个 sub 匹配 */
function subMatchesLocale(subDef: LocaleSubDef, locale: string): boolean {
  return subDef.locales ? subDef.locales.includes(locale) : false;
}

/** 移除微软语音 API 返回的技术后缀，例："晓晓 Dragon HD Flash Latest" → "晓晓" */
function cleanVoiceName(name: string): string {
  if (!name) return name;
  return name
    .replace(/\b(Dragon|HD|Flash|Latest|Neural|Multilingual|Online|TTS|V\d+|\d+[KkMm]Hz)\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function localeLabel(locale: string): string {
  const map: Record<string, string> = {
    'zh-CN': '普通话', 'zh-HK': '粤语(香港)', 'zh-TW': '国语(台湾)',
    'yue-CN': '粤语', 'wuu-CN': '吴语(上海)',
    'zh-CN-liaoning': '辽宁', 'zh-CN-guangxi': '广西',
    'zh-CN-henan': '河南', 'zh-CN-shaanxi': '陕西',
    'zh-CN-shandong': '山东', 'zh-CN-sichuan': '四川',
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

function isChineseLocale(locale: string): boolean {
  return !!locale && (locale.startsWith('zh-') || locale.startsWith('yue-') || locale.startsWith('wuu-'));
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
function voiceTypeCat(voice: any): string {
  const sn = voice.shortName || '';
  if (sn.includes(':')) return 'hd';
  if (/Multilingual/i.test(sn)) return 'multilingual';
  if (voice.styles && voice.styles.length > 0) return 'expressive';
  return 'standard';
}

// ─── 帮助函数 ───
function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function setPickerValue(picker: HTMLElement | null, val: string) {
  if (!picker) return;
  const menuItems = picker.querySelectorAll("sp-menu-item");
  menuItems.forEach((item: any) => {
    if (item.getAttribute("value") === val || item.value === val) {
      item.setAttribute("selected", "");
      item.selected = true;
    } else {
      item.removeAttribute("selected");
      item.selected = false;
    }
  });
}

function showToast(message: string, type: "success" | "error" | "info" | "warning" = "info") {
  const area = $("toastArea");
  if (!area) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerText = message;

  area.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 3500);
}

// 解析文本中的纠音和停顿标注，生成供 Synthesize 使用的 cleanText 与 annotations 数组
export function parseAnnotations(annotatedText: string): { cleanText: string, annotations: any[] } {
  let cleanText = "";
  const annotations: any[] = [];

  let i = 0;
  while (i < annotatedText.length) {
    const char = annotatedText[i];

    if (char === "[") {
      const closeIdx = annotatedText.indexOf("]", i);
      if (closeIdx !== -1) {
        const tagContent = annotatedText.slice(i + 1, closeIdx).trim();

        if (tagContent.startsWith("break:")) {
          const duration = tagContent.replace("break:", "");
          annotations.push({
            type: "break",
            duration: duration || "500ms",
            start: cleanText.length
          });
        } else {
          if (cleanText.length > 0) {
            annotations.push({
              type: "phoneme",
              phonetic: tagContent,
              start: cleanText.length - 1,
              end: cleanText.length
            });
          }
        }
        i = closeIdx + 1;
        continue;
      }
    }

    cleanText += char;
    i++;
  }

  return { cleanText, annotations };
}

// ─── 连读分组：把相邻字幕合并成一整句再配音 ───

/** 文本是否含中文/日文（决定自动补齐的标点用全角还是半角） */
function hasCJK(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]/.test(text || "");
}

/**
 * 两段字幕拼成一句话时中间需要补的分隔符。
 * 目的是让 TTS 把合并后的文本当成一句话来断句，而不是一长串没有停顿的字。
 * - 前段以空白结尾 → 不补
 * - 前段以句末标点结尾 → 英文补空格，中文不补
 * - 前段以句中停顿标点结尾 → 仅英文补空格
 * - 其余（裸字结尾）→ 中文补「，」，英文补 ", "
 */
function linkSeparator(prev: string, next: string): string {
  if (!prev) return "";
  const last = prev.slice(-1);
  if (/\s/.test(last)) return "";
  if (/[。！？!?…]/.test(last)) return /[A-Za-z0-9]/.test(last) ? " " : "";
  if (/[，、；：,;:]/.test(last)) return /[A-Za-z0-9]/.test((next || "").slice(0, 1)) ? " " : "";
  return hasCJK(prev) ? "，" : ", ";
}

/** 合并后的整句末尾若没有句末标点，补一个句号，避免 TTS 读成"话没说完"的悬浮语气 */
function finalizeLinkedSentence(text: string): string {
  if (!text) return text;
  const last = text.slice(-1);
  if (/[。！？!?…]/.test(last)) return text;
  if (/[，、；：,;:]/.test(last)) return text.slice(0, -1) + (hasCJK(text) ? "。" : ".");
  return text + (hasCJK(text) ? "。" : ".");
}

/**
 * 把一个连读组内所有字幕的（带标注）文本合并成一段，
 * 并按拼接后 cleanText 的新位置修正 annotations 的 start/end 偏移。
 */
function mergeLinkedGroupTexts(rawTexts: string[]): { cleanText: string, annotations: any[] } {
  const parts = rawTexts.map(t => parseAnnotations(t || ""));
  let cleanText = "";
  const annotations: any[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) cleanText += linkSeparator(cleanText, parts[i].cleanText);
    const offset = cleanText.length;
    for (const ann of parts[i].annotations || []) {
      const s = ann.start || 0;
      annotations.push({ ...ann, start: s + offset, end: (ann.end != null ? ann.end : s) + offset });
    }
    cleanText += parts[i].cleanText;
  }
  return { cleanText: finalizeLinkedSentence(cleanText), annotations };
}

/**
 * 按「连读」标记把勾选中的字幕切分为若干「配音单元」。
 * 未勾选的行不参与分组，且会强制断开它所在的组。
 */
function buildSubtitleLinkGroups(checkedIds: number[]): { items: SubtitleItem[], start: number, end: number }[] {
  const checked = new Set(checkedIds);
  const groups: { items: SubtitleItem[], start: number, end: number }[] = [];
  let cur: { items: SubtitleItem[], start: number, end: number } | null = null;
  for (const item of state.subtitleItems) {
    if (!checked.has(item.id)) { cur = null; continue; }
    const linked = !!cur && state.linkedIds.has(item.id);
    if (!cur || !linked) {
      cur = { items: [], start: item.start, end: item.end };
      groups.push(cur);
    }
    cur.items.push(item);
    if (item.end > cur.end) cur.end = item.end;
  }
  return groups;
}

/** 计算当前有多少组连读（组内 >1 条） */
function countLinkedGroups(): number {
  return buildSubtitleLinkGroups(state.subtitleItems.map(i => i.id)).filter(g => g.items.length > 1).length;
}

// ─── 设定停顿选项（与 Azure TTS <break> 标签格式对齐） ───
// value 直接写入 [break:value] 标签，由 parseAnnotations 解析后交给 applyManualAnnotations 生成 SSML
const PAUSE_OPTIONS = [
  { value: "none", label: "强制不停顿" },
  { value: "50ms", label: "50ms" },
  { value: "100ms", label: "100ms" },
  { value: "250ms", label: "250ms" },
  { value: "500ms", label: "500ms" },
  { value: "1s", label: "1秒" },
  { value: "2s", label: "2秒" }
];

// ─── 多音字字典辅助函数 ───

/** 合并用户自定义字典与内置字典，按 char_phonetic 去重 */
function getPolyphonicDict(userDict: any[]): any[] {
  const all = [...(userDict || [])];
  const existingKeys = new Set(all.map(e => `${e.char}_${e.phonetic}`));
  for (const builtin of polyphonicBuiltin) {
    const key = `${builtin.char}_${builtin.phonetic}`;
    if (!existingKeys.has(key)) {
      all.push(builtin);
      existingKeys.add(key);
    }
  }
  return all;
}

/** 查找指定汉字的所有多音字记录 */
function findPolyEntries(char: string, dict: any[]): any[] {
  return dict.filter(e => e.char === char);
}

/** 文本 token 类型：普通字符 / 停顿标记 / 已标注拼音的字符 */
interface TextToken {
  type: "char" | "break" | "annotated";
  char?: string;
  phonetic?: string;
  isPoly?: boolean;
  isCorrected?: boolean;
  breakText?: string;
}

/**
 * 将带标注的文本解析为 token 数组，用于批量纠音弹窗展示。
 * 识别两种标注格式：
 *   1. [break:500ms]  → 停顿 token（原样保留，不参与纠音）
 *   2. 字[phonetic]   → 已纠音 token（可修改拼音）
 * 其余字符按普通字符处理，若在多音字字典中则标记 isPoly。
 */
function parseTextToTokens(text: string, dict: any[]): TextToken[] {
  const tokens: TextToken[] = [];
  const polySet = new Set(dict.map(e => e.char));

  let i = 0;
  while (i < text.length) {
    // 检测 [break:...] 停顿标记
    if (text[i] === "[") {
      const closeIdx = text.indexOf("]", i);
      if (closeIdx !== -1) {
        const tagContent = text.slice(i + 1, closeIdx).trim();
        if (tagContent.startsWith("break:")) {
          tokens.push({ type: "break", breakText: text.slice(i, closeIdx + 1) });
          i = closeIdx + 1;
          continue;
        }
      }
    }

    // 检测 字[phonetic] 已纠音标注
    if (i + 1 < text.length && text[i + 1] === "[") {
      const closeIdx = text.indexOf("]", i + 2);
      if (closeIdx !== -1) {
        const tagContent = text.slice(i + 2, closeIdx).trim();
        // 确保不是 break 标签（break 标签前不应有汉字前缀，但防御性检查）
        if (!tagContent.startsWith("break:")) {
          const char = text[i];
          tokens.push({
            type: "annotated",
            char,
            phonetic: tagContent,
            isPoly: polySet.has(char),
            isCorrected: true
          });
          i = closeIdx + 1;
          continue;
        }
      }
    }

    // 普通字符
    const char = text[i];
    tokens.push({
      type: "char",
      char,
      isPoly: polySet.has(char),
      isCorrected: false
    });
    i++;
  }

  return tokens;
}

/** 将 token 数组重建为带标注的文本（保留停顿标记，更新纠音标注） */
function reconstructText(tokens: TextToken[]): string {
  let result = "";
  for (const tok of tokens) {
    switch (tok.type) {
      case "char":
        result += tok.char || "";
        break;
      case "break":
        result += tok.breakText || "";
        break;
      case "annotated":
        result += `${tok.char}[${tok.phonetic || ""}]`;
        break;
    }
  }
  return result;
}

// ─── 标注文本辅助函数（与达芬奇版对齐：文本框显示干净文字，预览层显示标注） ───

/** HTML 转义，防止预览层注入 */
function escapeHtml(text: string): string {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 将 cleanText 中的位置映射到 annotatedText 中的位置。
 * annotatedText 里的 [break:xxx] 和 字[phonetic] 标记不占 cleanText 位，
 * 需要跳过这些标记的长度才能找到对应的 annotatedText 索引。
 */
function getAnnotatedPos(annotatedText: string, plainPos: number): number {
  if (!annotatedText) return plainPos;
  // 匹配 [break:xxx] 或 [phonetic] 形式的标记
  const regex = /\[[^\]]+\]/g;
  let match: RegExpExecArray | null;
  let skippedLength = 0;
  while ((match = regex.exec(annotatedText)) !== null) {
    const matchStart = match.index;
    const matchLength = match[0].length;
    // 标记在 annotatedText 中的起始位置（减去之前跳过的长度）即对应 cleanText 中的位置
    if (matchStart - skippedLength <= plainPos) {
      skippedLength += matchLength;
    } else {
      break;
    }
  }
  return plainPos + skippedLength;
}

/**
 * 用户在文本框中编辑了干净文字后，尽可能保留原有的标注。
 * 思路：逐字符对比 oldClean 和 newPlain，把旧标注"搬"到新文本的对应字符上。
 */
function syncAnnotatedText(oldAnnotated: string, newPlain: string): string {
  if (!oldAnnotated) return newPlain;
  const { cleanText: oldPlain, annotations } = parseAnnotations(oldAnnotated);
  if (oldPlain === newPlain) return oldAnnotated;

  // 构建旧 cleanText 每个字符对应的标注列表
  const charAnns: { phoneme: string | null; breaks: string[] }[] = [];
  for (let i = 0; i < oldPlain.length; i++) {
    charAnns.push({ phoneme: null, breaks: [] });
  }
  // 末尾停顿（start 超出文本长度，插在最后一个字符之后）
  const trailingBreaks: string[] = [];
  for (const ann of annotations) {
    if (ann.type === "phoneme") {
      const idx = ann.start;
      if (idx >= 0 && idx < charAnns.length) {
        charAnns[idx].phoneme = ann.phonetic;
      }
    } else if (ann.type === "break") {
      // break 标注的 start 表示插入位置（在 cleanText 的 start 之前）
      if (ann.start >= 0 && ann.start < charAnns.length) {
        charAnns[ann.start].breaks.push(ann.duration);
      } else if (ann.start >= charAnns.length) {
        trailingBreaks.push(ann.duration);
      }
    }
  }

  // 用 LCS 思路简化：按字符匹配，把旧标注迁移到新文本
  // 这里用简单策略：找到最长公共前缀和后缀，中间部分丢弃标注
  let prefixLen = 0;
  const minLen = Math.min(oldPlain.length, newPlain.length);
  while (prefixLen < minLen && oldPlain[prefixLen] === newPlain[prefixLen]) {
    prefixLen++;
  }
  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    oldPlain[oldPlain.length - 1 - suffixLen] === newPlain[newPlain.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  let result = "";

  // 前缀部分：保留标注（break 在字符之前输出，与 parseAnnotations 的 start 语义一致，
  // 否则每次编辑迁移 break 都会后移一格）
  for (let i = 0; i < prefixLen; i++) {
    const ca = charAnns[i];
    if (ca && ca.breaks.length > 0) {
      for (const b of ca.breaks) {
        result += `[break:${b}]`;
      }
    }
    result += newPlain[i];
    if (ca && ca.phoneme) {
      result += `[${ca.phoneme}]`;
    }
  }

  // 中间部分（新增/修改的字符）：无标注
  result += newPlain.slice(prefixLen, newPlain.length - suffixLen);

  // 后缀部分：保留标注（同样 break 在字符之前输出）
  for (let i = 0; i < suffixLen; i++) {
    const newIdx = newPlain.length - suffixLen + i;
    const oldIdx = oldPlain.length - suffixLen + i;
    const ca = charAnns[oldIdx];
    if (ca && ca.breaks.length > 0) {
      for (const b of ca.breaks) {
        result += `[break:${b}]`;
      }
    }
    result += newPlain[newIdx];
    if (ca && ca.phoneme) {
      result += `[${ca.phoneme}]`;
    }
  }

  // 末尾停顿（插在全文之后）
  for (const b of trailingBreaks) {
    result += `[break:${b}]`;
  }

  return result;
}

/**
 * 将带标注的文本渲染为高亮预览 HTML。
 * 字[phonetic] → 高亮标签显示"字[phonetic]"，附带关闭按钮可撤销
 * [break:xxx] → 停顿标签显示"⏸ xxx"，附带关闭按钮可撤销
 * 每个标签带 data-idx 索引，供 removeAnnotationByIndex 定位
 */
function highlightText(text: string): string {
  if (!text) return "";
  const escaped = escapeHtml(text);
  let count = 0;
  // 匹配 字[phonetic] 或 [break:xxx]
  return escaped.replace(
    /(?:(.)\[([a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ1-5\s]+)\]|(\[break:([^\]]+)\]))/g,
    (match, char, phonetic, _breakFull, breakDuration) => {
      void match; void _breakFull;
      const idx = count++;
      if (char) {
        return `<span class="poly-highlight" data-idx="${idx}">${char}[${phonetic}]<span class="ann-remove" data-idx="${idx}">×</span></span>`;
      } else {
        return `<span class="ann-pause" data-idx="${idx}">⏸ ${breakDuration}<span class="ann-remove" data-idx="${idx}">×</span></span>`;
      }
    }
  );
}

/**
 * 按索引移除带标注文本中的单个标注（多音字纠音或停顿标记）。
 * 多音字：保留汉字本身，去掉 [phonetic] 标注
 * 停顿：直接去掉 [break:xxx] 标记
 */
function removeAnnotationByIndex(annotatedText: string, targetIndex: number): string {
  if (!annotatedText) return "";
  const regex = /(?:(.)\[([a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ1-5\s]+)\]|(\[break:[^\]]+\]))/g;
  let match: RegExpExecArray | null;
  let currentIndex = 0;
  let result = "";
  let lastIndex = 0;

  while ((match = regex.exec(annotatedText)) !== null) {
    if (currentIndex === targetIndex) {
      result += annotatedText.slice(lastIndex, match.index);
      if (match[1]) {
        // 多音字：保留汉字，去掉 [phonetic]
        result += match[1];
      }
      // 停顿：直接去掉 [break:xxx]
      lastIndex = regex.lastIndex;
      result += annotatedText.slice(lastIndex);
      return result;
    }
    currentIndex++;
  }
  return annotatedText;
}

/** 判断带标注文本是否包含任何标注（用于决定是否显示预览层） */
function hasAnnotations(text: string): boolean {
  if (!text) return false;
  // 匹配 字[phonetic] 或 [break:xxx]
  return /(?:.\[[a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ1-5\s]+\]|\[break:[^\]]+\])/.test(text);
}

/**
 * 将旧字幕列表中的标注（多音字纠音、停顿标记）合并到新字幕列表。
 * 根据 id 匹配，若旧字幕含标注且其 cleanText 与新字幕 text 相同，则保留旧标注。
 * 这样在工程刷新、轨道变化等重新读取字幕时，用户已设置的标注不会丢失。
 */
function mergeSubtitleAnnotations(oldItems: any[], newItems: any[]): void {
  if (!oldItems || oldItems.length === 0 || !newItems || newItems.length === 0) return;
  const oldMap = new Map<number, any>();
  for (const old of oldItems) {
    if (old && old.id != null) oldMap.set(old.id, old);
  }
  for (const item of newItems) {
    const old = oldMap.get(item.id);
    if (old && old.text && hasAnnotations(old.text)) {
      const { cleanText: oldClean } = parseAnnotations(old.text);
      const newClean = item.text || "";
      // cleanText 相同才保留旧标注，避免字幕内容已变更时错配
      if (oldClean === newClean) {
        item.text = old.text;
      }
    }
  }
}

// ─── 检查更新 ───

const UPDATE_CHECK_URL = 'https://raw.githubusercontent.com/hcllmsx/momovoicesub/main/VERSION';

/** 比较两个版本号字符串（格式：主.次.修订），返回 1 表示 a > b，-1 表示 a < b，0 表示相等 */
function compareVersion(a: string, b: string): number {
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

const PROD_BASE_URL = 'https://momovoicesub.sxrec.com';

async function checkForUpdate(manual = false) {
  state.updateStatus = 'checking';
  renderUpdateStatus();
  try {
    const resp = await fetch(`${PROD_BASE_URL}/api/version`, { cache: 'no-cache' } as any);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data: any = await resp.json();
    const remoteVersion = (data.pr_version || '').trim();
    if (!remoteVersion) throw new Error('未找到远程 PR 版本号');
    state.updateLatestVersion = remoteVersion;
    const downloadUrl = data.download_url || PROD_BASE_URL;

    const currentVer = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';
    const cmp = compareVersion(remoteVersion, currentVer);
    if (cmp > 0) {
      state.updateStatus = 'available';
      // 弹出 UXP 原生更新提示弹窗
      showUpdateDialog({
        currentVersion: currentVer,
        latestVersion: remoteVersion,
        downloadUrl,
      });
    } else {
      state.updateStatus = 'latest';
      if (manual) showToast('已是最新版本', 'success');
    }
  } catch (e: any) {
    console.warn('检查更新失败:', e && e.message ? e.message : e);
    state.updateStatus = 'error';
    if (manual) showToast('检查更新失败', 'error');
  }
  renderUpdateStatus();
}

/**
 * 弹出新版本更新提醒弹窗 (UXP 原生 Modal，标题由 uxpShowModal 的 title 原生渲染，避免双标题)
 */
async function showUpdateDialog({ currentVersion, latestVersion, downloadUrl }: { currentVersion: string; latestVersion: string; downloadUrl?: string }) {
  const dialog = $("updateDialog") as any;
  if (!dialog) return;

  const url = downloadUrl || PROD_BASE_URL;

  const versionTextEl = $("updateDialogVersionText");
  const detailEl = $("updateDialogDetail");
  const laterBtn = $("updateDialogLater") as any;
  const downloadBtn = $("updateDialogDownload") as any;

  if (versionTextEl) {
    versionTextEl.textContent = `发现新版本 v${latestVersion}`;
  }
  if (detailEl) {
    detailEl.textContent = `当前版本为 v${currentVersion}。新版本已发布，建议前往官网下载以获得最新功能与优化体验。`;
  }

  if (laterBtn) {
    if (laterBtn._clickHandler) laterBtn.removeEventListener('click', laterBtn._clickHandler);
    laterBtn._clickHandler = () => {
      dialog.close('later');
    };
    laterBtn.addEventListener('click', laterBtn._clickHandler);
  }

  if (downloadBtn) {
    if (downloadBtn._clickHandler) downloadBtn.removeEventListener('click', downloadBtn._clickHandler);
    downloadBtn._clickHandler = () => {
      dialog.close('download');
      openExternalUrl(url, '前往官网下载');
    };
    downloadBtn.addEventListener('click', downloadBtn._clickHandler);
  }

  try {
    await dialog.uxpShowModal({
      title: '发现新版本可用',
      resize: 'none',
      size: { width: 380, height: 180 },
    });
  } catch (e) {
    console.warn('打开更新弹窗异常:', e);
  }
}

/**
 * 复制文本到系统剪贴板（UXP / Web Clipboard）
 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (uxp && (uxp as any).clipboard && typeof (uxp as any).clipboard.setContent === 'function') {
      await (uxp as any).clipboard.setContent({ 'text/plain': text });
      return true;
    }
    if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    console.warn('[Momo] 复制剪贴板失败:', err);
  }
  return false;
}

let _aboutDialogEventsBound = false;

/**
 * 弹出「官方 QQ 交流群二维码」独立对话框 (纯图展示)
 */
async function showQrcodeModalDialog() {
  const qrcodeDialog = $("qrcodeModalDialog") as any;
  if (!qrcodeDialog) return;

  try {
    await qrcodeDialog.uxpShowModal({
      title: "QQ 交流群二维码",
      resize: "none",
      size: { width: 360, height: 400 }
    });
  } catch (e) {
    console.warn("打开二维码弹窗异常:", e);
  }
}

/**
 * 弹出「关于 & 交流反馈」对话框 (UXP 原生 Modal，标题栏由 uxpShowModal 渲染)
 */
async function showAboutDialog() {
  const dialog = $("aboutDialog") as any;
  if (!dialog) return;

  const verEl = $("aboutAppVersion");
  if (verEl && typeof __APP_VERSION__ !== 'undefined') {
    verEl.textContent = `v${__APP_VERSION__}`;
  }

  if (!_aboutDialogEventsBound) {
    _aboutDialogEventsBound = true;

    $("aboutOfficialSiteLink")?.addEventListener("click", () => {
      openExternalUrl("https://momovoicesub.sxrec.com/", "项目官网主页");
    });

    $("aboutGithubRepoLink")?.addEventListener("click", () => {
      openExternalUrl("https://github.com/hcllmsx/momovoicesub", "GitHub 开源仓库页面");
    });

    $("aboutCopyQqBtn")?.addEventListener("click", async () => {
      const qqNumber = "967672306";
      const ok = await copyTextToClipboard(qqNumber);
      if (ok) {
        showToast(`QQ群号已复制到剪贴板: ${qqNumber}`, "success");
      } else {
        showToast(`官方QQ群号: ${qqNumber}`, "info");
      }
    });

    const qrcodeWrap = $("aboutQrcodeWrap");
    qrcodeWrap?.addEventListener("click", async () => {
      try {
        dialog.close();
      } catch (_) { }
      await showQrcodeModalDialog();
      showAboutDialog();
    });
  }

  try {
    await dialog.uxpShowModal({
      title: "关于 & 交流反馈",
      resize: "none",
      size: { width: 480, height: 320 }
    });
  } catch (e) {
    console.warn("打开关于弹窗异常:", e);
  }
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
  const linkEl = document.getElementById('updateLink');
  if (linkEl) {
    linkEl.addEventListener('click', async () => {
      await openExternalUrl(PROD_BASE_URL, '打开 MoMoVoiceSub 官网');
    });
  }
}

// ─── 初始化与连接 ───
async function initPlugin() {
  try {
    // 设置页底部版本号显示（构建时从 VERSION 文件注入）
    // 「momoVoicesub」为指向官网主页的超链接，点击调 shell.openExternal 打开浏览器
    const appVersionEl = $("appVersion");
    if (appVersionEl) {
      appVersionEl.innerHTML = `默默配音助手（<a id="appVersionLink" class="app-version-link" href="javascript:void(0)">momoVoicesub</a>） <span class="app-version-num">v${__APP_VERSION__}</span>`;
      const linkEl = $("appVersionLink");
      if (linkEl) {
        linkEl.addEventListener("click", () => {
          openExternalUrl("https://momovoicesub.sxrec.com/", "项目官网主页");
        });
      }
    }

    // 绑定关于弹窗入口（左下角操作栏按钮与设置页底部链接）
    $("openAboutLink")?.addEventListener("click", () => {
      showAboutDialog();
    });
    document.querySelectorAll(".bar-about-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        showAboutDialog();
      });
    });

    const settings = await settingsStore.load();
    state.voices = settings.voices || [];
    state.favoriteVoices = settings.favoriteVoices || [];

    localProvider = new LocalTtsProvider({
      getSettings: () => settingsStore.load()
    });

    ttsProvider = new DelegatingTtsProvider({
      azureProvider: new AzureTtsProvider({
        getSettings: () => settingsStore.load(),
        getAzureKey: () => settingsStore.getAzureKey()
      }),
      cloudProvider: new CloudTtsProvider({ cloudClient, cloudStore }),
      localProvider,
      cloudStore,
      getAzureKey: () => settingsStore.getAzureKey(),
      getActiveChannel: () => settingsStore.load().then(s => s.activeChannel || ''),
      getSettings: () => settingsStore.load()
    });

    // 初始化本地设置面板表单与通道按钮
    loadLocalSettingsToForm();
    await updateChannelEnableButtons();
    if (isLocalChannelActive()) {
      await syncLocalVoices();
    }
    bindLocalTtsEvents();

    const rememberKeyCheckbox = $("settingRememberKey") as any;
    if (rememberKeyCheckbox) {
      rememberKeyCheckbox.checked = settings.rememberKey;
    }

    // 若已有保存的 key，输入框显示占位符（不回填明文，避免误清空与安全问题）
    const keyInput = $("settingAzureKey") as any;
    if (keyInput) {
      // getAzureKey() 会触发 sessionAzureKey 恢复（若 rememberKey 且文件中有 key）
      const hasKey = Boolean(await settingsStore.getAzureKey());
      keyInput.value = hasKey ? "__SAVED_KEY_PLACEHOLDER__" : "";
    }

    const regionInput = $("settingRegion") as any;
    if (regionInput) regionInput.value = settings.region || "eastasia";

    state.presets = ensureDefaultPreset(settings);
    state.defaultPresetId = settings.defaultPresetId || 'preset-default';

    // 迁移持久化：若内置预设音色被迁移过（小艺→晓晓），立即写回 settings.json，
    // 确保下次加载时文件已是修正后的值，不再依赖每次内存迁移
    const originalBuiltin = (settings.presets || []).find((p: any) => p.id === 'preset-default');
    const currentBuiltin = state.presets.find(p => p.id === 'preset-default');
    if (originalBuiltin && currentBuiltin && originalBuiltin.voice !== currentBuiltin.voice) {
      savePresetsToSettings().catch((e) => console.error('[Momo] 持久化内置预设音色迁移失败:', e));
    }

    renderPresetDropdown();
    renderPresetsGrid();
    // 初始化时应用默认预设（persist=false：预设已存在于 settings.json，无需重复保存；
    // 同时避免两个 applyPreset 并发触发 save 造成读写竞态）
    if (state.defaultPresetId) {
      applyPreset(state.defaultPresetId, 'subtitle', false);
      applyPreset(state.defaultPresetId, 'manual', false);
    }

    // 加载缓存目录路径显示
    loadCacheDirPath();

    await syncWithPremiere();
    setInterval(syncWithPremiere, 3000);

    await updateVoiceTriggers();
    if (state.currentTab === 'voices') renderVoicesPage();

    // 首次安装 / 音色列表为空时，自动从公开接口获取（不阻塞初始化）
    if (!state.voices || state.voices.length === 0) {
      ttsProvider.listVoices().then(async (voices) => {
        if (voices && voices.length > 0) {
          await settingsStore.save({ voices });
          state.voices = voices;
          updateVoiceTriggers();
          if (state.currentTab === 'voices') renderVoicesPage();
        }
      }).catch(err => console.error('[Momo] 自动获取音色列表失败:', err));
    }

    renderDictList(settings.polyphonicDict || []);
    renderBuiltinDictList();

    // 恢复手动配音文本（与达芬奇版一致：不清空则跨会话保留）
    restoreManualText();

    // 异步检查更新
    checkForUpdate();
    // 启动后异步发送轻量启动心跳（全量匿名装机统计）
    setTimeout(() => {
      sendStartupHeartbeat();
    }, 1500);
    // 点击版本号手动检查更新（排除 momoVoicesub 链接点击）
    const appVerEl = document.getElementById('appVersion');
    if (appVerEl) {
      appVerEl.addEventListener('click', (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (target && (target.id === 'appVersionLink' || target.closest('#appVersionLink'))) return;
        checkForUpdate(true);
      });
    }

    // 初始化云端账号状态
    refreshCloudAccount().catch(err => console.error('[Momo] 云端账号初始化失败:', err));
  } catch (err) {
    console.error("Init plugin failed:", err);
    showToast("初始化插件失败", "error");
  }
}

/**
 * 启动后异步发送轻量启动心跳（全量匿名装机与活跃统计）
 */
async function sendStartupHeartbeat() {
  try {
    // dev 开发版不参与统计，避免污染生产数据
    if (typeof __IS_DEV__ !== 'undefined' && __IS_DEV__) return;

    let mode: 'custom_key' | 'cloud' | 'unconfigured' = 'unconfigured';
    try {
      const cloudState = await cloudGetState();
      if (cloudState && cloudState.isLoggedIn) {
        mode = 'cloud';
      }
    } catch (_) { }

    if (mode === 'unconfigured') {
      const s = await settingsStore.load();
      if (s?.speechKey && s.speechKey.trim()) {
        mode = 'custom_key';
      }
    }

    const deviceFp = await cloudStore.getDeviceFp();
    const version = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '';
    await cloudClient.sendHeartbeat({
      device_fp: deviceFp,
      client_type: 'pr',
      version,
      mode,
    });
  } catch (_) {
    // 容错防崩：心跳失败静默忽略
  }
}

/**
 * 自愈保护：UXP 原生 <textarea> 在面板重绘 / display 切换 / PR 执行事务等场景下，
 * value 偶发被重置为 HTML 初始值（空）。此函数在 state 有内容但文本框为空时恢复显示。
 * 在 syncWithPremiere 轮询（3s）和 tab 切换回 manual 时调用，兜底防止用户输入丢失。
 */
function ensureManualTextareaValue() {
  const ta = $("manualText") as any;
  if (!ta) return;
  // 文本框聚焦且有内容时不干预：打字/选区过程中的瞬时不一致由 input 事件自行同步，
  // 轮询此时回写 value 会重置光标并触发 UXP 全文重绘（表现为文字闪烁）
  if (ta.value && document.activeElement === ta) return;
  const annotated = state.manualTextWithAnnotations || "";
  if (!annotated) return;
  const { cleanText } = parseAnnotations(annotated);
  if (ta.value !== cleanText) {
    ta.value = cleanText;
  }
}

/** 仅在内容变化时写 innerText：UXP 下重复赋值相同文本也会触发重排/重绘 */
function setInnerTextIfChanged(el: any, text: string) {
  if (!el || el.innerText === text) return;
  el.innerText = text;
}

// 同步 PR 时间线状态
async function syncWithPremiere() {
  // 自愈：修复 UXP 原生 textarea 在面板重绘时 value 被清空的问题
  ensureManualTextareaValue();

  const summary = await premiereAdapter.getSummary();
  if (!summary) {
    setInnerTextIfChanged($("projectNameText")!, "未检测到项目");
    setInnerTextIfChanged($("sequenceNameText")!, "无活动序列");
    return;
  }

  const projectChanged = state.projectName !== summary.projectName;
  const sequenceChanged = state.sequenceName !== summary.sequenceName;

  state.projectName = summary.projectName;
  state.sequenceName = summary.sequenceName;
  state.fps = summary.fps;

  setInnerTextIfChanged($("projectNameText")!, summary.projectName);
  setInnerTextIfChanged($("sequenceNameText")!, summary.sequenceName);

  // 项目切换后，缓存目录路径也跟着变化（cache/{projectName}/），需刷新设置页显示。
  // 异步执行，不阻塞时间线同步。
  if (projectChanged) {
    loadCacheDirPath();
  }

  if (projectChanged || sequenceChanged || state.audioTracks.length !== summary.audioTracks.length || state.captionTracks.length !== summary.captionTracks.length) {
    state.audioTracks = summary.audioTracks;
    state.captionTracks = summary.captionTracks;

    updateTrackDropdowns();

    if (state.captionTracks.length > 0 && (sequenceChanged || state.activeCaptionTrackIndex === -2)) {
      // 从手动模式自动切到字幕轨前，备份手动 SRT（若有）
      if (state.activeCaptionTrackIndex === -1 && state.subtitleItems.length > 0) {
        state.manualSrtItemsBackup = state.subtitleItems.slice();
      }
      const firstTrackIndex = state.captionTracks[0].index;
      await autoLoadSubtitleTrack(firstTrackIndex);
    } else if (state.captionTracks.length === 0) {
      // 没有字幕轨：切到手动模式（-1），确保下拉默认选中「无字幕轨(手动SRT模式)」
      if (state.activeCaptionTrackIndex !== -1) {
        if (state.activeCaptionTrackIndex >= 0) {
          // 之前选中了某个字幕轨，现在该轨道没了（如切换序列），恢复手动 SRT 备份（若有）
          state.subtitleItems = state.manualSrtItemsBackup.slice();
          renderSubtitleList();
        }
        state.activeCaptionTrackIndex = -1;
      }
      // 同步 picker 选中状态到「无字幕轨(手动SRT模式)」
      const subtitleDropdown = $("subtitleTrackDropdown") as any;
      if (subtitleDropdown) setPickerValue(subtitleDropdown, "-1");
      updateImportSrtBtnVisibility();
    }
  }
}

// 始终显示「导入SRT」按钮：有字幕轨时可用于补全/替换文字，无字幕轨时用于加载本地字幕
function updateImportSrtBtnVisibility() {
  const btn = $("subtitleImportSrtBtn");
  if (!btn) return;
  btn.classList.remove("hidden");
}

// 刷新轨道下拉菜单 (PR 25+ UXP 使用 sp-picker 替换 sp-dropdown)
function updateTrackDropdowns() {
  // 1. 字幕轨
  const subtitleMenu = $("subtitleTrackMenu");
  if (subtitleMenu) {
    const manualSelected = state.activeCaptionTrackIndex === -1 ? " selected" : "";
    let html = `<sp-menu-item value="-1"${manualSelected}>-- 无字幕轨 (手动SRT模式) --</sp-menu-item>`;
    for (const track of state.captionTracks) {
      const isSelected = track.index === state.activeCaptionTrackIndex;
      html += `<sp-menu-item value="${track.index}" ${isSelected ? 'selected' : ''}>${track.name}</sp-menu-item>`;
    }
    subtitleMenu.innerHTML = html;
  }

  // 2. 音频轨 (字幕自动配音)
  const subtitleAudioMenu = $("subtitleAudioTrackMenu");
  if (subtitleAudioMenu) {
    let html = '<sp-menu-item value="auto" selected>自动新建音频轨 (顺延)</sp-menu-item>';
    for (const track of state.audioTracks) {
      html += `<sp-menu-item value="${track.index}">音轨 ${track.index + 1}: ${track.name}</sp-menu-item>`;
    }
    subtitleAudioMenu.innerHTML = html;
  }

  // 3. 音频轨 (手动文本配音)
  const manualAudioMenu = $("manualAudioTrackMenu");
  if (manualAudioMenu) {
    let html = '<sp-menu-item value="auto" selected>自动新建音频轨 (顺延)</sp-menu-item>';
    for (const track of state.audioTracks) {
      html += `<sp-menu-item value="${track.index}">音轨 ${track.index + 1}: ${track.name}</sp-menu-item>`;
    }
    manualAudioMenu.innerHTML = html;
  }
}

// 手动刷新：强制重读当前工程（项目/序列/轨道/字幕）
// 由左下角"已连接"状态指示器的点击触发
async function manualRefresh() {
  showToast("正在保存项目...", "info");
  try {
    const saved = await premiereAdapter.saveProject();
    if (!saved) {
      showToast("项目保存失败，仍尝试刷新...", "warning");
    } else {
      showToast("项目已保存，正在刷新工程...", "info");
    }
  } catch (err) {
    console.error("Failed to save project before refresh:", err);
    showToast("项目保存异常，仍尝试刷新...", "warning");
  }

  try {
    const summary = await premiereAdapter.getSummary();
    if (!summary) {
      $("projectNameText")!.innerText = "未检测到项目";
      $("sequenceNameText")!.innerText = "无活动序列";
      showToast("未检测到活动项目", "error");
      return;
    }

    // 更新项目/序列信息
    state.projectName = summary.projectName;
    state.sequenceName = summary.sequenceName;
    state.fps = summary.fps;
    state.audioTracks = summary.audioTracks;
    state.captionTracks = summary.captionTracks;

    $("projectNameText")!.innerText = summary.projectName;
    $("sequenceNameText")!.innerText = summary.sequenceName;
    // 手动刷新后，缓存目录路径可能因项目切换而变化，同步刷新
    loadCacheDirPath();
    updateTrackDropdowns();

    // 强制重新读取当前选中的字幕轨（即使项目/序列名没变也重读）
    if (state.activeCaptionTrackIndex >= 0) {
      const trackIdx = state.activeCaptionTrackIndex;
      // 确认该轨道仍然存在
      const stillExists = state.captionTracks.some(t => t.index === trackIdx);
      if (stillExists) {
        const items = await premiereAdapter.loadSubtitlesFromTrack(trackIdx, state.fps);
        // 保留用户已设置的标注（多音字纠音、停顿标记），根据 id 匹配
        mergeSubtitleAnnotations(state.subtitleItems, items);
        state.subtitleItems = items;
        renderSubtitleList();
        const textCount = items.filter(i => i.text && i.text.trim()).length;
        showToast(`已刷新：${items.length} 条字幕（含 ${textCount} 条文字）`, "success");
      } else {
        // 原选中的轨道已不存在，清空列表
        state.activeCaptionTrackIndex = -1;
        state.subtitleItems = [];
        renderSubtitleList();
        updateImportSrtBtnVisibility();
        showToast("原字幕轨已不存在，已清空列表", "warning");
      }
    } else {
      updateImportSrtBtnVisibility();
      showToast("已刷新工程信息", "success");
    }
  } catch (err) {
    console.error("Manual refresh failed:", err);
    showToast("刷新失败，请重试", "error");
  }
}

// 自动载入字幕轨上的字幕
async function autoLoadSubtitleTrack(trackIndex: number) {
  state.activeCaptionTrackIndex = trackIndex;
  updateImportSrtBtnVisibility();

  const dropdown = $("subtitleTrackDropdown") as any;
  if (dropdown) {
    setPickerValue(dropdown, String(trackIndex));
  }

  try {
    // 保存项目，确保读取 .prproj 时拿到最新内容（含手动编辑、剃刀分割等操作）
    try {
      await premiereAdapter.saveProject();
    } catch (saveErr) {
      console.warn("[Momo] autoLoadSubtitleTrack: 保存项目失败，仍尝试读取:", saveErr);
    }
    const items = await premiereAdapter.loadSubtitlesFromTrack(trackIndex, state.fps);
    // 保留用户已设置的标注（多音字纠音、停顿标记），根据 id 匹配
    mergeSubtitleAnnotations(state.subtitleItems, items);
    state.subtitleItems = items;
    renderSubtitleList();
    // 根据是否读到字幕文字，给出不同的提示
    if (items.length > 0) {
      const textCount = items.filter(i => i.text && i.text.trim()).length;
      if (textCount === 0) {
        // 未读到文字 —— UXP API 和 .prproj 策略都未能提取到字幕文字
        showToast(
          `已读到 ${items.length} 条字幕时序，但未能自动提取字幕文字。请点击「导入SRT」完成配对。`,
          "warning"
        );
      } else if (textCount < items.length) {
        // 部分文字缺失
        showToast(
          `已载入 ${items.length} 条字幕，其中 ${textCount} 条已提取文字，${items.length - textCount} 条文字为空，可导入 SRT 补全。`,
          "info"
        );
      } else {
        showToast(`已载入 ${items.length} 条字幕（含文字）`, "success");
      }
    }
  } catch (err) {
    console.error(err);
    showToast("自动载入字幕轨失败，请尝试重新选择或导入外部 SRT", "error");
  }
}

// ─── 导航页签切换 ───
const navButtons = document.querySelectorAll(".nav-btn");
navButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    const tabName = btn.getAttribute("data-tab");
    if (!tabName) return;

    navButtons.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    const panels = document.querySelectorAll(".tab-panel");
    panels.forEach(p => p.classList.remove("active"));
    $(`${tabName}`)?.classList.add("active");

    state.currentTab = tabName;

    // 切到音色页时刷新渲染（确保数据与筛选状态最新）
    if (tabName === 'voices') renderVoicesPage();
    // 切到设置页时自动选择认证选项卡
    if (tabName === 'settings') autoSelectAuthTab();
    // 切回手动配音页时自愈：UXP 原生 textarea 在 display:none→flex 后 value 偶发被清空
    if (tabName === 'manual') ensureManualTextareaValue();
  });
});

// 音色页「返回」按钮：返回来源 tab
$("voicePageBackBtn")?.addEventListener("click", () => switchToTab(voicePage.returnTab));
// 底部状态栏点击也可返回
$("voicePageStatus")?.addEventListener("click", () => switchToTab(voicePage.returnTab));

// ─── 音色选择（独立页面 + 触发行，全局单例）───
// 字幕/手动页共用同一个音色页；点击「更换」跳转到音色页，选中后自动返回来源 tab
interface VoicePageState {
  filterText: string;
  filterLocaleGroup: string;
  filterLocaleSub: string | null;
  filterGender: string;
  filterVoiceType: string;
  showFavoritesOnly: boolean;
  filterLocalLang: string;
  filterLocalAvatar: string;
  filterLocalEmotion: string;
  returnTab: string;
  built: boolean;
  loading: boolean;
  loadError: string;
}

const voicePage: VoicePageState = {
  filterText: '',
  filterLocaleGroup: 'zh',
  filterLocaleSub: 'zh-CN',
  filterGender: 'all',
  filterVoiceType: 'all',
  showFavoritesOnly: false,
  filterLocalLang: 'all',
  filterLocalAvatar: 'all',
  filterLocalEmotion: 'all',
  returnTab: 'subtitles',
  built: false,
  loading: false,
  loadError: '',
};

function getChannelVoiceList(): VoiceInfo[] {
  if (isLocalChannelActive()) {
    return state.localVoices || [];
  }
  return state.voices || [];
}

async function syncLocalVoices(): Promise<VoiceInfo[]> {
  try {
    if (!localProvider) return [];
    const list = await localProvider.listVoices();
    state.localVoices = list || [];
    return state.localVoices;
  } catch (_) {
    state.localVoices = [];
    return [];
  }
}

function getLocalLanguages(): string[] {
  const langSet = new Set<string>();
  for (const v of getChannelVoiceList()) {
    const l = ((v as any).promptLang || v.locale || 'zh').toLowerCase();
    if (l) {
      const norm = l.startsWith('zh') ? 'zh' : (l.startsWith('en') ? 'en' : (l.startsWith('ja') ? 'ja' : (l.startsWith('ko') ? 'ko' : (l.startsWith('yue') ? 'yue' : l))));
      if (PROMPT_LANG_MAP[norm]) {
        langSet.add(norm);
      }
    }
  }
  return Array.from(langSet);
}

function getLocalEmotions(): string[] {
  const emotions = new Set<string>();
  for (const v of getChannelVoiceList()) {
    const em = ((v as any).emotion || '').trim();
    if (em) emotions.add(em);
  }
  return Array.from(emotions);
}

function getLocaleGroups() {
  const voices = getChannelVoiceList();
  return LOCALE_GROUPS.map(g => {
    const count = voices.filter(v => g.match(v.locale)).length;
    return { ...g, count };
  }).filter(g => g.count > 0 || g.id === 'all');
}

function getActiveSubLocales(): [string, { label: string; count: number }][] {
  const group = LOCALE_GROUPS.find(g => g.id === voicePage.filterLocaleGroup);
  if (!group || !Object.keys(group.subs).length) return [];

  const voices = getChannelVoiceList();
  const result: [string, { label: string; count: number }][] = [];
  for (const [key, subDef] of Object.entries(group.subs)) {
    const count = voices.filter(v => group.match(v.locale) && subMatchesLocale(subDef, v.locale)).length;
    result.push([key, { label: subDef.label, count }]);
  }

  // 追加未覆盖的 locale 作为动态 sub
  const coveredLocales = new Set<string>();
  for (const subDef of Object.values(group.subs)) {
    if (subDef.locales) subDef.locales.forEach(l => coveredLocales.add(l));
  }
  const uncovered = voices
    .filter(v => group.match(v.locale) && !coveredLocales.has(v.locale))
    .map(v => v.locale);
  const uniqUncovered = Array.from(new Set(uncovered));
  for (const loc of uniqUncovered) {
    const count = voices.filter(v => v.locale === loc).length;
    result.push([loc, { label: localeLabel(loc), count }]);
  }
  return result;
}

function filteredVoices(): VoiceInfo[] {
  const currentVoices = getChannelVoiceList();
  const isLocal = isLocalChannelActive();
  if (isLocal) {
    return currentVoices.filter((v: any) => {
      const vLang = (v.promptLang || v.locale || 'zh').toLowerCase();
      const normLang = vLang.startsWith('zh') ? 'zh' : (vLang.startsWith('en') ? 'en' : (vLang.startsWith('ja') ? 'ja' : (vLang.startsWith('ko') ? 'ko' : (vLang.startsWith('yue') ? 'yue' : vLang))));
      if (voicePage.filterLocalLang !== 'all' && normLang !== voicePage.filterLocalLang) return false;
      const vAvatar = v.avatarType || (v.gender === 'Male' ? 'man' : 'woman');
      if (voicePage.filterLocalAvatar !== 'all' && vAvatar !== voicePage.filterLocalAvatar) return false;
      if (voicePage.filterLocalEmotion !== 'all' && (v.emotion || '通用') !== voicePage.filterLocalEmotion) return false;
      if (!voicePage.filterText) return true;
      const q = voicePage.filterText.toLowerCase();
      const name = cleanVoiceName(v.localName || v.displayName || v.shortName || v.name || '').toLowerCase();
      const roleTag = ((AVATAR_CONFIG[vAvatar]?.label) || '').toLowerCase();
      const emotionTag = (v.emotion || '').toLowerCase();
      const modelTag = (v.modelName || v.model || v.modelVersion || '').toLowerCase();
      const langTag = (PROMPT_LANG_MAP[normLang] || normLang).toLowerCase();
      return name.includes(q) || (v.shortName || '').toLowerCase().includes(q) || roleTag.includes(q) || emotionTag.includes(q) || modelTag.includes(q) || langTag.includes(q);
    });
  }

  const result = currentVoices.filter((v) => {
    if (voicePage.filterText) {
      const q = voicePage.filterText.toLowerCase();
      const name = cleanVoiceName(v.localName || v.displayName || v.shortName).toLowerCase();
      const localName = (v.localName || '').toLowerCase();
      const displayName = (v.displayName || '').toLowerCase();
      const shortName = (v.shortName || '').toLowerCase();
      if (!name.includes(q) && !localName.includes(q) && !displayName.includes(q) && !shortName.includes(q)) {
        return false;
      }
    }
    const group = LOCALE_GROUPS.find(g => g.id === voicePage.filterLocaleGroup);
    if (group && !group.match(v.locale)) return false;
    if (voicePage.filterLocaleSub !== null) {
      const grp = LOCALE_GROUPS.find(g => g.id === voicePage.filterLocaleGroup);
      const subDef = grp && grp.subs[voicePage.filterLocaleSub];
      if (subDef) {
        if (!subMatchesLocale(subDef, v.locale)) return false;
      } else {
        if (v.locale !== voicePage.filterLocaleSub) return false;
      }
    }
    if (voicePage.filterGender !== 'all' && v.gender !== voicePage.filterGender) return false;
    if (voicePage.showFavoritesOnly && !state.favoriteVoices.includes(v.shortName)) return false;
    if (voicePage.filterVoiceType !== 'all') {
      if (voiceTypeCat(v) !== voicePage.filterVoiceType) return false;
    }
    return true;
  });
  if (voicePage.filterLocaleGroup === 'all' && !voicePage.filterText) {
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

function renderVoiceCard(voice: VoiceInfo): HTMLElement {
  const isSelected = voice.shortName === state.selectedVoice?.shortName;
  const isFav = state.favoriteVoices.includes(voice.shortName);
  const isLocal = isLocalChannelActive() || (voice as any).channel === 'local' || (voice as any).voiceType === 'LocalTTS';
  const avatarSrc = getVoiceAvatar(voice);
  const styleTags = (voice.styles || []).slice(0, 2);
  const extraStyles = (voice.styles || []).length - 2;

  let tagsHtml = '';
  if (isLocal) {
    const vAvatar = (voice as any).avatarType || (voice.gender === 'Male' ? 'man' : 'woman');
    const roleLabel = AVATAR_CONFIG[vAvatar]?.label || (voice.gender === 'Male' ? '男声' : '女声');
    const emotionLabel = ((voice as any).emotion || '').trim();
    let modelLabel = (voice as any).modelName || (voice as any).model || (voice as any).modelVersion || '';
    if (modelLabel.includes('通用底模')) {
      modelLabel = '通用底模';
    }
    const vLang = ((voice as any).promptLang || voice.locale || 'zh').toLowerCase();
    const normLang = vLang.startsWith('zh') ? 'zh' : (vLang.startsWith('en') ? 'en' : (vLang.startsWith('ja') ? 'ja' : (vLang.startsWith('ko') ? 'ko' : (vLang.startsWith('yue') ? 'yue' : vLang))));
    const langLabel = PROMPT_LANG_MAP[normLang] || normLang.toUpperCase();
    tagsHtml = `
      <span class="vp-card-tag">${escapeHtml(langLabel)}</span>
      <span class="vp-card-tag">${escapeHtml(roleLabel)}</span>
      ${emotionLabel && emotionLabel !== '通用' ? `<span class="vp-card-tag style-tag">${escapeHtml(emotionLabel)}</span>` : ''}
      ${modelLabel ? `<span class="vp-card-tag">${escapeHtml(modelLabel)}</span>` : ''}
    `;
  } else {
    tagsHtml = `
      <span class="vp-card-tag">${localeLabel(voice.locale) || voice.locale}</span>
      <span class="vp-card-tag">${voice.gender === 'Female' ? '女声' : voice.gender === 'Male' ? '男声' : voice.gender || ''}</span>
      ${styleTags.map(s => `<span class="vp-card-tag style-tag">${styleNameCn(s)}</span>`).join('')}
      ${extraStyles > 0 ? `<span class="vp-card-tag">+${extraStyles}</span>` : ''}
    `;
  }

  const card = document.createElement('div');
  card.className = `vp-card${isSelected ? ' selected' : ''}`;
  card.dataset.shortName = voice.shortName;

  card.innerHTML = `
    <img class="vp-card-avatar" src="${avatarSrc}" alt="">
    <div class="vp-card-info">
      <div class="vp-card-name">${cleanVoiceName(voice.localName || voice.displayName || voice.shortName)}</div>
      <div class="vp-card-meta">
        ${tagsHtml}
      </div>
    </div>
    <div class="vp-card-actions">
      <div class="vp-card-preview-btn" role="button" tabindex="0" title="试听">▶</div>
      ${!isLocal ? `<div class="vp-card-fav-btn${isFav ? ' favorited' : ''}" role="button" tabindex="0" title="${isFav ? '取消收藏' : '收藏'}">${isFav ? '❤' : '♡'}</div>` : ''}
    </div>
  `;

  card.addEventListener('click', (e) => {
    const tgt = e.target as HTMLElement;
    if (tgt.closest('.vp-card-preview-btn') || tgt.closest('.vp-card-fav-btn')) return;
    selectVoiceAndReturn(voice);
  });

  const previewBtn = card.querySelector('.vp-card-preview-btn');
  if (previewBtn) previewBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    previewVoice(voice.shortName);
  });

  const favBtn = card.querySelector('.vp-card-fav-btn');
  if (favBtn) favBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFavoriteVoice(voice.shortName);
  });

  return card;
}

function renderVoiceGrid() {
  const grid = $('voicesGrid');
  if (!grid) return;
  const filtered = filteredVoices();
  const currentVoices = getChannelVoiceList();
  const isLocal = isLocalChannelActive();
  grid.innerHTML = '';

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'vp-grid-empty';
    if (!currentVoices || currentVoices.length === 0) {
      if (isLocal) {
        empty.textContent = '暂无本地音色，请前往「设置 -> 本地部署」添加或从服务器同步音色';
      } else if (voicePage.loading) {
        empty.className = 'vp-grid-loading';
        empty.textContent = '正在获取音色列表…';
      } else if (voicePage.loadError) {
        empty.textContent = `获取音色列表失败：${voicePage.loadError}`;
      } else {
        empty.textContent = '暂无音色数据，请点「刷新音色」获取';
      }
    } else if (isLocal) {
      empty.textContent = '未找到匹配的本地音色';
    } else if (voicePage.showFavoritesOnly) {
      empty.textContent = '暂无收藏的音色';
    } else {
      empty.textContent = '没有匹配的音色';
    }
    grid.appendChild(empty);
    return;
  }

  // 一次性渲染：独立页面无层级遮挡问题，UXP DOM 可承载 400+ 卡片
  const frag = document.createDocumentFragment();
  for (const v of filtered) frag.appendChild(renderVoiceCard(v));
  grid.appendChild(frag);
}

function renderFilterBarHTML(): string {
  const isLocal = isLocalChannelActive();
  if (isLocal) {
    const langs = getLocalLanguages();
    const emotions = getLocalEmotions();
    const avatarTypes = Object.entries(AVATAR_CONFIG).map(([key, cfg]) => ({
      id: key,
      label: cfg.label
    }));
    return `
      <sp-textfield class="vp-filter-search" type="search" placeholder="搜索音色名、语种、模型、形象或情绪..." value="${escapeHtml(voicePage.filterText)}"></sp-textfield>
      <div class="vp-filter-rows">
        <div class="vp-filter-group">
          <span class="vp-filter-label">语种</span>
          <span class="vp-tag${voicePage.filterLocalLang === 'all' ? ' active' : ''}" data-local-lang="all">全部</span>
          ${langs.map(l => `<span class="vp-tag${voicePage.filterLocalLang === l ? ' active' : ''}" data-local-lang="${l}">${PROMPT_LANG_MAP[l] || l.toUpperCase()}</span>`).join('')}
        </div>
      </div>
      <div class="vp-filter-rows">
        <div class="vp-filter-group">
          <span class="vp-filter-label">形象</span>
          <span class="vp-tag${voicePage.filterLocalAvatar === 'all' ? ' active' : ''}" data-local-avatar="all">全部</span>
          ${avatarTypes.map(a => `<span class="vp-tag${voicePage.filterLocalAvatar === a.id ? ' active' : ''}" data-local-avatar="${a.id}">${a.label}</span>`).join('')}
        </div>
      </div>
      ${emotions.length > 0 ? `
      <div class="vp-filter-rows vp-filter-rows-spaced">
        <div class="vp-filter-group">
          <span class="vp-filter-label">情绪</span>
          <span class="vp-tag${voicePage.filterLocalEmotion === 'all' ? ' active' : ''}" data-local-emotion="all">全部</span>
          ${emotions.map(e => `<span class="vp-tag${voicePage.filterLocalEmotion === e ? ' active' : ''}" data-local-emotion="${escapeHtml(e)}">${escapeHtml(e)}</span>`).join('')}
        </div>
      </div>` : ''}
    `;
  }

  const groups = getLocaleGroups();

  const localeHTML = groups.map(g =>
    `<span class="vp-tag${voicePage.filterLocaleGroup === g.id ? ' active' : ''}" data-locale-group="${g.id}">${g.label} (${g.count})</span>`
  ).join('');

  let subLocaleHTML = '';
  if (voicePage.filterLocaleGroup !== 'all' && getActiveSubLocales().length > 0) {
    subLocaleHTML = `
    <div class="vp-filter-rows">
      <div class="vp-filter-group">
        <span class="vp-filter-label">子类</span>
        <span class="vp-tag${voicePage.filterLocaleSub === null ? ' active' : ''}" data-locale-sub="">全部</span>
        ${getActiveSubLocales().map(([key, info]) =>
      `<span class="vp-tag${voicePage.filterLocaleSub === key ? ' active' : ''}" data-locale-sub="${key}">${info.label} (${info.count})</span>`
    ).join('')}
      </div>
    </div>`;
  }

  return `
    <sp-textfield class="vp-filter-search" type="search" placeholder="搜索音色名 / 语种..." value="${escapeHtml(voicePage.filterText)}"></sp-textfield>
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
        <span class="vp-tag${voicePage.filterGender === 'all' ? ' active' : ''}" data-gender="all">全部</span>
        <span class="vp-tag${voicePage.filterGender === 'Female' ? ' active' : ''}" data-gender="Female">女声</span>
        <span class="vp-tag${voicePage.filterGender === 'Male' ? ' active' : ''}" data-gender="Male">男声</span>
      </div>
      <div class="vp-filter-group">
        <span class="vp-filter-label">类型</span>
        <span class="vp-tag${voicePage.filterVoiceType === 'all' ? ' active' : ''}" data-voice-type="all">全部</span>
        <span class="vp-tag${voicePage.filterVoiceType === 'hd' ? ' active' : ''}" data-voice-type="hd">高清 HD</span>
        <span class="vp-tag${voicePage.filterVoiceType === 'expressive' ? ' active' : ''}" data-voice-type="expressive">多情感</span>
        <span class="vp-tag${voicePage.filterVoiceType === 'multilingual' ? ' active' : ''}" data-voice-type="multilingual">多语言</span>
        <span class="vp-tag${voicePage.filterVoiceType === 'standard' ? ' active' : ''}" data-voice-type="standard">标准</span>
      </div>
      <div class="vp-fav-btn${voicePage.showFavoritesOnly ? ' active' : ''}" role="button" tabindex="0">❤ 收藏</div>
    </div>
  `;
}

function bindFilterEvents() {
  const container = $('voicesPageContainer');
  if (!container) return;
  const search = container.querySelector('.vp-filter-search') as any;
  if (search) search.addEventListener('input', () => { voicePage.filterText = search.value || ''; renderVoiceGrid(); });

  const isLocal = isLocalChannelActive();
  if (isLocal) {
    container.querySelectorAll('[data-local-lang]').forEach(el => {
      el.addEventListener('click', () => {
        container.querySelectorAll('[data-local-lang]').forEach(t => t.classList.remove('active'));
        el.classList.add('active');
        voicePage.filterLocalLang = (el as HTMLElement).dataset.localLang || 'all';
        renderVoiceGrid();
      });
    });

    container.querySelectorAll('[data-local-avatar]').forEach(el => {
      el.addEventListener('click', () => {
        container.querySelectorAll('[data-local-avatar]').forEach(t => t.classList.remove('active'));
        el.classList.add('active');
        voicePage.filterLocalAvatar = (el as HTMLElement).dataset.localAvatar || 'all';
        renderVoiceGrid();
      });
    });

    container.querySelectorAll('[data-local-emotion]').forEach(el => {
      el.addEventListener('click', () => {
        container.querySelectorAll('[data-local-emotion]').forEach(t => t.classList.remove('active'));
        el.classList.add('active');
        voicePage.filterLocalEmotion = (el as HTMLElement).dataset.localEmotion || 'all';
        renderVoiceGrid();
      });
    });
    return;
  }

  container.querySelectorAll('[data-locale-group]').forEach(el => {
    el.addEventListener('click', () => {
      voicePage.filterLocaleGroup = (el as HTMLElement).dataset.localeGroup || 'all';
      voicePage.filterLocaleSub = null;
      voicePage.filterText = '';
      refreshFilterBar();
    });
  });
  container.querySelectorAll('[data-locale-sub]').forEach(el => {
    el.addEventListener('click', () => {
      voicePage.filterLocaleSub = (el as HTMLElement).dataset.localeSub || null;
      refreshFilterBar();
    });
  });

  container.querySelectorAll('[data-gender]').forEach(el => {
    el.addEventListener('click', () => {
      container.querySelectorAll('[data-gender]').forEach(t => t.classList.remove('active'));
      el.classList.add('active');
      voicePage.filterGender = (el as HTMLElement).dataset.gender || 'all';
      renderVoiceGrid();
    });
  });

  container.querySelectorAll('[data-voice-type]').forEach(el => {
    el.addEventListener('click', () => {
      container.querySelectorAll('[data-voice-type]').forEach(t => t.classList.remove('active'));
      el.classList.add('active');
      voicePage.filterVoiceType = (el as HTMLElement).dataset.voiceType || 'all';
      renderVoiceGrid();
    });
  });

  const favBtn = container.querySelector('.vp-fav-btn');
  if (favBtn) favBtn.addEventListener('click', () => {
    voicePage.showFavoritesOnly = !voicePage.showFavoritesOnly;
    favBtn.classList.toggle('active');
    renderVoiceGrid();
  });
}

function refreshFilterBar() {
  const container = $('voicesPageContainer');
  if (!container) return;
  const bar = container.querySelector('.vp-filter-bar') as HTMLElement | null;
  if (!bar) return;
  bar.innerHTML = renderFilterBarHTML();
  bindFilterEvents();
  renderVoiceGrid();
}

// 音色兼容性提示：首次进入音色选择页时展示一次，手动关闭后不再出现。
// 如需重新展示，在控制台执行：localStorage.removeItem('momoVoiceSub.voiceCompatHintDismissed')，然后重启插件面板生效（音色页 DOM 仅在首次构建时渲染）。
const VOICE_HINT_STORAGE_KEY = "momoVoiceSub.voiceCompatHintDismissed";
const VOICE_HINT_HTML = `
  <div class="vp-hint" id="voiceCompatHint">
    <span class="vp-hint-text">少数音色对停顿、多音字等标注支持不完整，合成时可能出现异常停顿或读音问题。<br>若遇到此类情况，建议更换其他标准神经音色后重试。</span>
    <button class="vp-hint-close" title="不再提示">&times;</button>
  </div>`;

function voiceHintDismissed(): boolean {
  try {
    return !!localStorage.getItem(VOICE_HINT_STORAGE_KEY);
  } catch (_) {
    return false;
  }
}

function bindVoiceHintDismiss(container: HTMLElement) {
  const hint = container.querySelector("#voiceCompatHint");
  if (!hint) return;
  hint.querySelector(".vp-hint-close")?.addEventListener("click", () => {
    try { localStorage.setItem(VOICE_HINT_STORAGE_KEY, "1"); } catch (_) { }
    hint.remove();
  });
}

/** 渲染音色选择独立页面（筛选栏 + 网格）。切到 voices tab 或数据更新时调用 */
function renderVoicesPage() {
  const container = $('voicesPageContainer');
  if (!container) return;
  if (!voicePage.built) {
    container.innerHTML = `
      ${isLocalChannelActive() || voiceHintDismissed() ? '' : VOICE_HINT_HTML}
      <div class="vp-filter-bar"></div>
      <div class="vp-grid" id="voicesGrid"></div>
    `;
    voicePage.built = true;
    bindVoiceHintDismiss(container);
  }
  const bar = container.querySelector('.vp-filter-bar') as HTMLElement | null;
  if (bar) {
    bar.innerHTML = renderFilterBarHTML();
    bindFilterEvents();
  }
  renderVoiceGrid();
  updateVoicePageStatus();
}

// ─── 渲染字幕/手动页的「当前音色 + 更换」触发行 ───
async function updateVoiceTriggers() {
  const currentVoices = getChannelVoiceList();
  if (currentVoices.length > 0) {
    const cur = state.selectedVoice;
    if (!cur || !currentVoices.some(v => v.shortName === cur.shortName)) {
      // 优先从设置中恢复上次选中的音色
      try {
        const settings = await settingsStore.load();
        const savedVoice = isLocalChannelActive() ? (settings.localTts as any)?.lastVoice : settings.defaultVoice;
        if (savedVoice) {
          const found = currentVoices.find(v => v.shortName === savedVoice);
          if (found) {
            state.selectedVoice = found;
            renderStylesAndRoles(found);
          } else {
            state.selectedVoice = currentVoices[0];
            renderStylesAndRoles(currentVoices[0]);
          }
        } else {
          state.selectedVoice = currentVoices[0];
          renderStylesAndRoles(currentVoices[0]);
        }
      } catch (_) {
        state.selectedVoice = currentVoices[0];
        renderStylesAndRoles(currentVoices[0]);
      }
    }
  } else {
    state.selectedVoice = null;
  }

  // 容器前缀 → tab 名映射（容器 id 用 subtitle，但导航 tab 用 subtitles）
  const tabByPrefix: Record<string, string> = { subtitle: 'subtitles', manual: 'manual' };
  for (const prefix of ['subtitle', 'manual']) {
    const container = $(`${prefix}VoiceContainer`);
    if (!container) continue;
    const voice = state.selectedVoice;
    const hasVoice = !!voice;
    const avatar = hasVoice ? getVoiceAvatar(voice) : AVATAR_MAP.Female;
    const name = hasVoice ? cleanVoiceName(voice.localName || voice.displayName || voice.shortName) : '请选择音色';
    let locale = '';
    if (hasVoice) {
      if (isLocalChannelActive() || (voice as any).channel === 'local' || (voice as any).voiceType === 'LocalTTS') {
        const l = ((voice as any).promptLang || voice.locale || 'zh').toLowerCase();
        const norm = l.startsWith('zh') ? 'zh' : (l.startsWith('en') ? 'en' : (l.startsWith('ja') ? 'ja' : (l.startsWith('ko') ? 'ko' : (l.startsWith('yue') ? 'yue' : l))));
        locale = PROMPT_LANG_MAP[norm] || norm.toUpperCase();
      } else {
        locale = localeLabel(voice.locale) || voice.locale || '';
      }
    }
    container.innerHTML = `
      <img class="vt-avatar" src="${avatar}" alt="">
      <div class="vt-info">
        <span class="vt-name${hasVoice ? '' : ' empty'}">${name}</span>
        <span class="vt-locale">${locale}</span>
      </div>
      <div class="vt-change-btn" role="button" tabindex="0">更换</div>
    `;
    container.querySelector('.vt-change-btn')?.addEventListener('click', () => openVoicePicker(tabByPrefix[prefix]));
  }
  updateVoicePageStatus();
}

/** 更新音色页底部状态栏的当前音色显示 */
function updateVoicePageStatus() {
  const label = $('voicePageCurrentLabel');
  if (!label) return;
  const voice = state.selectedVoice;
  if (!voice) {
    label.textContent = '未选择音色';
    return;
  }
  let locTxt = '';
  if (isLocalChannelActive() || (voice as any).channel === 'local' || (voice as any).voiceType === 'LocalTTS') {
    const l = ((voice as any).promptLang || voice.locale || 'zh').toLowerCase();
    const norm = l.startsWith('zh') ? 'zh' : (l.startsWith('en') ? 'en' : (l.startsWith('ja') ? 'ja' : (l.startsWith('ko') ? 'ko' : (l.startsWith('yue') ? 'yue' : l))));
    locTxt = PROMPT_LANG_MAP[norm] || norm.toUpperCase();
  } else {
    locTxt = localeLabel(voice.locale) || voice.locale;
  }
  label.textContent = `${cleanVoiceName(voice.localName || voice.displayName || voice.shortName)} · ${locTxt}`;
}

/** 切换到指定 tab（封装导航逻辑，供音色页返回使用） */
function switchToTab(tabName: string) {
  const btn = document.querySelector(`.nav-btn[data-tab="${tabName}"]`);
  if (btn) btn.dispatchEvent(new Event('click'));
}

/** 从字幕/手动页跳转到音色选择页；无音色时自动获取 */
async function openVoicePicker(fromTab: string) {
  voicePage.returnTab = fromTab;
  switchToTab('voices');

  // 若已有音色数据，直接渲染即可
  const currentVoices = getChannelVoiceList();
  if (currentVoices && currentVoices.length > 0) {
    renderVoicesPage();
    return;
  }

  // 无音色数据 → 自动获取（走 delegating provider，自动选择公开/认证通道）
  voicePage.loading = true;
  voicePage.loadError = '';
  renderVoicesPage(); // 先显示 "正在获取音色列表…"
  try {
    if (isLocalChannelActive()) {
      await syncLocalVoices();
    } else {
      const voices = await ttsProvider.listVoices();
      await settingsStore.save({ voices });
      state.voices = voices;
    }
    updateVoiceTriggers();
  } catch (err: any) {
    voicePage.loadError = err?.message || String(err);
  } finally {
    voicePage.loading = false;
    renderVoicesPage();
  }
}

/** 选中音色并返回来源 tab */
async function selectVoiceAndReturn(voice: VoiceInfo) {
  await selectVoice(voice);
  switchToTab(voicePage.returnTab);
}

// 切换收藏并持久化
async function toggleFavoriteVoice(shortName: string) {
  const idx = state.favoriteVoices.indexOf(shortName);
  if (idx >= 0) {
    state.favoriteVoices.splice(idx, 1);
  } else {
    state.favoriteVoices.push(shortName);
  }
  await settingsStore.save({ favoriteVoices: state.favoriteVoices });
  // 刷新当前音色页的收藏按钮状态（若音色页已构建）
  const container = $('voicesPageContainer');
  if (!container) return;
  container.querySelectorAll('.vp-card').forEach((card) => {
    const sn = (card as HTMLElement).dataset.shortName;
    if (sn !== shortName) return;
    const favBtn = card.querySelector('.vp-card-fav-btn');
    if (!favBtn) return;
    const isFav = state.favoriteVoices.includes(sn);
    favBtn.classList.toggle('favorited', isFav);
    favBtn.textContent = isFav ? '❤' : '♡';
    favBtn.setAttribute('title', isFav ? '取消收藏' : '收藏');
  });
}

async function selectVoice(voice: VoiceInfo, persist: boolean = true) {
  state.selectedVoice = voice;
  renderStylesAndRoles(voice);
  updateVoiceTriggers();
  if (!persist) return;
  // 持久化选中的音色，下次打开插件时恢复
  try {
    if (isLocalChannelActive()) {
      const cur = await settingsStore.load();
      const localTts = { ...(cur.localTts || DEFAULT_LOCAL_TTS), lastVoice: voice.shortName };
      await settingsStore.save({ localTts });
    } else {
      await settingsStore.save({ defaultVoice: voice.shortName });
    }
  } catch (e) {
    console.error("[Momo] 保存选中音色失败:", e);
  }
}

function renderStylesAndRoles(voice: VoiceInfo) {
  const isLocal = (voice as any)?.channel === 'local' || (voice as any)?.voiceType === 'LocalTTS';
  const renderPanel = (prefix: "subtitle" | "manual") => {
    const styleTagsWrap = $(`${prefix}StyleTags`);
    const styledegreeArea = $(`${prefix}StyledegreeArea`);
    const roleArea = $(`${prefix}RoleArea`);
    const roleTagsWrap = $(`${prefix}RoleTags`);

    if (isLocal) {
      if (styleTagsWrap) styleTagsWrap.innerHTML = '<div class="tag-item active" data-style="">通用</div>';
      if (styledegreeArea) styledegreeArea.classList.add("hidden");
      if (roleArea) roleArea.classList.add("hidden");
      return;
    }

    if (styleTagsWrap) {
      let html = '<div class="tag-item active" data-style="">通用</div>';
      for (const style of (voice.styles || [])) {
        html += `<div class="tag-item" data-style="${style}">${styleNameCn(style)}</div>`;
      }
      styleTagsWrap.innerHTML = html;

      styleTagsWrap.querySelectorAll(".tag-item").forEach(tag => {
        tag.addEventListener("click", () => {
          styleTagsWrap.querySelectorAll(".tag-item").forEach(t => t.classList.remove("active"));
          tag.classList.add("active");

          const isGeneral = tag.getAttribute("data-style") === "";
          if (styledegreeArea) {
            if (isGeneral) styledegreeArea.classList.add("hidden");
            else styledegreeArea.classList.remove("hidden");
          }
        });
      });
    }

    if (roleArea && roleTagsWrap) {
      if (voice.roles && voice.roles.length > 0) {
        roleArea.classList.remove("hidden");
        let html = '<div class="tag-item active" data-role="">无指定</div>';
        for (const role of voice.roles) {
          html += `<div class="tag-item" data-role="${role}">${role}</div>`;
        }
        roleTagsWrap.innerHTML = html;

        roleTagsWrap.querySelectorAll(".tag-item").forEach(tag => {
          tag.addEventListener("click", () => {
            roleTagsWrap.querySelectorAll(".tag-item").forEach(t => t.classList.remove("active"));
            tag.classList.add("active");
          });
        });
      } else {
        roleArea.classList.add("hidden");
      }
    }
  };

  renderPanel("subtitle");
  renderPanel("manual");
}

// 试听：合成预览 wav → 写入固定文件名 → 用系统默认播放器打开
// 关键设计：所有音色的试听都播放同一个路径 momo_preview.wav（内容随选中的音色变化）。
// 这样 UXP 的 openPath 权限只需同意一次（"记住我的选择"按路径记忆），避免每次试听都弹窗。
// 唯一的缓存文件 preview_${shortName}.wav 仍保留在 preview/ 目录，用于缓存命中复用、避免重复合成。
// （UXP 不支持 HTML5 <audio> 元素，故采用 shell.openPath 调用系统播放器）
async function previewVoice(shortName: string) {
  try {
    let voice = state.voices.find(v => v.shortName === shortName);
    if (!voice) {
      const s = await settingsStore.load();
      const lv = (s.localTts?.voices || []).find((v: any) => v.id === shortName);
      if (lv) {
        voice = {
          shortName: lv.id,
          localName: lv.name,
          displayName: lv.name,
          gender: lv.gender || 'Female',
          locale: promptLangToLocale(lv.promptLang)
        } as any;
      }
    }
    if (!voice) return;

    if (!uxpShell || typeof uxpShell.openPath !== 'function') {
      showToast("当前 UXP 运行时不支持调用系统播放器，无法试听", "error");
      return;
    }

    // 找到试听按钮并标记 loading 状态（支持音色选择页和本地设置页）
    const btn = (document.querySelector(`.vp-card[data-short-name="${shortName}"] .vp-card-preview-btn`)
      || document.querySelector(`.local-voice-item[data-voice-id="${shortName}"] .local-preview-btn`)) as HTMLElement | null;
    if (btn) btn.classList.add('loading');

    const voiceName = cleanVoiceName(voice.localName || voice.displayName || voice.shortName);
    showToast(`正在准备「${voiceName}」的试听样本...`, "info");

    const dataFolder = await uxp.storage.localFileSystem.getDataFolder();
    let previewFolder;
    try {
      previewFolder = await dataFolder.getEntry('preview');
    } catch (_) {
      previewFolder = await dataFolder.createFolder('preview');
    }

    const result = await ttsProvider.synthesizePreview({
      shortName,
      localName: voice.localName,
      displayName: voice.displayName,
      locale: voice.locale,
      previewFolder
    });

    if (result && result.wavBuffer) {
      // 写入固定文件名（覆盖旧内容），路径固定 → openPath 权限只弹一次
      const playFile = await previewFolder.createEntry('momo_preview.wav', { overwrite: true });
      await playFile.write(result.wavBuffer, { format: uxp.storage.formats.binary });

      // 调用系统默认播放器打开固定路径
      const nativePath = playFile.nativePath;
      const consentText = result.cacheHit
        ? `默默配音助手试听「${voiceName}」音色样本（来自缓存）。首次试听需授权一次，之后可免重复确认。`
        : `默默配音助手试听「${voiceName}」音色样本。首次试听需授权一次，之后可免重复确认。`;
      const openErr = await uxpShell.openPath(nativePath, consentText);
      if (openErr && String(openErr).length > 0) {
        showToast(`试听打开失败：${openErr}`, "error");
      } else {
        showToast(`已打开「${voiceName}」试听样本${result.cacheHit ? '（缓存）' : ''}。试听下一个音色前，请先关闭当前播放器窗口，以免新内容无法自动加载。`, "success");
      }
    }
  } catch (e: any) {
    console.error(e);
    const status = e?.status;
    const msg = e?.message || String(e);
    let toastMsg: string;
    if (status === 401 || status === 403) {
      toastMsg = "试听失败：密钥无效或已过期，请到设置页检查 Azure 密钥";
    } else if (status === 429) {
      toastMsg = "试听失败：请求过于频繁被限流，请稍候再试";
    } else if (status >= 500 && status < 600) {
      toastMsg = `试听失败：Azure 服务端临时错误（${status}），请稍候重试`;
    } else if (/fetch|network|Failed to fetch|NetworkError|ECONN|ETIMEDOUT|ENOTFOUND/i.test(msg)) {
      toastMsg = "试听失败：网络连接异常，请检查网络后重试";
    } else if (/key is required/i.test(msg)) {
      toastMsg = "试听失败：未配置 Azure 密钥，请到设置页填写";
    } else if (/createEntry|file name|cannot contain|validateEntryName|webfs/i.test(msg)) {
      // 本地文件系统错误（文件名非法、磁盘满、权限等），与网络/密钥无关
      toastMsg = `试听失败：本地缓存写入出错（${msg}）。可尝试到设置页重新刷新音色列表后重试`;
    } else {
      toastMsg = `试听失败：${msg}`;
    }
    showToast(toastMsg, "error");
  } finally {
    // 清除所有试听按钮的 loading 状态
    document.querySelectorAll('.vp-card-preview-btn').forEach(b => b.classList.remove('loading'));
  }
}

// ─── 预设参数保存与加载 ───

/** 确保内置预设存在且在数组开头 */
function ensureDefaultPreset(settings: any): any[] {
  const presets = Array.isArray(settings.presets) ? [...settings.presets] : [];
  let defaultPreset = presets.find((p: any) => p.id === 'preset-default');
  if (!defaultPreset) {
    defaultPreset = {
      id: 'preset-default',
      name: '内置预设',
      voice: settings.defaultVoice || 'zh-CN-XiaoxiaoNeural',
      style: settings.defaultStyle || '',
      role: settings.defaultRole || '',
      styledegree: settings.defaultStyledegree || '1.0',
      rate: settings.defaultRate || '0%',
      pitch: settings.defaultPitch || '0%',
      volume: settings.defaultVolume || '100%'
    };
    presets.unshift(defaultPreset);
  } else {
    // 确保内置预设名称不被修改
    defaultPreset.name = '内置预设';
    // 迁移：早期内置预设音色曾为「小艺」(zh-CN-XiaoyiNeural)，统一改为「晓晓」(zh-CN-XiaoxiaoNeural)，
    // 与达芬奇版默认音色保持一致。宽松匹配以兼容大小写差异。
    if (typeof defaultPreset.voice === 'string' && defaultPreset.voice.toLowerCase().includes('xiaoyi')) {
      defaultPreset.voice = 'zh-CN-XiaoxiaoNeural';
    }
  }
  // 确保内置预设排在第一位
  const others = presets.filter((p: any) => p.id !== 'preset-default');
  return [defaultPreset, ...others];
}

function renderPresetDropdown() {
  const updateMenu = (menuId: string, dropdownId: string) => {
    const menu = $(menuId);
    const dropdown = $(dropdownId);
    if (!menu) return;
    let html = '';
    for (const preset of state.presets) {
      const isDefault = preset.id === state.defaultPresetId;
      const label = isDefault ? `${preset.name} (默认)` : preset.name;
      // 默认预设通过 selected 属性标记选中（UXP sp-picker 的 value 是只读的）
      const selectedAttr = isDefault ? ' selected' : '';
      html += `<sp-menu-item value="${preset.id}"${selectedAttr}>${label}</sp-menu-item>`;
    }
    menu.innerHTML = html;
    // 通过 setPickerValue 确保 picker 内部状态同步（sp-picker.value 为只读）
    if (dropdown && state.defaultPresetId) {
      setPickerValue(dropdown, state.defaultPresetId);
    }
  };
  updateMenu("subtitlePresetMenu", "subtitlePresetDropdown");
  updateMenu("manualPresetMenu", "manualPresetDropdown");
}

function savePreset(prefix: "subtitle" | "manual") {
  if (!state.selectedVoice) {
    showToast("请先选择音色", "info");
    return;
  }

  const style = $(`${prefix}StyleTags`)?.querySelector(".tag-item.active")?.getAttribute("data-style") || "";
  const role = $(`${prefix}RoleTags`)?.querySelector(".tag-item.active")?.getAttribute("data-role") || "";
  const styledegree = ($(`${prefix}Styledegree`) as any)?.value || "100";
  const rate = ($(`${prefix}Rate`) as any)?.value || "0";
  const pitch = ($(`${prefix}Pitch`) as any)?.value || "0";
  const volume = ($(`${prefix}Volume`) as any)?.value || "100";

  // 自动命名，避免 UXP 不支持 prompt() 的问题
  const presetName = `新预设 ${state.presets.length}`;

  const newPreset = {
    id: 'preset-' + Date.now(),
    name: presetName,
    voice: state.selectedVoice.shortName,
    style,
    role,
    styledegree: `${parseFloat(styledegree) / 100}`,
    rate: rate === "0" ? "0%" : `${rate}%`,
    pitch: pitch === "0" ? "0%" : `${pitch}%`,
    volume: `${volume}%`
  };

  state.presets.push(newPreset);

  // 只传需要修改的字段，避免 load() 失败时用默认值覆盖文件中的其他数据（如 voices、azureKey）
  settingsStore.save({
    presets: state.presets,
    defaultPresetId: state.defaultPresetId
  }).then(() => {
    showToast(`已保存为「${presetName}」，可在设置页重命名或删除`, "success");
    renderPresetDropdown();
    renderPresetsGrid();
    // 自动选中新保存的预设（sp-picker.value 为只读，需用 setPickerValue）
    const dropdown = $(`${prefix}PresetDropdown`);
    if (dropdown) setPickerValue(dropdown, newPreset.id);
  }).catch(e => {
    console.error("[Momo] 保存预设失败:", e);
    showToast("保存预设失败", "error");
  });
}

function applyPreset(presetId: string, prefix: "subtitle" | "manual", persist: boolean = true) {
  const preset = state.presets.find(p => p.id === presetId);
  if (!preset) return;

  const voice = state.voices.find(v => v.shortName === preset.voice);
  if (voice) {
    selectVoice(voice, persist).then(() => {
      const styleTags = $(`${prefix}StyleTags`)?.querySelectorAll(".tag-item");
      styleTags?.forEach(tag => {
        if (tag.getAttribute("data-style") === preset.style) {
          tag.classList.add("active");
        } else {
          tag.classList.remove("active");
        }
      });
      const styledegreeArea = $(`${prefix}StyledegreeArea`);
      if (styledegreeArea) {
        if (preset.style === "") styledegreeArea.classList.add("hidden");
        else styledegreeArea.classList.remove("hidden");
      }

      const roleTags = $(`${prefix}RoleTags`)?.querySelectorAll(".tag-item");
      roleTags?.forEach(tag => {
        if (tag.getAttribute("data-role") === preset.role) {
          tag.classList.add("active");
        } else {
          tag.classList.remove("active");
        }
      });

      const styledegreeSlider = $(`${prefix}Styledegree`) as any;
      if (styledegreeSlider) styledegreeSlider.value = Math.round(parseFloat(preset.styledegree) * 100);

      const rateSlider = $(`${prefix}Rate`) as any;
      if (rateSlider) rateSlider.value = parseInt(preset.rate.replace("%", ""), 10);

      const pitchSlider = $(`${prefix}Pitch`) as any;
      if (pitchSlider) pitchSlider.value = parseInt(preset.pitch.replace("%", ""), 10);

      const volumeSlider = $(`${prefix}Volume`) as any;
      if (volumeSlider) volumeSlider.value = parseInt(preset.volume.replace("%", ""), 10);
    });
  }
}

// ─── 预设管理网格（设置页）───

function renderPresetsGrid() {
  const grid = $('presetsGrid');
  if (!grid) return;

  // 空状态提示（理论上 ensureDefaultPreset 保证了至少有内置预设，但防御性处理）
  if (!state.presets || state.presets.length === 0) {
    grid.innerHTML = '<div class="presets-empty">暂无预设。可在字幕/手动配音页面点击「💾 保存」按钮创建自定义预设。</div>';
    return;
  }

  let html = '';
  for (const preset of state.presets) {
    const isDefault = preset.id === state.defaultPresetId;
    const isActive = state.selectedVoice ? preset.voice === state.selectedVoice.shortName : false;
    const isSystemDefault = preset.id === 'preset-default';
    const voiceCleaned = cleanVoiceName((preset.voice || '').split('-').pop() || preset.voice);
    const styleLabel = preset.style ? styleNameCn(preset.style) : '默认风格';

    let metaHtml = `<span class="preset-tag">${voiceCleaned}</span>`;
    metaHtml += `<span class="preset-tag">${styleLabel}</span>`;
    if (preset.rate && preset.rate !== '0%') metaHtml += `<span class="preset-tag">语速 ${preset.rate}</span>`;
    if (preset.pitch && preset.pitch !== '0%') metaHtml += `<span class="preset-tag">音调 ${preset.pitch}</span>`;
    if (preset.volume && preset.volume !== '100%') metaHtml += `<span class="preset-tag">音量 ${preset.volume}</span>`;

    // 内置预设不可改名，渲染为 span；自定义预设渲染为可点击编辑的 span（点击后变为 input）
    const titleHtml = isSystemDefault
      ? `<span class="preset-card-name-label">${preset.name}</span>`
      : `<span class="preset-card-name-text" data-id="${preset.id}" title="点击重命名">${preset.name || '未命名'}</span>`;

    // 内置预设不可删除，不渲染删除按钮
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
  }
  grid.innerHTML = html;

  // 点击预设名称 span 进入编辑模式（替换为 input，失焦/回车保存，Esc 取消）
  grid.querySelectorAll('.preset-card-name-text').forEach(span => {
    const spanEl = span as HTMLElement;
    spanEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = spanEl.getAttribute('data-id');
      if (!id) return;
      const preset = state.presets.find(p => p.id === id);
      if (!preset) return;

      // 用 input 替换 span 进入编辑态
      const inputEl = document.createElement('input') as HTMLInputElement;
      inputEl.type = 'text';
      inputEl.className = 'preset-card-name';
      inputEl.value = preset.name || '';
      inputEl.setAttribute('data-id', id);
      inputEl.setAttribute('spellcheck', 'false');
      inputEl.setAttribute('placeholder', '预设名称');
      spanEl.replaceWith(inputEl);
      inputEl.focus();
      try { inputEl.select(); } catch (_) { }

      let committed = false;
      const commit = async (save: boolean) => {
        if (committed) return;
        committed = true;
        if (save) {
          const newName = inputEl.value.trim();
          if (newName && newName !== preset.name) {
            preset.name = newName;
            await savePresetsToSettings();
            renderPresetDropdown();
            showToast(`预设已重命名为「${preset.name}」`, "success");
          }
        }
        // 重新渲染网格，把 input 换回 span
        renderPresetsGrid();
      };

      inputEl.addEventListener('blur', () => commit(true));
      inputEl.addEventListener('keydown', (ke: any) => {
        if (ke.key === 'Enter') { ke.preventDefault(); commit(true); }
        else if (ke.key === 'Escape') { ke.preventDefault(); commit(false); }
      });
      inputEl.addEventListener('click', (ce) => ce.stopPropagation());
    });
  });

  // 点击预设卡片：切换自动/手动配音的当前音色为该预设的音色（不修改默认预设）
  grid.querySelectorAll('.preset-card').forEach(card => {
    card.addEventListener('click', (e) => {
      const tgt = e.target as HTMLElement;
      // 点击名称（span 或编辑态 input）、删除按钮、星星时不触发卡片点击
      if (tgt.closest('.preset-card-name-text') || tgt.closest('.preset-card-name') || tgt.closest('.preset-card-delete') || tgt.closest('.preset-card-star')) return;
      const id = (card as HTMLElement).dataset.id;
      if (!id) return;
      const preset = state.presets.find(p => p.id === id);
      if (!preset || !preset.voice) return;
      const voice = state.voices.find(v => v.shortName === preset.voice);
      if (!voice) return;
      // persist=false：仅切换当前音色，不持久化为默认音色
      selectVoice(voice, false);
      renderPresetsGrid();
      showToast(`已切换音色为「${cleanVoiceName(voice.localName || voice.displayName || voice.shortName)}」`, "info");
    });
  });

  // 点击星星设为默认（点击卡片共身不设为默认，避免误触）
  grid.querySelectorAll('.preset-card-star').forEach(star => {
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = (star as HTMLElement).dataset.id;
      if (id) {
        state.defaultPresetId = id;
        renderPresetsGrid();
        savePresetsToSettings();
        renderPresetDropdown();
      }
    });
  });

  // 点击删除按钮
  grid.querySelectorAll('.preset-card-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = (btn as HTMLElement).dataset.id;
      if (!id) return;
      const preset = state.presets.find(p => p.id === id);
      if (!preset) return;
      // 内置预设不可删除
      if (id === 'preset-default') return;
      state.presets = state.presets.filter(p => p.id !== id);
      // 如果删除的是默认预设，回退到内置预设
      if (state.defaultPresetId === id) {
        state.defaultPresetId = 'preset-default';
      }
      await savePresetsToSettings();
      renderPresetsGrid();
      renderPresetDropdown();
      showToast(`已删除预设「${preset.name}」`, "success");
    });
  });
}

/** 将当前预设列表和默认预设 ID 持久化到设置 */
async function savePresetsToSettings() {
  try {
    // 只传需要修改的字段，避免 load() 失败时用默认值覆盖文件中的其他数据
    await settingsStore.save({
      presets: state.presets,
      defaultPresetId: state.defaultPresetId
    });
  } catch (e) {
    console.error("[Momo] 保存预设失败:", e);
  }
}

// ─── 缓存管理 ───

/**
 * 加载并显示缓存目录路径。
 *
 * 有活动项目时显示当前项目子目录路径（cache/{projectName}/），
 * 无活动项目时显示基础缓存目录路径（cache/）。
 */
async function loadCacheDirPath() {
  try {
    const projectName = state.projectName && state.projectName !== '无活动工程' ? state.projectName : '';
    const path = projectName
      ? await ttsProvider.getProjectCacheDirNativePath(projectName)
      : await ttsProvider.getBaseCacheDirNativePath();
    const el = $('cacheDirPath') as any;
    if (el) el.textContent = path;
  } catch (e) {
    console.error("[Momo] 获取缓存目录路径失败:", e);
  }
}

/**
 * 打开缓存目录（调用系统文件管理器）。
 *
 * 有活动项目时打开当前项目子目录，无活动项目时打开基础缓存目录。
 */
async function openCacheDir() {
  try {
    const projectName = state.projectName && state.projectName !== '无活动工程' ? state.projectName : '';
    const path = projectName
      ? await ttsProvider.getProjectCacheDirNativePath(projectName)
      : await ttsProvider.getBaseCacheDirNativePath();
    if (!path) {
      showToast("无法获取缓存目录路径", "error");
      return;
    }
    if (!uxpShell || typeof uxpShell.openPath !== 'function') {
      showToast("当前运行时不支持打开文件夹", "error");
      return;
    }
    const consentText = "默默配音助手需要授权打开缓存目录文件夹，首次打开需同意一次。";
    const err = await uxpShell.openPath(path, consentText);
    if (err && String(err).length > 0) {
      showToast(`打开缓存目录失败：${err}`, "error");
    }
  } catch (e: any) {
    console.error("[Momo] 打开缓存目录失败:", e);
    showToast(`打开缓存目录失败：${e?.message || e}`, "error");
  }
}

/**
 * 删除未使用缓存：扫描当前项目 momo-Voicesub 素材箱，删除当前项目缓存目录中
 * 未被引用的缓存文件。
 *
 * 仅扫描当前项目子目录（cache/{projectName}/），不会影响其他工程的缓存。
 */
async function deleteUnusedCache() {
  try {
    if (!state.projectName || state.projectName === '无活动工程') {
      showToast("未检测到活动项目，无法清理未使用缓存", "error");
      return;
    }
    showToast("正在扫描缓存...", "info");
    const usedNames = await premiereAdapter.getMomoBinMediaFileNames();
    const allCacheFiles = await ttsProvider.listCacheFileNames(state.projectName);

    if (allCacheFiles.length === 0) {
      showToast("当前项目缓存目录为空，无需清理", "info");
      return;
    }

    // 找出未使用的缓存文件（文件名不在素材箱中的）
    const toDelete: string[] = [];
    for (const fileName of allCacheFiles) {
      const noExt = fileName.replace(/\.\w+$/, '');
      // 文件名或去扩展名版本在素材箱中 → 被使用，保留
      if (usedNames.has(fileName) || usedNames.has(noExt)) continue;
      toDelete.push(fileName);
    }

    if (toDelete.length === 0) {
      showToast(`扫描 ${allCacheFiles.length} 个缓存文件，全部被当前项目使用，无需清理`, "info");
      return;
    }

    const deleted = await ttsProvider.deleteCacheFiles(state.projectName, toDelete);
    showToast(`已清理 ${deleted} 个未使用缓存（共扫描 ${allCacheFiles.length} 个）`, "success");
  } catch (e: any) {
    console.error("[Momo] 删除未使用缓存失败:", e);
    showToast(`删除未使用缓存失败：${e?.message || e}`, "error");
  }
}

/**
 * 删除当前项目缓存：直接删除当前项目的整个缓存子目录。
 *
 * 仅删除 cache/{projectName}/ 子目录，不影响其他工程的缓存。
 * 时间线中已插入的配音素材将变为离线。
 */
async function deleteCurrentProjectCache() {
  try {
    if (!state.projectName || state.projectName === '无活动工程') {
      showToast("未检测到活动项目，无法删除当前项目缓存", "error");
      return;
    }
    showToast("正在删除当前项目缓存...", "info");
    const deleted = await ttsProvider.deleteProjectCacheFolder(state.projectName);
    if (deleted === 0) {
      showToast("当前项目没有缓存文件", "info");
      return;
    }
    showToast(`已删除当前项目缓存 ${deleted} 个文件（时间线素材将变为离线）`, "success");
    // 刷新缓存目录路径显示（子目录被删除后 getProjectCacheFolder 会重建空目录）
    await loadCacheDirPath();
  } catch (e: any) {
    console.error("[Momo] 删除当前项目缓存失败:", e);
    showToast(`删除当前项目缓存失败：${e?.message || e}`, "error");
  }
}

/**
 * 删除全部缓存：删除基础缓存目录下所有项目子目录。
 *
 * 所有项目的配音素材将变为离线。不影响 preview 目录。
 */
async function deleteAllCache() {
  try {
    showToast("正在删除全部缓存...", "info");
    const deleted = await ttsProvider.deleteAllCacheFiles();
    if (deleted === 0) {
      showToast("缓存目录为空", "info");
      return;
    }
    showToast(`已删除全部缓存 ${deleted} 个文件（所有项目的配音素材将变为离线）`, "success");
    // 刷新缓存目录路径显示
    await loadCacheDirPath();
  } catch (e: any) {
    console.error("[Momo] 删除全部缓存失败:", e);
    showToast(`删除全部缓存失败：${e?.message || e}`, "error");
  }
}

// 缓存管理按钮绑定
$('openCacheDirBtn')?.addEventListener("click", openCacheDir);
$('deleteUnusedCacheBtn')?.addEventListener("click", deleteUnusedCache);
$('deleteCurrentProjectCacheBtn')?.addEventListener("click", deleteCurrentProjectCache);
$('deleteAllCacheBtn')?.addEventListener("click", deleteAllCache);

// ─── 设置页面交互 ───
$("saveSettingsBtn")?.addEventListener("click", async () => {
  const keyInput = $("settingAzureKey") as any;
  const rememberKeyCheckbox = $("settingRememberKey") as any;
  const regionInput = $("settingRegion") as any;

  // 读取表单值
  const formSettings: any = {
    rememberKey: rememberKeyCheckbox.checked,
    region: regionInput.value.trim()
  };

  // 只有用户输入了新 key（非空、非占位符）才传 azureKey；
  // 否则不传该字段，settings-store 会保留原 sessionAzureKey
  const keyVal = String(keyInput.value || "").trim();
  if (keyVal && keyVal !== "__SAVED_KEY_PLACEHOLDER__") {
    formSettings.azureKey = keyVal;
    // 用户输入了新 key 时自动勾选"记住密钥"，避免重新加载代码后 key 丢失
    formSettings.rememberKey = true;
    if (rememberKeyCheckbox) rememberKeyCheckbox.checked = true;
  }

  const saved = await settingsStore.save(formSettings);
  // 保存后把输入框重置为占位符状态（若有 key）
  if (keyInput) {
    keyInput.value = saved.hasAzureKey ? "__SAVED_KEY_PLACEHOLDER__" : "";
  }
  const savedMsg = saved.hasAzureKey ? '设置已保存，密钥可用' : '设置已保存，但没有可用密钥';
  showToast(savedMsg, "success");
});

$("testTtsConnection")?.addEventListener("click", async () => {
  const keyInput = $("settingAzureKey") as any;
  const regionInput = $("settingRegion") as any;

  // 解析 key：若输入框是占位符或空，则回退到已保存的 session key
  const rawKeyVal = String(keyInput.value || "").trim();
  let effectiveKey = "";
  if (rawKeyVal && rawKeyVal !== "__SAVED_KEY_PLACEHOLDER__") {
    effectiveKey = rawKeyVal;
  } else {
    effectiveKey = await settingsStore.getAzureKey();
  }

  if (!effectiveKey) {
    showToast("请输入 API 密钥", "error");
    return;
  }
  if (!regionInput.value) {
    showToast("请输入位置/区域", "error");
    return;
  }

  showToast("正在测试与微软语音服务连接...", "info");

  try {
    // endpoint 输入框已移除，从已保存的设置中读取（仅 settings.json 中的进阶配置生效）
    const savedSettings = await settingsStore.load();
    const testSettings = {
      azureKey: effectiveKey,
      region: regionInput.value.trim(),
      endpoint: savedSettings.endpoint || ""
    };

    const tempProvider = new AzureTtsProvider({
      getSettings: () => Promise.resolve(testSettings),
      getAzureKey: () => Promise.resolve(testSettings.azureKey)
    });

    const voices = await tempProvider.listVoices();

    // 测试成功后，若是新输入的 key 且勾选了记住，顺便保存
    if (rawKeyVal && rawKeyVal !== "__SAVED_KEY_PLACEHOLDER__") {
      const rememberKeyCheckbox = $("settingRememberKey") as any;
      await settingsStore.save({
        azureKey: rawKeyVal,
        rememberKey: rememberKeyCheckbox?.checked ?? false,
        region: regionInput.value.trim(),
        voices
      });
      // 保存后重置输入框为占位符
      keyInput.value = "__SAVED_KEY_PLACEHOLDER__";
    } else {
      // 只更新音色列表（只传 voices 字段，避免覆盖其他数据）
      await settingsStore.save({ voices });
    }

    state.voices = voices;
    updateVoiceTriggers();
    if (state.currentTab === 'voices') renderVoicesPage();

    showToast(`连接测试成功！获取到 ${voices.length} 种音色`, "success");

  } catch (e: any) {
    console.error(e);
    const msg = e?.message || e;
    showToast(`连接测试失败：${msg}`, "error");
  }
});

// 「刷新音色」按钮（位于音色选择页底部）：通过 delegating provider 自动选择最佳通道
// （有自填 key → Azure；有云端登录 → Cloud；都没有 → 公开 manifest 接口）
const voicePageRefreshBtn = $("voicePageRefreshBtn") as any;
voicePageRefreshBtn?.addEventListener("click", async () => {
  if (isLocalChannelActive()) {
    switchToTab('settings');
    (document.querySelector('.auth-tab[data-auth-tab="local"]') as HTMLElement)?.click();
    return;
  }
  const originalText = voicePageRefreshBtn?.textContent;
  if (voicePageRefreshBtn) {
    voicePageRefreshBtn.setAttribute("disabled", "true");
    voicePageRefreshBtn.textContent = "刷新中…";
  }
  showToast("正在刷新音色列表...", "info");
  try {
    const voices = await ttsProvider.listVoices();

    // 只更新音色列表，不动 key 和其他设置（只传 voices 字段，避免覆盖其他数据）
    await settingsStore.save({ voices });

    state.voices = voices;
    updateVoiceTriggers();
    if (state.currentTab === 'voices') renderVoicesPage();

    showToast(`已刷新 ${voices.length} 个音色`, "success");
  } catch (e: any) {
    console.error(e);
    const msg = e?.message || e;
    showToast(`刷新音色失败：${msg}`, "error");
  } finally {
    if (voicePageRefreshBtn) {
      voicePageRefreshBtn.removeAttribute("disabled");
      voicePageRefreshBtn.textContent = originalText || "刷新音色";
    }
  }
});

// ─── 云端账号登录 ───

/**
 * 从 JWT access_token 中解码 email（atob 在 UXP 下可用）
 */
function decodeJwtEmail(token: string): string {
  try {
    const b64url = token.split('.')[1];
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '=='.slice(0, (4 - b64.length % 4) % 4);
    const json = atob(padded);
    const payload = JSON.parse(json);
    return payload.email || '';
  } catch {
    return '';
  }
}

/**
 * 打开外部链接（封装 uxpShell.openExternal，统一错误处理）
 */
async function openExternalUrl(url: string, desc?: string) {
  if (uxpShell && typeof (uxpShell as any).openExternal === 'function') {
    try {
      // UXP openExternal 第二个参数是「用户同意对话框」的提示文字
      const err = await (uxpShell as any).openExternal(url, desc || '打开外部链接');
      if (err && String(err).length > 0) {
        showToast(`打开${desc || '链接'}失败：${err}`, "error");
      }
    } catch (e: any) {
      showToast(`打开${desc || '链接'}失败：${e?.message || e}`, "error");
    }
  } else {
    showToast("当前运行时不支持打开外部链接", "error");
  }
}

/** 用 refresh_token 刷新 access_token，写入存储并返回新 token（并发安全） */
let _cloudRefreshPromise: Promise<string> | null = null;
async function doRefreshToken(tokenData: any): Promise<string> {
  if (!tokenData?.refresh_token) {
    const err: any = new Error('NO_REFRESH_TOKEN');
    err.code = 'NO_REFRESH_TOKEN';
    throw err;
  }
  if (_cloudRefreshPromise) return _cloudRefreshPromise;
  _cloudRefreshPromise = (async () => {
    const refreshed = await cloudClient.refreshToken(tokenData.refresh_token);
    await cloudStore.saveToken({
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      email: tokenData.email || '',
      is_admin: refreshed.is_admin || tokenData.is_admin || false,
      nickname: tokenData.nickname || '',
    });
    return refreshed.access_token;
  })().finally(() => { _cloudRefreshPromise = null; });
  return _cloudRefreshPromise;
}

/** 云端登录 */
async function cloudLogin(email: string, password: string) {
  if (!email || !password) throw new Error('邮箱和密码不能为空');
  const result = await cloudClient.login(email, password);
  let userEmail = email;
  const decoded = decodeJwtEmail(result.access_token);
  if (decoded) userEmail = decoded;

  await cloudStore.saveToken({
    access_token: result.access_token,
    refresh_token: result.refresh_token,
    email: userEmail,
    is_admin: result.is_admin,
    nickname: result.nickname,
  });

  // 登录成功后强制注册设备（设备数超限时阻断登录）
  try {
    const deviceFp = await cloudStore.getDeviceFp();
    await cloudClient.registerDevice(result.access_token, deviceFp);
  } catch (err: any) {
    if (err.code === 'DEVICE_LIMIT' || err.status === 403) {
      await cloudStore.clearToken();
      throw new Error('此设备已登录过多账号，白嫖不要太狠啦，行行好');
    }
    // 其他错误不影响登录
    console.error('[Momo] 设备自动注册失败:', err);
  }

  return { ok: true, email: userEmail, is_admin: result.is_admin, nickname: result.nickname };
}

/** 退出登录 */
async function cloudLogout() {
  await cloudStore.clearToken();
  // 退出后清空音色列表
  await settingsStore.save({ voices: [] });
  state.voices = [];
  updateVoiceTriggers();
}

/** 获取云端登录状态 */
async function cloudGetState() {
  const tokenData = await cloudStore.loadToken();
  if (!tokenData?.access_token) return { isLoggedIn: false };
  return {
    isLoggedIn: true,
    email: tokenData.email || '',
    is_admin: tokenData.is_admin || false,
    nickname: tokenData.nickname || '',
  };
}

/** 获取配额（带 token 自动刷新） */
async function cloudGetQuota() {
  let tokenData = await cloudStore.loadToken();
  if (!tokenData?.access_token) return { isLoggedIn: false };
  try {
    const quota = await cloudClient.getQuota(tokenData.access_token);
    return { isLoggedIn: true, quota };
  } catch (err: any) {
    if (err.code === 'TOKEN_EXPIRED') {
      try {
        const newToken = await doRefreshToken(tokenData);
        const quota = await cloudClient.getQuota(newToken);
        return { isLoggedIn: true, quota };
      } catch {
        await cloudStore.clearToken();
        return { isLoggedIn: false, error: 'TOKEN_EXPIRED' };
      }
    }
    throw err;
  }
}

/** 从云端刷新音色列表（带 token 自动刷新；未登录时回退公开接口） */
async function cloudRefreshVoices() {
  let tokenData = await cloudStore.loadToken();
  if (!tokenData?.access_token) {
    // 未登录 → 公开音色列表接口（manifest-only，不需要 JWT）
    const voices = await cloudClient.listVoicesPublic();
    await settingsStore.save({ voices });
    return voices;
  }
  try {
    const voices = await cloudClient.listVoices(tokenData.access_token);
    await settingsStore.save({ voices });
    return voices;
  } catch (err: any) {
    if (err.code === 'TOKEN_EXPIRED') {
      const newToken = await doRefreshToken(tokenData);
      const voices = await cloudClient.listVoices(newToken);
      await settingsStore.save({ voices });
      return voices;
    }
    throw err;
  }
}

/** 注册/刷新设备绑定 */
async function cloudRegisterDevice() {
  const tokenData = await cloudStore.loadToken();
  if (!tokenData?.access_token) throw new Error('未登录云端账号');
  const deviceFp = await cloudStore.getDeviceFp();
  await cloudClient.registerDevice(tokenData.access_token, deviceFp);
  return { ok: true, device_fp: deviceFp };
}

/**
 * 刷新云端账号状态 UI（加载态 → 未登录/已登录）
 */
async function refreshCloudAccount() {
  const loadingDiv = $("accountLoading");
  const loggedOutDiv = $("accountLoggedOut");
  const loggedInDiv = $("accountLoggedIn");
  if (!loggedOutDiv || !loggedInDiv) return;

  // 进入加载态
  if (loadingDiv) loadingDiv.classList.remove("hidden");
  loggedOutDiv.classList.add("hidden");
  loggedInDiv.classList.add("hidden");

  try {
    const cloudState = await cloudGetState();
    if (!cloudState.isLoggedIn) {
      if (loadingDiv) loadingDiv.classList.add("hidden");
      loggedOutDiv.classList.remove("hidden");
      return;
    }

    // 已登录，获取配额
    const quotaRes = await cloudGetQuota();
    if (!quotaRes.isLoggedIn) {
      // token 过期且刷新失败
      if (loadingDiv) loadingDiv.classList.add("hidden");
      loggedOutDiv.classList.remove("hidden");
      showToast("登录已过期，请重新登录", "info");
      showLoginDialog();
      return;
    }

    if (loadingDiv) loadingDiv.classList.add("hidden");
    loggedOutDiv.classList.add("hidden");
    loggedInDiv.classList.remove("hidden");

    // 更新账号信息
    const emailEl = $("accountEmail");
    if (emailEl) emailEl.textContent = cloudState.email || (quotaRes as any).quota?.email || 'user@example.com';

    const planBadge = $("accountPlanBadge") as any;
    if (planBadge) {
      const plan = (quotaRes as any).quota?.plan || 'free';
      planBadge.textContent = plan === 'free' ? '免费版' : (plan === 'pro' ? '专业版' : plan);
    }

    const planExpire = $("accountPlanExpire");
    if (planExpire) {
      const exp = (quotaRes as any).quota?.expires_at;
      planExpire.textContent = exp ? `有效期至 ${new Date(exp).toLocaleDateString()}` : '长期有效';
    }

    // 更新配额显示
    const std = (quotaRes as any).quota?.std_chars;
    if (std) {
      const stdLabelEl = $("quotaStdLabel");
      if (stdLabelEl) stdLabelEl.textContent = `标准语音（${std.reset_period === 'monthly' ? '本月' : '终身'}）`;
      const leftEl = $("quotaCharsLeft");
      const totalEl = $("quotaCharsTotal");
      const barEl = $("quotaCharsBar") as any;
      if (leftEl) leftEl.textContent = (std.remaining ?? 0).toLocaleString();
      if (totalEl) totalEl.textContent = (std.total ?? 0).toLocaleString();
      if (barEl && std.total > 0) {
        const pct = Math.max(0, Math.min(100, (std.remaining / std.total) * 100));
        barEl.style.width = `${pct}%`;
      }
    }

    const neural = (quotaRes as any).quota?.neural_chars;
    if (neural) {
      const neuralLabelEl = $("quotaNeuralLabel");
      if (neuralLabelEl) neuralLabelEl.textContent = `神经语音（${neural.reset_period === 'monthly' ? '本月' : '终身'}）`;
      const nLeftEl = $("quotaNeuralLeft");
      const nTotalEl = $("quotaNeuralTotal");
      const nBarEl = $("quotaNeuralBar") as any;
      if (nLeftEl) nLeftEl.textContent = (neural.remaining ?? 0).toLocaleString();
      if (nTotalEl) nTotalEl.textContent = (neural.total ?? 0).toLocaleString();
      if (nBarEl && neural.total > 0) {
        const nPct = Math.max(0, Math.min(100, (neural.remaining / neural.total) * 100));
        nBarEl.style.width = `${nPct}%`;
      }
    }

    const dev = (quotaRes as any).quota?.devices;
    if (dev) {
      const devEl = $("quotaDevices");
      const devMaxEl = $("quotaDevicesMax");
      if (devEl) devEl.textContent = String(dev.count ?? 0);
      if (devMaxEl) devMaxEl.textContent = dev.is_unlimited ? '无限制' : String(dev.max ?? 0);
    }

    // 后台静默注册/刷新设备绑定
    cloudRegisterDevice().catch(err => {
      console.error('[Momo] 设备注册失败:', err);
    });
  } catch (err: any) {
    console.error('[Momo] 刷新账号状态失败:', err);
    if (loadingDiv) loadingDiv.classList.add("hidden");
    loggedOutDiv.classList.remove("hidden");
    loggedInDiv.classList.add("hidden");
  }
}

/**
 * 根据当前 activeChannel 设置或认证状态自动切换"连接设置"的选项卡：
 *   1. 显式设置 activeChannel: 'local' → 'local', 'cloud' → 'account', 'azure' → 'apikey'
 *   2. 未显式设置时隐式推断：
 *      a. 有自填 Azure Key → "自填 Key" (apikey)
 *      b. 已登录云端 → "登录账号" (account)
 *      c. 有 local 配置 → "本地部署" (local)
 *      d. 默认 → "自填 Key" (apikey)
 * 仅在用户切到设置页时触发，不干扰用户手动切换。
 */
async function autoSelectAuthTab() {
  try {
    const settings = await settingsStore.load();
    const explicit = settings.activeChannel;
    let targetTab = 'apikey';
    if (explicit === 'local') {
      targetTab = 'local';
    } else if (explicit === 'cloud') {
      targetTab = 'account';
    } else if (explicit === 'azure') {
      targetTab = 'apikey';
    } else {
      const hasAzureKey = Boolean(await settingsStore.getAzureKey());
      if (hasAzureKey) {
        targetTab = 'apikey';
      } else {
        const cloudState = await cloudGetState();
        if (cloudState.isLoggedIn) {
          targetTab = 'account';
        } else if (settings.localTts?.baseUrl && Array.isArray(settings.localTts?.voices) && settings.localTts.voices.length > 0) {
          targetTab = 'local';
        } else {
          targetTab = 'apikey';
        }
      }
    }
    const tabBtn = document.querySelector(`.auth-tab[data-auth-tab="${targetTab}"]`);
    if (tabBtn && !tabBtn.classList.contains('active')) {
      (tabBtn as HTMLElement).click();
    }
  } catch {
    // 查询失败时不干扰默认状态
  }
}

// ─── auth-tab 选项卡切换 ───
document.querySelectorAll('.auth-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const target = tab.getAttribute('data-auth-tab');
    if (!target) return;
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const panel = document.querySelector(`.auth-panel[data-auth-panel="${target}"]`);
    if (panel) panel.classList.add('active');
    updateLocalHeaderStatus();
    if (target === 'local') {
      renderLocalVoicesList();
    }
  });
});

// ─── 登录弹窗 ───

/** 显示登录弹窗 */
async function showLoginDialog() {
  const dialog = $("loginDialog") as any;
  if (!dialog) return;

  // 清空表单
  const emailInput = $("loginEmail") as any;
  const passwordInput = $("loginPassword") as any;
  if (emailInput) emailInput.value = '';
  if (passwordInput) passwordInput.value = '';

  // 登录按钮
  const submitBtn = $("loginSubmit") as any;
  if (submitBtn) {
    if (submitBtn._clickHandler) submitBtn.removeEventListener('click', submitBtn._clickHandler);
    const handler = async () => {
      const email = (emailInput?.value || '').trim();
      const password = passwordInput?.value || '';
      if (!email || !password) {
        showToast('请输入邮箱和密码', 'error');
        return;
      }
      submitBtn.setAttribute('disabled', 'true');
      const originalText = submitBtn.textContent;
      submitBtn.textContent = '登录中...';
      try {
        await cloudLogin(email, password);
        showToast('登录成功', 'success');
        dialog.close('ok');
        await refreshCloudAccount();
        // 自动切换到"登录账号"面板
        const accountTab = document.querySelector('.auth-tab[data-auth-tab="account"]');
        if (accountTab) (accountTab as HTMLElement).click();
      } catch (err: any) {
        showToast(err.message || '登录失败', 'error');
      } finally {
        submitBtn.removeAttribute('disabled');
        submitBtn.textContent = originalText || '登录';
      }
    };
    submitBtn._clickHandler = handler;
    submitBtn.addEventListener('click', handler);
  }

  await dialog.uxpShowModal({
    title: '登录 MoMoVoiceSub',
    resize: 'none',
    size: { width: 380, height: 360 }
  });
}

// 打开登录弹窗按钮
$("openLoginPopup")?.addEventListener('click', () => {
  showLoginDialog();
});

// 忘记密码 → 跳转官网
$("loginForgot")?.addEventListener('click', (e: Event) => {
  e.preventDefault();
  openExternalUrl(WEB_PUBLIC_URL + '/login', '打开登录页面');
});

// 去官网注册
$("openSignupWeb")?.addEventListener('click', (e: Event) => {
  e.preventDefault();
  openExternalUrl(WEB_PUBLIC_URL + '/login', '打开注册页面');
});

// 用户协议
$("openTerms")?.addEventListener('click', (e: Event) => {
  e.preventDefault();
  openExternalUrl(WEB_PUBLIC_URL + '/terms', '打开用户协议');
});

// 隐私政策
$("openPrivacy")?.addEventListener('click', (e: Event) => {
  e.preventDefault();
  openExternalUrl(WEB_PUBLIC_URL + '/privacy', '打开隐私政策');
});

// ─── 通用确认对话框 ───

/** 显示确认对话框，返回用户是否点击了"确认" */
async function showConfirmDialog(opts: {
  title?: string;
  message: string;
  detail?: string;
  confirmText?: string;
  danger?: boolean;
  width?: number;
  height?: number;
  hideCancel?: boolean;
}): Promise<boolean> {
  const dialog = $("confirmDialog") as any;
  if (!dialog) return false;

  const msgEl = $("confirmDialogMessage");
  const detailEl = $("confirmDialogDetail");
  const okBtn = $("confirmDialogOk") as any;
  const cancelBtn = $("confirmDialogCancel") as any;

  if (msgEl) msgEl.textContent = opts.message;
  if (detailEl) detailEl.textContent = opts.detail || '';
  if (okBtn) {
    okBtn.textContent = opts.confirmText || '确认';
    // danger 模式下用负面色调（sp-button 无 negative variant，用 attr 辅助 CSS）
    if (opts.danger) okBtn.setAttribute('variant', 'negative');
    else okBtn.setAttribute('variant', 'primary');
  }
  if (cancelBtn) {
    cancelBtn.style.display = opts.hideCancel ? 'none' : '';
  }

  // 绑定按钮事件（每次重新绑定）
  const bindBtn = (btn: any, handler: () => void) => {
    if (!btn) return;
    if (btn._clickHandler) btn.removeEventListener('click', btn._clickHandler);
    btn._clickHandler = handler;
    btn.addEventListener('click', handler);
  };

  bindBtn(okBtn, () => dialog.close('ok'));
  bindBtn(cancelBtn, () => dialog.close('cancel'));

  const dlgWidth = opts.width || 420;
  // 根据 detail 字数智能适配弹窗高度，防止文字换行溢出裁切按钮
  const extraH = opts.detail && opts.detail.length > 50 ? 60 : 0;
  const dlgHeight = opts.height || (190 + extraH);

  const result = await dialog.uxpShowModal({
    title: opts.title || '确认操作',
    resize: 'none',
    size: { width: dlgWidth, height: dlgHeight }
  });

  return result === 'ok';
}

// 退出登录
$("accountLogout")?.addEventListener('click', async () => {
  const confirmed = await showConfirmDialog({
    message: '确认退出云端登录？',
    detail: '退出后将无法使用云端配音配额，音色列表也会被清空。',
    confirmText: '退出登录',
    danger: true,
  });
  if (!confirmed) return;
  try {
    await cloudLogout();
    await refreshCloudAccount();
    showToast('已退出登录', 'info');
  } catch (err: any) {
    showToast(err.message || '退出失败', 'error');
  }
});

// 刷新配额
$("refreshQuota")?.addEventListener('click', async () => {
  const btn = $("refreshQuota") as any;
  if (btn) btn.setAttribute('disabled', 'true');
  try {
    await refreshCloudAccount();
    showToast('配额已刷新', 'success');
  } catch (err: any) {
    showToast(err.message || '刷新失败', 'error');
  } finally {
    if (btn) btn.removeAttribute('disabled');
  }
});

// 续费/升级 → 跳转官网
$("openBuyPlan")?.addEventListener('click', () => {
  openExternalUrl(WEB_PUBLIC_URL + '/pricing', '打开定价页面');
});

// ═══════════════════════════════════════════════════════════════════════
// 本地引擎与音色管理（GPT-SoVITS 本地部署）
// ═══════════════════════════════════════════════════════════════════════

let lastEngineInfo = { running: false, port: 9880, pid: null as any, state: 'stopped', errorMsg: '' };
let lastUrlConnState: 'idle' | 'testing' | 'connected' | 'error' = 'idle';
let scannedModels: ScannedModel[] = [];
let editingVoiceId: string | null = null;
let enginePollTimer: any = null;

/** 读取当前接入方式：'managed' = 插件托管本地整合包；'url' = 连接已有服务 */
function getLocalMode(): 'managed' | 'url' {
  const sel = $("localModeSelect") as any;
  return sel?.value === 'url' ? 'url' : 'managed';
}

function setLocalMode(mode: 'managed' | 'url') {
  const sel = $("localModeSelect") as any;
  if (sel) sel.value = mode;
  applyLocalModeVisibility();
}

function applyLocalModeVisibility() {
  const isManaged = getLocalMode() === 'managed';
  const managedBox = $("localManagedBox");
  const urlBox = $("localUrlBox");
  const startBtn = $("engineStartBtn");
  const stopBtn = $("engineStopBtn");
  const testBtn = $("testLocalConn");
  if (managedBox) managedBox.classList.toggle('hidden', !isManaged);
  if (urlBox) urlBox.classList.toggle('hidden', isManaged);
  if (startBtn) startBtn.classList.toggle('hidden', !isManaged);
  if (stopBtn) stopBtn.classList.toggle('hidden', !isManaged);
  if (testBtn) testBtn.classList.toggle('hidden', isManaged);
  updateLocalHeaderStatus();
}

function getLocalTextLang(): string {
  if (getLocalMode() === 'managed') return ($("localTextLang") as any)?.value || 'auto';
  return ($("localTextLangUrl") as any)?.value || 'auto';
}

/** 更新卡片头部右上角的状态徽章 */
function updateLocalHeaderStatus(stateStr?: string, portNum?: number) {
  const badge = $("localHeaderEngineStatus");
  if (!badge) return;

  const currentTab = document.querySelector('.auth-tab.active')?.getAttribute('data-auth-tab');
  if (currentTab !== 'local') {
    badge.classList.add('hidden');
    return;
  }
  badge.classList.remove('hidden');

  const isManaged = getLocalMode() === 'managed';
  if (isManaged) {
    if (lastEngineInfo.state === 'starting') {
      badge.className = 'header-engine-badge status-starting';
      badge.textContent = '启动中...';
      badge.title = '正在启动本地服务并探测接口';
    } else if (lastEngineInfo.state === 'stopping') {
      badge.className = 'header-engine-badge status-starting';
      badge.textContent = '停止中...';
      badge.title = '正在停止本地服务';
    } else if (lastEngineInfo.state === 'error') {
      badge.className = 'header-engine-badge status-error';
      badge.textContent = '启动失败';
      badge.title = lastEngineInfo.errorMsg || '服务启动失败';
    } else if (lastEngineInfo.running) {
      badge.className = 'header-engine-badge status-running';
      badge.textContent = `运行中: ${lastEngineInfo.port || 9880}`;
      badge.title = `服务运行中 (端口: ${lastEngineInfo.port || 9880})`;
    } else {
      badge.className = 'header-engine-badge';
      badge.textContent = '未启动';
      badge.title = '本地服务未启动';
    }
  } else {
    if (lastUrlConnState === 'testing') {
      badge.className = 'header-engine-badge status-starting';
      badge.textContent = '测试中...';
      badge.title = '正在测试连接...';
    } else if (lastUrlConnState === 'connected') {
      badge.className = 'header-engine-badge status-running';
      badge.textContent = '已连接';
      badge.title = ($("localBaseUrl") as any)?.value?.trim() || '服务正常';
    } else if (lastUrlConnState === 'error') {
      badge.className = 'header-engine-badge status-error';
      badge.textContent = '未连接';
      badge.title = '连接失败，请确认服务已启动且端口正确';
    } else {
      badge.className = 'header-engine-badge';
      badge.textContent = '未测试';
      badge.title = '点击测试连接验证服务状态';
    }
  }

  syncEngineButtonsUI();
}

/** 同步本地托管模式下的启动/停止按钮状态 */
function syncEngineButtonsUI() {
  const isManaged = getLocalMode() === 'managed';
  const startBtn = $("engineStartBtn") as any;
  const stopBtn = $("engineStopBtn") as any;
  if (!isManaged) return;

  const isRunning = Boolean(lastEngineInfo.running);
  const isStarting = lastEngineInfo.state === 'starting';
  const isStopping = lastEngineInfo.state === 'stopping';

  if (startBtn) {
    if (isRunning || isStarting || isStopping) {
      startBtn.setAttribute('disabled', 'true');
      startBtn.disabled = true;
    } else {
      startBtn.removeAttribute('disabled');
      startBtn.disabled = false;
    }
  }

  if (stopBtn) {
    if (isRunning && !isStopping) {
      stopBtn.removeAttribute('disabled');
      stopBtn.disabled = false;
    } else {
      stopBtn.setAttribute('disabled', 'true');
      stopBtn.disabled = true;
    }
  }
}

/** 获取当前生效的通道 */
async function getEffectiveChannel(): Promise<string> {
  const s = await settingsStore.load();
  if (s.activeChannel) return s.activeChannel;
  if (await settingsStore.getAzureKey()) return 'azure';
  const cloud = await cloudGetState();
  if (cloud.isLoggedIn) return 'cloud';
  if (s.localTts?.baseUrl && s.localTts?.voices && s.localTts.voices.length > 0) return 'local';
  return (await settingsStore.getAzureKey()) ? 'azure' : (cloud.isLoggedIn ? 'cloud' : 'azure');
}

function applyChannelCapabilityUI(isLocal: boolean) {
  for (const prefix of ['subtitle', 'manual']) {
    toggleHidden($(`${prefix}PresetBar`), isLocal);
    toggleHidden($(`${prefix}PolyToggle`), isLocal);
    toggleHidden($(`${prefix}StyleArea`), isLocal);
    toggleHidden($(`${prefix}PitchArea`), isLocal);
    toggleHidden($(`${prefix}VolumeArea`), isLocal);
    toggleHidden($(`${prefix}InsertPause`), isLocal);
    toggleHidden($(`${prefix}SingleCorrect`), isLocal);
    toggleHidden($(`${prefix}BatchCorrect`), isLocal);
  }
  toggleHidden($('polyDictCard'), isLocal);
  toggleHidden($('presetsCard'), isLocal);
  if (!isLocal) {
    renderPresetsGrid();
    renderPresetDropdown();
  }
  const refreshBtn = $('voicePageRefreshBtn');
  if (refreshBtn) {
    refreshBtn.textContent = isLocal ? '管理本地音色' : '刷新音色';
  }
}

/** 更新通道启用按钮状态并同步各面板能力UI */
async function updateChannelEnableButtons() {
  const effective = await getEffectiveChannel();
  cachedEffectiveChannel = effective;
  document.querySelectorAll('.channel-enable-btn').forEach((btn) => {
    const channel = btn.getAttribute('data-enable-channel');
    const isActive = channel === effective;
    btn.classList.toggle('active', isActive);
    btn.textContent = isActive ? '使用中' : '启用此通道';
  });
  applyChannelCapabilityUI(isLocalChannelActive());
}

/** 探测并显示整合包信息 */
async function detectLocalEngine(rootDir: string) {
  const resultEl = $("localDetectResult");
  if (!resultEl) return;
  if (!rootDir) {
    resultEl.classList.add("hidden");
    resultEl.textContent = "";
    return;
  }
  try {
    const det = await engineDetect(rootDir);
    resultEl.classList.remove("hidden");
    if (det.ok) {
      resultEl.className = "detect-result detect-success";
      resultEl.textContent = `已识别 GPT-SoVITS 整合包（${det.hasRuntime ? '自带 Python 环境' : '系统 Python'}）`;
    } else {
      resultEl.className = "detect-result detect-error";
      resultEl.textContent = `未在该目录识别到有效的 GPT-SoVITS 整合包结构（${(det.issues || []).join('；') || '缺少必要脚本'}）`;
    }
  } catch (e: any) {
    resultEl.className = "detect-result detect-error";
    resultEl.textContent = `探测失败：${e.message || e}`;
  }
}

/** 探测本地服务是否可连通 */
async function checkLocalServiceStatus(silent: boolean = true) {
  const settings = await settingsStore.load();
  const isManaged = getLocalMode() === 'managed';
  let url = '';
  if (isManaged) {
    const port = parseInt(($("localPort") as any)?.value || String(settings.localTts?.engine?.port || 9880), 10);
    url = `http://127.0.0.1:${port}`;
  } else {
    url = ($("localBaseUrl") as any)?.value?.trim() || settings.localTts?.baseUrl || '';
  }
  if (!url) return;
  try {
    const res = await probeGptSoVits(url);
    if (isManaged) {
      lastEngineInfo.running = Boolean(res.ok && res.ready);
      lastEngineInfo.port = parseInt(($("localPort") as any)?.value || '9880', 10);
      lastEngineInfo.state = lastEngineInfo.running ? 'running' : 'stopped';
    } else {
      lastUrlConnState = (res.ok && res.ready) ? 'connected' : (silent ? 'idle' : 'error');
    }
    updateLocalHeaderStatus();
  } catch {
    if (isManaged) {
      lastEngineInfo.running = false;
      lastEngineInfo.state = 'stopped';
    } else {
      lastUrlConnState = silent ? 'idle' : 'error';
    }
    updateLocalHeaderStatus();
  }
}

/** 将本地设置回填至表单 */
async function loadLocalSettingsToForm() {
  const settings = await settingsStore.load();
  const local = (settings.localTts || DEFAULT_LOCAL_TTS) as any;
  const serviceTypeSel = $("localServiceType") as any;
  if (serviceTypeSel) serviceTypeSel.value = local.serviceType || 'gpt-sovits';
  setLocalMode(local.mode === 'url' ? 'url' : 'managed');

  const rootDirInput = $("localRootDir") as any;
  if (rootDirInput) rootDirInput.value = local.engine?.rootDir || '';
  const portInput = $("localPort") as any;
  if (portInput) portInput.value = String(local.engine?.port || 9880);
  const baseUrlInput = $("localBaseUrl") as any;
  if (baseUrlInput) baseUrlInput.value = local.baseUrl || '';
  const textLangManaged = $("localTextLang") as any;
  if (textLangManaged) textLangManaged.value = local.textLang || 'auto';
  const textLangUrl = $("localTextLangUrl") as any;
  if (textLangUrl) textLangUrl.value = local.textLang || 'auto';

  renderLocalVoicesList();
  applyLocalModeVisibility();

  if (local.engine?.rootDir) {
    detectLocalEngine(local.engine.rootDir);
  }
  checkLocalServiceStatus(true);
}

/** 保存本地设置 */
async function saveLocalSettings() {
  const settings = await settingsStore.load();
  const mode = getLocalMode();
  const serviceType = ($("localServiceType") as any)?.value || 'gpt-sovits';
  const rootDir = ($("localRootDir") as any)?.value?.trim() || '';
  const port = parseInt(($("localPort") as any)?.value || '9880', 10);
  const textLang = getLocalTextLang();
  const rawUrl = ($("localBaseUrl") as any)?.value?.trim() || '';
  const baseUrl = mode === 'managed' ? `http://127.0.0.1:${port}` : rawUrl;

  const localTts: LocalTtsSettings = {
    serviceType: 'gpt-sovits',
    mode,
    baseUrl,
    textLang,
    engine: {
      rootDir,
      port,
      pythonPath: settings.localTts?.engine?.pythonPath || '',
      script: settings.localTts?.engine?.script || 'api_v2.py'
    },
    voices: (settings.localTts?.voices || []) as any
  };

  await settingsStore.save({ localTts });
  showToast("本地部署设置已保存", "success");
  await updateChannelEnableButtons();
  if (isLocalChannelActive()) {
    await syncLocalVoices();
    updateVoiceTriggers();
    if (state.currentTab === 'voices') renderVoicesPage();
  }
}

/** 渲染本地音色列表 */
function renderLocalVoicesList() {
  const container = $("localVoicesList");
  if (!container) return;
  settingsStore.load().then(settings => {
    const voices = settings.localTts?.voices || [];
    if (!voices.length) {
      container.innerHTML = '<div class="table-placeholder" style="cursor:pointer;" id="placeholderAddLocalVoiceBtn">暂未配置音色。点击「+ 新增音色」，选择已训练的模型并指定参考音频即可。</div>';
      container.querySelector('#placeholderAddLocalVoiceBtn')?.addEventListener('click', () => openVoiceEditor(null));
      return;
    }
    container.innerHTML = voices.map(v => {
      const avatarType = (v as any).avatarType || ((v as any).gender === 'Male' ? 'man' : 'woman');
      const avatarCfg = AVATAR_CONFIG[avatarType] || AVATAR_CONFIG.woman;
      const avatarImg = (v as any).avatar || avatarCfg.img;
      const model = (v as any).sovitsWeightsPath || (v as any).gptWeightsPath
        ? `${(v as any).sovitsWeightsPath || '—'} / ${(v as any).gptWeightsPath || '—'}`
        : '未指定模型';
      const refFileName = (v as any).refAudioPath ? (v as any).refAudioPath.split(/[\\/]/).pop() : '';
      const meta = refFileName ? `${model}｜参考：${refFileName}` : model;
      const langLabel = PROMPT_LANG_MAP[(v as any).promptLang] || ((v as any).promptLang ? (v as any).promptLang.toUpperCase() : '中文');
      const emotionTag = (v as any).emotion && (v as any).emotion !== '通用'
        ? `<span class="local-voice-tag local-voice-emotion-tag" title="情绪风格：${(v as any).emotion}">${(v as any).emotion}</span>`
        : '';
      return `
        <div class="local-voice-item" data-voice-id="${v.id}">
          <img class="local-voice-avatar" src="${avatarImg}" alt="" title="${avatarCfg.label}" width="36" height="36">
          <div class="local-voice-info">
            <div class="local-voice-title-wrap">
              <span class="local-voice-name" title="${v.name || v.id}">${v.name || v.id}</span>
              <span class="local-voice-tag" title="参考音频语种：${langLabel}">${langLabel}</span>
              <span class="local-voice-tag" title="${avatarCfg.label}">${avatarCfg.label}</span>
              ${emotionTag}
            </div>
            <span class="local-voice-meta" title="${meta}">(${meta})</span>
          </div>
          <div class="local-voice-actions">
            <button class="local-voice-action-btn local-preview-btn" data-voice-id="${v.id}" title="试听 ${v.name || v.id}">试听</button>
            <button class="local-voice-action-btn local-edit-btn" data-voice-id="${v.id}" title="编辑">编辑</button>
            <button class="local-voice-action-btn btn-danger local-del-btn" data-voice-id="${v.id}" title="删除">删除</button>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.local-preview-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-voice-id');
        if (id) previewVoice(id);
      });
    });

    container.querySelectorAll('.local-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-voice-id');
        const target = voices.find(v => v.id === id);
        if (target) openVoiceEditor(target);
      });
    });

    container.querySelectorAll('.local-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-voice-id');
        const target = voices.find(v => v.id === id);
        if (!target) return;
        const ok = await showConfirmDialog({
          title: "删除本地音色",
          message: `确定删除本地音色「${target.name || target.id}」吗？`,
          detail: "删除后不可恢复，如需重新使用需再次添加。",
          confirmText: "删除",
          danger: true
        });
        if (!ok) return;
        const nextVoices = voices.filter(v => v.id !== id);
        const curSettings = await settingsStore.load();
        const nextLocal: LocalTtsSettings = {
          ...(curSettings.localTts || DEFAULT_LOCAL_TTS),
          serviceType: 'gpt-sovits',
          voices: nextVoices as any
        };
        await settingsStore.save({ localTts: nextLocal });
        renderLocalVoicesList();
        state.localVoices = await syncLocalVoices();
        updateVoiceTriggers();
        if (state.currentTab === 'voices') renderVoicesPage();
        showToast('已删除音色', 'success');
      });
    });
  });
}

// ─── 本地音色编辑弹窗 ───

function currentEditorModel(): ScannedModel | null {
  const sel = $("voiceModelSelect") as any;
  const idx = parseInt(sel?.value || "-1", 10);
  return idx >= 0 && idx < scannedModels.length ? scannedModels[idx] : null;
}

function fillWeightSelects() {
  const model = currentEditorModel();
  const gptSel = $("voiceGptSelect") as any;
  const sovitsSel = $("voiceSovitsSelect") as any;
  if (!gptSel || !sovitsSel) return;

  if (!model) {
    gptSel.innerHTML = '<option value="">未找到 GPT 权重</option>';
    sovitsSel.innerHTML = '<option value="">未找到 SoVITS 权重</option>';
    return;
  }

  gptSel.innerHTML = (model.gpt || []).map((w: any) => `<option value="${w.path}">${w.file}</option>`).join('')
    || '<option value="">无可用 GPT 权重</option>';
  sovitsSel.innerHTML = (model.sovits || []).map((w: any) => `<option value="${w.path}">${w.file}</option>`).join('')
    || '<option value="">无可用 SoVITS 权重</option>';
}

async function scanModelsIntoEditor() {
  const rootDir = ($("localRootDir") as any)?.value?.trim() || '';
  if (!rootDir) {
    showToast("请先在本地部署设置中指定整合包目录", "error");
    return;
  }
  const scanBtn = $("scanModelsBtn");
  if (scanBtn) scanBtn.textContent = '扫描中…';
  try {
    scannedModels = await engineScanModels(rootDir);
    const modelSel = $("voiceModelSelect") as any;
    if (modelSel) {
      if (!scannedModels.length) {
        modelSel.innerHTML = '<option value="-1">未扫描到模型权重</option>';
      } else {
        const customItems: { index: number; label: string }[] = [];
        const baseItems: { index: number; label: string }[] = [];
        scannedModels.forEach((m, i) => {
          const label = m.isBase
            ? m.name
            : `${m.name}（${m.version}${m.complete ? "" : " — 权重不完整"}）`;
          if (m.isBase) {
            baseItems.push({ index: i, label });
          } else {
            customItems.push({ index: i, label });
          }
        });

        let html = '';
        if (customItems.length && baseItems.length) {
          html += '<option disabled>── 已训练模型 ──</option>';
          html += customItems.map(item => `<option value="${item.index}">${escapeHtml(item.label)}</option>`).join('');
          html += '<option disabled>─── 官方通用底模，配合参考音频快速使用 ───</option>';
          html += baseItems.map(item => `<option value="${item.index}">${escapeHtml(item.label)}</option>`).join('');
        } else if (customItems.length) {
          html = customItems.map(item => `<option value="${item.index}">${escapeHtml(item.label)}</option>`).join('');
        } else if (baseItems.length) {
          html = '<option disabled>── 官方通用底模 ──</option>' +
            baseItems.map(item => `<option value="${item.index}">${escapeHtml(item.label)}</option>`).join('');
        }
        modelSel.innerHTML = html;
      }
    }
    fillWeightSelects();
    showToast(`已扫描到 ${scannedModels.length} 个模型`, "success");
  } catch (err: any) {
    showToast(`扫描失败：${err.message || err}`, "error");
  } finally {
    if (scanBtn) scanBtn.textContent = '扫描';
  }
}

function getVoiceEmotionUI(): string {
  const sel = $("voiceEmotionSelect") as any;
  if (sel?.value === '__custom__') {
    return ($("voiceEmotionCustom") as any)?.value?.trim() || '通用';
  }
  return sel?.value || '通用';
}

function setVoiceEmotionUI(emotion: string = '通用') {
  const sel = $("voiceEmotionSelect") as any;
  const customBox = $("voiceEmotionCustomBox");
  const customInput = $("voiceEmotionCustom") as any;
  if (!sel) return;

  const knownOptions = ['通用', '高兴', '悲伤', '愤怒', '温柔', '严肃', '激动', '低语', '冷淡', '讲故事'];
  if (knownOptions.includes(emotion)) {
    sel.value = emotion;
    sel.classList.remove('hidden');
    if (customBox) customBox.classList.add('hidden');
  } else {
    sel.value = '__custom__';
    sel.classList.add('hidden');
    if (customBox) customBox.classList.remove('hidden');
    if (customInput) customInput.value = emotion;
  }
}

async function openVoiceEditor(voice?: any) {
  const dialog = $("localVoiceEditorDialog") as any;
  if (!dialog) return;

  const rootDir = ($("localRootDir") as any)?.value?.trim() || '';
  if (!scannedModels.length && rootDir) {
    try {
      await scanModelsIntoEditor();
    } catch (_) { }
  }

  editingVoiceId = voice?.id || null;
  const nameInput = $("voiceName") as any;
  if (nameInput) nameInput.value = voice?.name || '';
  const refAudioInput = $("voiceRefAudio") as any;
  if (refAudioInput) refAudioInput.value = voice?.refAudioPath || '';
  const promptTextInput = $("voicePromptText") as any;
  if (promptTextInput) promptTextInput.value = voice?.promptText || '';
  const promptLangSel = $("voicePromptLang") as any;
  if (promptLangSel) promptLangSel.value = voice?.promptLang || 'zh';

  const avatarType = voice?.avatarType || (voice?.gender === 'Male' ? 'man' : 'woman');
  const avatarTypeSel = $("voiceAvatarType") as any;
  if (avatarTypeSel) avatarTypeSel.value = avatarType;
  const avatarPreview = $("voiceAvatarPreview") as any;
  if (avatarPreview) {
    const cfg = AVATAR_CONFIG[avatarType] || AVATAR_CONFIG.woman;
    avatarPreview.src = voice?.avatar || cfg.img;
  }
  setVoiceEmotionUI(voice?.emotion || '通用');

  let idx = voice
    ? scannedModels.findIndex(m => m.name === voice.modelName && m.version === voice.modelVersion)
    : 0;
  // 容错：如果上次保存未成功记入 modelName，尝试通过权重路径逆向查找匹配的模型
  if (voice && idx < 0 && (voice.gptWeightsPath || voice.sovitsWeightsPath)) {
    idx = scannedModels.findIndex(m =>
      (m.gpt || []).some((w: any) => w.path === voice.gptWeightsPath) ||
      (m.sovits || []).some((w: any) => w.path === voice.sovitsWeightsPath)
    );
  }
  if (idx < 0) idx = 0;

  const modelSel = $("voiceModelSelect") as any;
  if (modelSel && idx >= 0 && idx < scannedModels.length) {
    modelSel.value = String(idx);
  }
  fillWeightSelects();

  if (voice?.gptWeightsPath) {
    const gptSel = $("voiceGptSelect") as any;
    if (gptSel) gptSel.value = voice.gptWeightsPath;
  }
  if (voice?.sovitsWeightsPath) {
    const sovitsSel = $("voiceSovitsSelect") as any;
    if (sovitsSel) sovitsSel.value = voice.sovitsWeightsPath;
  }

  // 若已有参考音频但参考文本为空，自动尝试从整合包 2-name2text.txt 回填
  if (!voice?.promptText && voice?.refAudioPath && rootDir) {
    const model = currentEditorModel();
    if (model?.name) {
      try {
        const autoText = await engineLookupPromptText({
          rootDir,
          modelName: model.name,
          wavFileName: voice.refAudioPath
        });
        if (autoText && promptTextInput && !promptTextInput.value.trim()) {
          promptTextInput.value = autoText;
          const hint = $("refAudioHint");
          if (hint) hint.textContent = '已自动从切片日志填入参考文本，请确认无误。';
        }
      } catch (_) { }
    }
  }

  if (typeof dialog.uxpShowModal === 'function') {
    await dialog.uxpShowModal({
      title: voice ? '编辑音色' : '新增音色',
      resize: 'both',
      size: { width: 580, height: 540 }
    });
  } else if (typeof dialog.showModal === 'function') {
    dialog.showModal();
  }
}

function closeVoiceEditor() {
  editingVoiceId = null;
  const dialog = $("localVoiceEditorDialog") as any;
  if (dialog && typeof dialog.close === 'function') {
    dialog.close();
  }
}

async function saveVoiceFromEditor() {
  const name = ($("voiceName") as any)?.value?.trim();
  if (!name) return showToast('请填写音色名称', 'error');

  const gptWeightsPath = ($("voiceGptSelect") as any)?.value || '';
  const sovitsWeightsPath = ($("voiceSovitsSelect") as any)?.value || '';
  if (!gptWeightsPath || !sovitsWeightsPath) {
    return showToast('请完整选择 GPT 与 SoVITS 权重（缺一方无法推理）', 'error');
  }

  const refAudioPath = ($("voiceRefAudio") as any)?.value?.trim();
  if (!refAudioPath) return showToast('请选择参考音频（建议 3~10 秒）', 'error');

  const targetVoiceId = editingVoiceId || `local_${Date.now().toString(36)}`;

  const avatarType = ($("voiceAvatarType") as any)?.value || 'woman';
  const avatarCfg = AVATAR_CONFIG[avatarType] || AVATAR_CONFIG.woman;
  const emotion = getVoiceEmotionUI();
  const model = currentEditorModel();
  const payload = {
    name,
    avatarType,
    emotion,
    gender: avatarCfg.gender,
    avatar: avatarCfg.img,
    modelName: model?.name || '',
    modelVersion: model?.version || '',
    gptWeightsPath,
    sovitsWeightsPath,
    refAudioPath,
    promptText: ($("voicePromptText") as any)?.value?.trim() || '',
    promptLang: ($("voicePromptLang") as any)?.value || 'zh'
  };

  const settings = await settingsStore.load();
  const voices = settings.localTts?.voices || [];
  if (editingVoiceId) {
    const target = voices.find(v => v.id === editingVoiceId);
    if (target) Object.assign(target, payload);
  } else {
    voices.push({ id: targetVoiceId, ...payload });
  }

  const localTts: LocalTtsSettings = {
    ...(settings.localTts || DEFAULT_LOCAL_TTS),
    serviceType: 'gpt-sovits',
    voices: voices as any
  };

  await settingsStore.save({ localTts });
  renderLocalVoicesList();
  state.localVoices = await syncLocalVoices();
  updateVoiceTriggers();
  if (state.currentTab === 'voices') renderVoicesPage();
  closeVoiceEditor();
  showToast('音色已保存', 'success');
}

function bindLocalTtsEvents() {
  // 浏览整合包目录
  $("browseRootDir")?.addEventListener('click', async () => {
    try {
      const folder = await (uxp.storage.localFileSystem as any).getFolder();
      if (folder && folder.nativePath) {
        const rootDirInput = $("localRootDir") as any;
        if (rootDirInput) rootDirInput.value = folder.nativePath;
        detectLocalEngine(folder.nativePath);
      }
    } catch (e: any) {
      console.warn('[browseRootDir] 取消或失败:', e);
    }
  });

  // 模式切换
  $("localModeSelect")?.addEventListener('change', () => {
    applyLocalModeVisibility();
  });

  // 启动本地服务
  $("engineStartBtn")?.addEventListener('click', async () => {
    const rootDir = ($("localRootDir") as any)?.value?.trim() || '';
    if (!rootDir) {
      showToast("请先选择 GPT-SoVITS 整合包目录", "error");
      return;
    }
    const port = parseInt(($("localPort") as any)?.value || '9880', 10);
    const startBtn = $("engineStartBtn") as any;
    if (startBtn) startBtn.setAttribute('disabled', 'true');
    lastEngineInfo.state = 'starting';
    lastEngineInfo.port = port;
    updateLocalHeaderStatus();
    showToast("正在启动本地服务...", "info");

    try {
      // 先探测端口是否已经在运行
      const probe = await probeGptSoVits(`http://127.0.0.1:${port}`);
      if (probe.ok && probe.ready) {
        lastEngineInfo.running = true;
        lastEngineInfo.state = 'running';
        updateLocalHeaderStatus();
        showToast("本地服务已就绪（复用已有实例）", "success");
        if (startBtn) startBtn.removeAttribute('disabled');
        return;
      }

      // 未运行则拉起脚本
      const launchRes = await launchGptSoVitsService({ rootDir, port });
      if (launchRes.status === 'reused') {
        lastEngineInfo.running = true;
        lastEngineInfo.state = 'running';
        updateLocalHeaderStatus();
        showToast("本地服务已就绪（复用已有实例）", "success");
        return;
      }

      if ((launchRes as any).manualBat) {
        showToast("已在整合包目录生成「momo_start_api_v2.bat」并打开文件夹，请双击运行它，插件正在等待连接...", "info");
      } else {
        showToast("已唤起启动脚本，正在等待本地服务初始化就绪...", "info");
      }

      // 启动轮询检查服务是否就绪（最多45秒）
      let attempts = 0;
      if (enginePollTimer) clearInterval(enginePollTimer);
      enginePollTimer = setInterval(async () => {
        attempts++;
        try {
          const p = await probeGptSoVits(`http://127.0.0.1:${port}`);
          if (p.ok && p.ready) {
            clearInterval(enginePollTimer);
            enginePollTimer = null;
            lastEngineInfo.running = true;
            lastEngineInfo.state = 'running';
            updateLocalHeaderStatus();
            showToast("本地 GPT-SoVITS 服务已就绪", "success");
            return;
          }
        } catch (_) { }

        if (attempts >= 25) {
          clearInterval(enginePollTimer);
          enginePollTimer = null;
          lastEngineInfo.state = 'error';
          lastEngineInfo.errorMsg = '服务启动超时，请检查控制台窗口输出';
          updateLocalHeaderStatus();
          showToast("服务启动超时，请在弹出的命令行窗口中查看报错", "error");
        }
      }, 2000);

    } catch (err: any) {
      lastEngineInfo.state = 'error';
      lastEngineInfo.errorMsg = err.message || String(err);
      updateLocalHeaderStatus();
      showToast(`启动服务出错：${err.message || err}`, "error");
    }
  });

  // 停止服务按钮
  $("engineStopBtn")?.addEventListener('click', async () => {
    await showConfirmDialog({
      title: '停止本地服务',
      message: 'GPT-SoVITS 正在外部独立命令行窗口中运行。',
      detail: '插件无法直接关闭外部控制台窗口。请在系统任务栏关闭黑色的命令行窗口，关闭后插件会自动更新状态。',
      confirmText: '我知道了',
      width: 420,
      height: 280,
      hideCancel: true
    });

    lastEngineInfo.state = 'stopping';
    updateLocalHeaderStatus();

    let checkCount = 0;
    const stopCheckTimer = setInterval(async () => {
      checkCount++;
      const port = parseInt(($("localPort") as any)?.value || '9880', 10);
      try {
        const p = await probeGptSoVits({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 1000 });
        if (!p.ok || !p.ready) {
          clearInterval(stopCheckTimer);
          lastEngineInfo.running = false;
          lastEngineInfo.state = 'stopped';
          updateLocalHeaderStatus();
          showToast("本地服务已停止", "success");
          return;
        }
      } catch (_) {
        clearInterval(stopCheckTimer);
        lastEngineInfo.running = false;
        lastEngineInfo.state = 'stopped';
        updateLocalHeaderStatus();
        showToast("本地服务已停止", "success");
        return;
      }
      if (checkCount >= 10) {
        clearInterval(stopCheckTimer);
        await checkLocalServiceStatus(true);
      }
    }, 2000);
  });

  // URL 模式下测试连接
  $("testLocalConn")?.addEventListener('click', async () => {
    const rawUrl = ($("localBaseUrl") as any)?.value?.trim() || '';
    if (!rawUrl) {
      showToast("请输入服务地址（URL）", "error");
      return;
    }
    const testBtn = $("testLocalConn") as any;
    if (testBtn) testBtn.setAttribute('disabled', 'true');
    lastUrlConnState = 'testing';
    updateLocalHeaderStatus();
    showToast("正在测试与 GPT-SoVITS 服务连接...", "info");

    try {
      const probe = await probeGptSoVits(rawUrl);
      if (probe.ok && probe.ready) {
        lastUrlConnState = 'connected';
        updateLocalHeaderStatus();
        showToast("连接成功，GPT-SoVITS 服务正常响应", "success");
      } else {
        lastUrlConnState = 'error';
        updateLocalHeaderStatus();
        showToast(`连接失败：${probe.error || '服务未就绪'}`, "error");
      }
    } catch (e: any) {
      lastUrlConnState = 'error';
      updateLocalHeaderStatus();
      showToast(`连接失败：${e.message || e}`, "error");
    } finally {
      if (testBtn) testBtn.removeAttribute('disabled');
    }
  });

  // 保存本地部署设置
  $("saveLocalSettingsBtn")?.addEventListener('click', () => {
    saveLocalSettings();
  });

  // 通道启用按钮点击
  document.querySelectorAll('.channel-enable-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const channel = btn.getAttribute('data-enable-channel') as 'azure' | 'cloud' | 'local';
      if (!channel) return;
      await settingsStore.save({ activeChannel: channel });
      await updateChannelEnableButtons();
      try {
        if (channel === 'local') {
          state.localVoices = await syncLocalVoices();
        } else {
          state.voices = await ttsProvider.listVoices();
        }
        updateVoiceTriggers();
        if (state.currentTab === 'voices') renderVoicesPage();
        const chName = channel === 'local' ? '本地部署' : (channel === 'cloud' ? '云端会员' : '自填 Key');
        showToast(`已切换至「${chName}」通道`, "success");
      } catch (err: any) {
        showToast(`切换通道成功，但刷新音色失败：${err.message || err}`, "error");
      }
    });
  });

  // 打开新增音色弹窗（兼容 addLocalVoiceBtn 与 openAddLocalVoiceBtn）
  $("addLocalVoiceBtn")?.addEventListener('click', () => {
    openVoiceEditor(null);
  });
  $("openAddLocalVoiceBtn")?.addEventListener('click', () => {
    openVoiceEditor(null);
  });

  // 弹窗内部事件
  $("scanModelsBtn")?.addEventListener('click', () => scanModelsIntoEditor());
  $("voiceModelSelect")?.addEventListener('change', async () => {
    fillWeightSelects();
    const promptInput = $("voicePromptText") as any;
    const refAudioInput = $("voiceRefAudio") as any;
    if (promptInput && !promptInput.value.trim() && refAudioInput?.value?.trim()) {
      const rootDir = ($("localRootDir") as any)?.value?.trim() || '';
      const model = currentEditorModel();
      if (rootDir && model?.name) {
        try {
          const text = await engineLookupPromptText({
            rootDir,
            modelName: model.name,
            wavFileName: refAudioInput.value.trim()
          });
          if (text) {
            promptInput.value = text;
            const hint = $("refAudioHint");
            if (hint) hint.textContent = '已自动填入该切片对应的文本，请确认无误。';
          }
        } catch (_) { }
      }
    }
  });
  $("voiceEditorCancel")?.addEventListener('click', closeVoiceEditor);
  $("voiceEditorSave")?.addEventListener('click', saveVoiceFromEditor);

  $("voiceEmotionSelect")?.addEventListener('change', (e: any) => {
    if (e.target.value === '__custom__') {
      e.target.classList.add('hidden');
      $("voiceEmotionCustomBox")?.classList.remove('hidden');
      ($("voiceEmotionCustom") as any)?.focus();
    }
  });

  $("voiceEmotionBackBtn")?.addEventListener('click', () => {
    $("voiceEmotionCustomBox")?.classList.add('hidden');
    $("voiceEmotionSelect")?.classList.remove('hidden');
    const sel = $("voiceEmotionSelect") as any;
    if (sel) sel.value = '通用';
  });

  $("voiceAvatarType")?.addEventListener('change', (e: any) => {
    const type = e.target.value;
    const cfg = AVATAR_CONFIG[type] || AVATAR_CONFIG.woman;
    const preview = $("voiceAvatarPreview") as any;
    if (preview) preview.src = cfg.img;
  });

  $("browseRefAudio")?.addEventListener('click', async () => {
    try {
      const file = await (uxp.storage.localFileSystem as any).getFileForOpening({
        types: ["wav", "mp3", "flac", "m4a", "ogg"]
      });
      if (file && file.nativePath) {
        const input = $("voiceRefAudio") as any;
        if (input) input.value = file.nativePath;

        // 自动查询 2-name2text.txt 回填切片文本
        const rootDir = ($("localRootDir") as any)?.value?.trim() || '';
        const model = currentEditorModel();
        if (rootDir && model?.name) {
          const text = await engineLookupPromptText({
            rootDir,
            modelName: model.name,
            wavFileName: file.nativePath
          });
          if (text) {
            const promptInput = $("voicePromptText") as any;
            if (promptInput) promptInput.value = text;
            const hint = $("refAudioHint");
            if (hint) hint.textContent = '已自动填入该切片对应的文本，请确认无误。';
          }
        }
      }
    } catch (e: any) {
      console.warn('[browseRefAudio] 取消或失败:', e);
    }
  });
}

// ─── 多音字字典管理 ───

/** 罗马数字（用于卡片读音序号） */
function romanNumber(num: number): string {
  const map = ["", "Ⅰ", "Ⅱ", "Ⅲ", "Ⅳ", "Ⅴ", "Ⅵ", "Ⅶ", "Ⅷ", "Ⅸ", "Ⅹ"];
  return map[num] || String(num);
}

/** 根据窗口宽度推断网格列数（与 CSS 配合，UXP 无 media query 故用 JS 判断） */
function getPolyGridCols(): number {
  const w = window.innerWidth;
  if (w <= 600) return 1;
  if (w <= 900) return 2;
  return 3;
}

/** 按汉字聚合字典条目 */
function groupPolyByChar(dict: any[]): Record<string, any[]> {
  const groups: Record<string, any[]> = {};
  for (const e of dict) {
    if (!e.char) continue;
    if (!groups[e.char]) groups[e.char] = [];
    groups[e.char].push(e);
  }
  return groups;
}

/** 渲染内置多音字字典（只读卡片，默认2行+展开） */
function renderBuiltinDictList() {
  const wrap = $("polyBuiltinWrap");
  if (!wrap) return;
  const searchTerm = (($("polyBuiltinSearch") as any)?.value || "").toLowerCase().trim();
  let dict = polyphonicBuiltin || [];
  if (searchTerm) {
    dict = dict.filter((e: any) =>
      (e.char || "").includes(searchTerm) || (e.pinyin || "").toLowerCase().includes(searchTerm)
    );
  }
  if (!dict.length) {
    wrap.innerHTML = '<div class="dict-empty-hint">暂无匹配的内置词条</div>';
    return;
  }

  const groups = groupPolyByChar(dict);
  const groupKeys = Object.keys(groups);
  const collapsedCount = getPolyGridCols() * 2; // 默认只显示 2 行
  const expanded = state.builtinPolyExpanded;
  const visibleKeys = expanded ? groupKeys : groupKeys.slice(0, collapsedCount);
  const hasMore = groupKeys.length > collapsedCount;

  let html = '<div class="poly-dict-grid">';
  for (const char of visibleKeys) {
    const entries = groups[char];
    html += `<div class="poly-dict-card poly-dict-card-builtin">`;
    html += `<div class="poly-card-header"><span class="poly-card-char">${escapeHtml(char)}</span><span class="poly-card-badge">内置</span></div>`;
    html += `<div class="poly-card-body">`;
    entries.forEach((e: any, idx: number) => {
      html += `<div class="poly-card-pinyin-row">`;
      html += `<span class="poly-card-index">${romanNumber(idx + 1)}</span>`;
      html += `<span class="poly-card-pinyin-val">${escapeHtml(e.pinyin)}<span class="poly-card-phonetic"> (${escapeHtml(e.phonetic)})</span></span>`;
      html += `<span class="poly-card-context-val">${escapeHtml(e.context || "")}</span>`;
      html += `</div>`;
    });
    html += `</div></div>`;
  }
  html += '</div>';

  if (hasMore) {
    html += `<div class="poly-dict-expand-bar"><sp-button variant="secondary" quiet size="s" class="poly-dict-expand-btn">${expanded ? "收起" : "展开全部"}（共 ${groupKeys.length} 个汉字）</sp-button></div>`;
  }

  wrap.innerHTML = html;

  const expandBtn = wrap.querySelector(".poly-dict-expand-btn") as any;
  if (expandBtn) {
    expandBtn.addEventListener("click", () => {
      state.builtinPolyExpanded = !state.builtinPolyExpanded;
      renderBuiltinDictList();
    });
  }
}

/** 渲染自定义多音字字典（可编辑卡片网格） */
function renderDictList(polyDict: any[]) {
  const wrap = $("dictListWrap");
  if (!wrap) return;

  const searchTerm = (($("polyDictSearch") as any)?.value || "").toLowerCase().trim();
  let dict = polyDict || [];
  if (searchTerm) {
    dict = dict.filter((e: any) =>
      (e.char || "").includes(searchTerm) || (e.pinyin || "").toLowerCase().includes(searchTerm)
    );
  }

  if (!dict.length) {
    wrap.innerHTML = '<div class="dict-empty-hint">暂无自定义词条，点击右上角「+ 添加词条」添加</div>';
    return;
  }

  const groups = groupPolyByChar(dict);
  let html = '<div class="poly-dict-grid">';
  for (const char of Object.keys(groups)) {
    const entries = groups[char];
    html += `<div class="poly-dict-card">`;
    html += `<div class="poly-card-header">`;
    html += `<span class="poly-card-char">${escapeHtml(char)}</span>`;
    html += `<div class="poly-card-actions">`;
    html += `<sp-button variant="secondary" quiet size="s" class="poly-dict-edit" data-char="${escapeHtml(char)}">✎</sp-button>`;
    html += `<sp-button variant="secondary" quiet size="s" class="poly-dict-del" data-char="${escapeHtml(char)}">✕</sp-button>`;
    html += `</div></div>`;
    html += `<div class="poly-card-body">`;
    entries.forEach((e: any, idx: number) => {
      html += `<div class="poly-card-pinyin-row">`;
      html += `<span class="poly-card-index">${romanNumber(idx + 1)}</span>`;
      html += `<span class="poly-card-pinyin-val">${escapeHtml(e.pinyin)}<span class="poly-card-phonetic"> (${escapeHtml(e.phonetic || "")})</span></span>`;
      html += `<span class="poly-card-context-val">${escapeHtml(e.context || "")}</span>`;
      html += `</div>`;
    });
    html += `</div></div>`;
  }
  html += '</div>';
  wrap.innerHTML = html;

  // 删除按钮：删除该汉字的所有读音
  wrap.querySelectorAll(".poly-dict-del").forEach(btn => {
    btn.addEventListener("click", async () => {
      const char = btn.getAttribute("data-char") || "";
      const settings = await settingsStore.load();
      let dict2 = settings.polyphonicDict || [];
      dict2 = dict2.filter((e: any) => e.char !== char);
      await settingsStore.save({ polyphonicDict: dict2 });
      showToast(`已删除「${char}」的全部读音`, "success");
      renderDictList(dict2);
    });
  });

  // 编辑按钮：打开弹窗编辑该汉字的读音
  wrap.querySelectorAll(".poly-dict-edit").forEach(btn => {
    btn.addEventListener("click", async () => {
      const char = btn.getAttribute("data-char") || "";
      const settings = await settingsStore.load();
      const dict2 = settings.polyphonicDict || [];
      const sameCharEntries = dict2.filter((e: any) => e.char === char);
      await showDictEntryDialog(char, sameCharEntries);
    });
  });
}

// ─── 选项卡切换 ───
document.querySelectorAll(".poly-dict-tab").forEach((tab: Element) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".poly-dict-tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".poly-dict-panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    const target = tab.getAttribute("data-poly-tab");
    const panel = document.querySelector(`.poly-dict-panel[data-poly-panel="${target}"]`);
    if (panel) panel.classList.add("active");
    // 切到内置面板时重新渲染（适配窗口列数）
    if (target === "builtin") renderBuiltinDictList();
    // 切到自定义面板时重新渲染（读取最新数据）
    if (target === "custom") {
      settingsStore.load().then(s => renderDictList(s.polyphonicDict || []));
    }
  });
});

// 搜索框实时过滤
($("polyBuiltinSearch") as any)?.addEventListener("input", () => renderBuiltinDictList());
($("polyDictSearch") as any)?.addEventListener("input", async () => {
  const s = await settingsStore.load();
  renderDictList(s.polyphonicDict || []);
});

// ─── 添加/编辑词条弹窗（1字多拼音） ───

/** 弹窗内当前编辑的拼音行数据 */
let dictEntryRows: { phonetic: string; context: string }[] = [];

/** 渲染弹窗内的拼音行列表 */
function renderDictEntryRows() {
  const container = $("dictEntryRows");
  if (!container) return;
  let html = "";
  dictEntryRows.forEach((row, idx) => {
    html += `<div class="dict-entry-row">`;
    html += `<input class="native-input dict-entry-row-pinyin" type="text" placeholder="拼音(如 hang2)" value="${escapeHtml(row.phonetic)}" data-row="${idx}" data-field="phonetic">`;
    html += `<input class="native-input dict-entry-row-context" type="text" placeholder="语境(可选 如 银行)" value="${escapeHtml(row.context)}" data-row="${idx}" data-field="context">`;
    html += `<sp-button variant="secondary" quiet size="s" class="dict-entry-row-del" data-row="${idx}">✕</sp-button>`;
    html += `</div>`;
  });
  container.innerHTML = html;

  // 绑定输入事件（实时更新 dictEntryRows）
  container.querySelectorAll("input.dict-entry-row-pinyin, input.dict-entry-row-context").forEach((tf: any) => {
    tf.addEventListener("input", (e: any) => {
      const rowIdx = parseInt(tf.getAttribute("data-row") || "0", 10);
      const field = tf.getAttribute("data-field");
      if (field && dictEntryRows[rowIdx]) {
        dictEntryRows[rowIdx][field as "phonetic" | "context"] = tf.value || "";
      }
    });
  });

  // 绑定删除行按钮
  container.querySelectorAll(".dict-entry-row-del").forEach((btn: any) => {
    btn.addEventListener("click", () => {
      const rowIdx = parseInt(btn.getAttribute("data-row") || "0", 10);
      dictEntryRows.splice(rowIdx, 1);
      if (dictEntryRows.length === 0) {
        dictEntryRows.push({ phonetic: "", context: "" });
      }
      renderDictEntryRows();
    });
  });
}

/**
 * 从拼音输入推导 SAPI phonetic。
 * 用户可输入 "hang2" 或 "hang 2" 或 "h ang 2"，统一归一化为带空格的 "hang 2" 格式。
 */
function derivePhonetic(input: string): string {
  let ph = (input || "").trim().toLowerCase();
  if (!ph) return "";
  // 去除所有空格后重新插入声调数字前的空格
  ph = ph.replace(/\s+/g, "");
  ph = ph.replace(/^([a-zü]+)([1-5])$/, "$1 $2");
  return ph;
}

/** 从 phonetic 推导显示用拼音（去掉空格和声调数字，带声调符号） */
function derivePinyinFromPhonetic(phonetic: string): string {
  const cleaned = (phonetic || "").toLowerCase().replace(/\s+/g, "");
  // 简单返回去空格的版本作为 pinyin 标识（与内置字典格式一致）
  const m = cleaned.match(/^([a-zü]+)([1-5])$/);
  if (!m) return cleaned;
  return cleaned;
}

/** 显示添加/编辑词条弹窗。editChar 传入时为编辑模式 */
async function showDictEntryDialog(editChar?: string, existingEntries?: any[]) {
  const dialog = $("dictEntryDialog") as any;
  const charInput = $("dictEntryChar") as any;
  if (!dialog) return;

  if (editChar && existingEntries) {
    if (charInput) {
      charInput.value = editChar;
      charInput.setAttribute("readonly", "true");
    }
    dictEntryRows = existingEntries.map(e => {
      const ph = (e.phonetic || "").trim();
      const formattedPh = ph.replace(/([a-zü]+)([1-5])/, "$1 $2").trim();
      return { phonetic: formattedPh, context: e.context || "" };
    });
    if (dictEntryRows.length === 0) {
      dictEntryRows = [{ phonetic: "", context: "" }];
    }
  } else {
    if (charInput) {
      charInput.value = "";
      charInput.removeAttribute("readonly");
    }
    dictEntryRows = [{ phonetic: "", context: "" }];
  }
  renderDictEntryRows();

  // 添加读音行按钮
  const addRowBtn = $("dictEntryAddRow") as any;
  if (addRowBtn) {
    if (addRowBtn._clickHandler) {
      addRowBtn.removeEventListener("click", addRowBtn._clickHandler);
    }
    const handler = () => {
      dictEntryRows.push({ phonetic: "", context: "" });
      renderDictEntryRows();
    };
    addRowBtn._clickHandler = handler;
    addRowBtn.addEventListener("click", handler);
  }

  // 取消按钮
  const cancelBtn = $("dictEntryCancel") as any;
  if (cancelBtn) {
    if (cancelBtn._clickHandler) {
      cancelBtn.removeEventListener("click", cancelBtn._clickHandler);
    }
    const handler = () => dialog.close("cancel");
    cancelBtn._clickHandler = handler;
    cancelBtn.addEventListener("click", handler);
  }

  // 保存按钮
  const saveBtn = $("dictEntrySave") as any;
  if (saveBtn) {
    if (saveBtn._clickHandler) {
      saveBtn.removeEventListener("click", saveBtn._clickHandler);
    }
    const handler = async () => {
      const char = (charInput?.value || "").trim();
      if (!char) {
        showToast("请填写汉字", "error");
        return;
      }
      const validRows = dictEntryRows.filter(r => (r.phonetic || "").trim());
      if (!validRows.length) {
        showToast("请至少填写一个拼音", "error");
        return;
      }

      // 校验拼音格式并生成条目
      const entries: any[] = [];
      for (const row of validRows) {
        const cleaned = (row.phonetic || "").trim().replace(/\s+/g, "").toLowerCase();
        if (!/^([a-zü]+)[1-5]$/.test(cleaned)) {
          showToast(`拼音「${row.phonetic}」格式有误，应为字母+声调数字（如 hang2）`, "error");
          return;
        }
        const phonetic = derivePhonetic(row.phonetic);
        const pinyin = derivePinyinFromPhonetic(phonetic);
        entries.push({ char, pinyin, phonetic, context: (row.context || "").trim() });
      }

      const settings = await settingsStore.load();
      let dict = settings.polyphonicDict || [];
      // 编辑模式或添加模式：先清除该汉字的原有读音，再追加新条目（全量覆盖）
      dict = dict.filter((e: any) => e.char !== char);
      dict.push(...entries);
      await settingsStore.save({ polyphonicDict: dict });

      showToast(`已保存「${char}」的 ${entries.length} 个读音`, "success");
      renderDictList(dict);
      dialog.close("save");
    };
    saveBtn._clickHandler = handler;
    saveBtn.addEventListener("click", handler);
  }

  await dialog.uxpShowModal({
    title: editChar ? `编辑「${editChar}」` : "添加词条",
    resize: "none",
    size: { width: 460, height: 380 }
  });
}

// 添加词条按钮 → 打开弹窗（新增模式）
$("dictAddBtn")?.addEventListener("click", () => {
  showDictEntryDialog();
});

// 导出自定义多音字词典（格式与 DR 版互通）
$("exportDictBtn")?.addEventListener("click", async () => {
  try {
    const settings = await settingsStore.load();
    const dict = settings.polyphonicDict || [];
    if (!dict.length) {
      showToast("当前没有自定义词条可导出", "info");
      return;
    }
    // 使用电脑本地时间生成文件名：momovoicesub-polyphonic-dict-YYYYMMDD-HHmmss.json
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    // @ts-ignore
    const file = await uxp.storage.localFileSystem.getFileForSaving(
      `momovoicesub-polyphonic-dict-${timestamp}.json`,
      { types: ["json"] }
    );
    if (!file) return;
    const payload = {
      type: "momovoicesub-polyphonic-dict",
      version: 1,
      exportedAt: new Date().toISOString(),
      entries: dict
    };
    await file.write(JSON.stringify(payload, null, 2), { format: uxp.storage.formats.utf8 });
    showToast(`已导出 ${dict.length} 条自定义词条`, "success");
  } catch (err: any) {
    console.error("[Momo] 导出自定义多音字词典失败:", err);
    showToast(err?.message || "导出失败", "error");
  }
});

// 导入自定义多音字词典（兼容 DR/PR 版导出的格式）
$("importDictBtn")?.addEventListener("click", async () => {
  try {
    // @ts-ignore
    const file = await uxp.storage.localFileSystem.getFileForOpening({
      types: ["json"]
    });
    if (!file || !file.isFile) return;
    const content = await file.read({ format: uxp.storage.formats.utf8 });
    let data: any;
    try {
      data = JSON.parse(content);
    } catch (err) {
      showToast("导入文件不是有效的 JSON 格式", "error");
      return;
    }
    const imported = (Array.isArray(data) ? data : (data && Array.isArray(data.entries) ? data.entries : []))
      .filter((e: any) => e && e.char && (e.phonetic || e.pinyin));
    if (!imported.length) {
      showToast("导入文件中没有有效的词条", "info");
      return;
    }
    const confirmed = await showConfirmDialog({
      title: "导入多音字词典",
      message: `将导入 ${imported.length} 条词条（涉及 ${new Set(imported.map((e: any) => e.char)).size} 个字）`,
      detail: "相同汉字的读音将被导入内容覆盖，其余保留。是否继续？",
      confirmText: "确认导入"
    });
    if (!confirmed) return;

    // 合并：导入词条中出现的 char 覆盖本机对应条目，其余保留
    const settings = await settingsStore.load();
    let dict = settings.polyphonicDict || [];
    const importedChars = new Set(imported.map((e: any) => e.char));
    dict = dict.filter((e: any) => !importedChars.has(e.char));
    dict.push(...imported);
    await settingsStore.save({ polyphonicDict: dict });
    showToast(`已导入 ${imported.length} 条自定义词条`, "success");
    renderDictList(dict);
  } catch (err: any) {
    console.error("[Momo] 导入自定义多音字词典失败:", err);
    showToast(err?.message || "导入失败", "error");
  }
});

// ─── 字幕读取与载入 ───
$("subtitleTrackDropdown")?.addEventListener("change", async (e: any) => {
  const val = parseInt(e.target.value, 10);
  const prevIndex = state.activeCaptionTrackIndex;
  if (isNaN(val) || prevIndex === val) return;

  // 从手动模式切走到字幕轨：备份当前手动导入的 SRT，以便切回时恢复
  if (prevIndex === -1 && val !== -1) {
    state.manualSrtItemsBackup = state.subtitleItems.slice();
  }

  state.activeCaptionTrackIndex = val;
  // 切换字幕轨后 id 会重新分配，旧的连读分组已失效
  state.linkedIds = new Set<number>();
  updateImportSrtBtnVisibility();
  if (val === -1) {
    // 切回手动模式：恢复之前备份的 SRT（若有），而非清空
    state.subtitleItems = state.manualSrtItemsBackup.slice();
    renderSubtitleList();
    if (state.subtitleItems.length > 0) {
      showToast(`已切换到手动 SRT 模式，恢复 ${state.subtitleItems.length} 条字幕`, "info");
    } else {
      showToast("已切换到手动 SRT 模式，可导入SRT 开始", "info");
    }
    return;
  }

  showToast("正在读取字幕轨...", "info");
  try {
    // 保存项目，确保读取 .prproj 时拿到最新内容
    try {
      await premiereAdapter.saveProject();
    } catch (saveErr) {
      console.warn("[Momo] 下拉切换: 保存项目失败，仍尝试读取:", saveErr);
    }
    const items = await premiereAdapter.loadSubtitlesFromTrack(val, state.fps);
    // 保留用户已设置的标注（多音字纠音、停顿标记），根据 id 匹配
    mergeSubtitleAnnotations(state.subtitleItems, items);
    state.subtitleItems = items;
    renderSubtitleList();
    const textCount = items.filter(i => i.text && i.text.trim()).length;
    if (textCount === 0 && items.length > 0) {
      showToast(`已解析到 ${items.length} 条字幕时序，但未能提取文字，请导入 SRT 补全`, "warning");
    } else {
      showToast(`成功解析到 ${items.length} 条字幕${textCount > 0 ? `（含 ${textCount} 条文字）` : ""}`, "success");
    }
  } catch (err) {
    console.error(err);
    showToast("自动提取字幕失败，请检查轨道是否存在或尝试导入外部 SRT", "error");
  }
});

$("subtitleImportSrtBtn")?.addEventListener("click", async () => {
  const btn = $("subtitleImportSrtBtn") as any;
  const originalText = btn ? btn.textContent : '导入SRT';
  try {
    // 点击后立刻显示导入中状态，用户选完文件关闭窗口后能第一时间看到
    if (btn) {
      btn.setAttribute('disabled', 'true');
      btn.textContent = '⏳ 导入中...';
    }

    // @ts-ignore
    const file = await uxp.storage.localFileSystem.getFileForOpening({
      types: ["srt"]
    });

    if (file && file.isFile) {
      const content = await file.read({ format: uxp.storage.formats.utf8 });
      const srtItems = premiereAdapter.parseSrt(content);

      // 如果已有从字幕轨读取的时序数据（有时间位置但文字为空），则按时间匹配合并
      if (state.subtitleItems.length > 0 && state.activeCaptionTrackIndex >= 0) {
        const merged = premiereAdapter.mergeSrtWithExisting(state.subtitleItems, srtItems);
        const textCount = merged.filter(i => i.text && i.text.trim()).length;
        state.subtitleItems = merged;
        renderSubtitleList();
        showToast(`SRT 导入成功！已匹配 ${textCount}/${merged.length} 条字幕文字`, "success");
      } else {
        // 没有已读取的时序数据，直接使用 SRT 内容
        state.subtitleItems = srtItems;
        renderSubtitleList();
        showToast(`SRT 导入成功！共 ${srtItems.length} 条字幕`, "success");
      }

      // 导入后切换到手动模式（-1），下拉选中「无字幕轨(手动SRT模式)」
      state.activeCaptionTrackIndex = -1;
      state.manualSrtItemsBackup = state.subtitleItems.slice();
      // 新导入的字幕 id 与之前不同，清空连读分组
      state.linkedIds = new Set<number>();
      const subtitleDropdown = $("subtitleTrackDropdown") as any;
      if (subtitleDropdown) setPickerValue(subtitleDropdown, "-1");
      updateImportSrtBtnVisibility();
    }
  } catch (err: any) {
    console.error("[importSrt] 失败:", err);
    showToast(`导入 SRT 失败：${err.message || err}`, "error");
  } finally {
    if (btn) {
      btn.removeAttribute('disabled');
      btn.textContent = originalText;
    }
  }
});

function setDisableAllBtnLabel(allDisabled: boolean) {
  const btn = $("subtitleDisableAllBtn");
  if (!btn) return;
  // 列表重渲染后默认全勾选，文案复位为「全部禁用」
  btn.textContent = allDisabled ? "全部启用" : "全部禁用";
}

function renderSubtitleList() {
  const wrap = $("subtitleListWrap");
  if (!wrap) return;

  if (state.subtitleItems.length === 0) {
    wrap.innerHTML = '<div class="list-placeholder">请选择上方字幕轨或导入SRT 开始配音</div>';
    setDisableAllBtnLabel(false);
    updateClearLinkBtn();
    return;
  }

  let html = "";
  state.subtitleItems.forEach((item, idx) => {
    // item.text 为带标注的底层文本，文本框只显示其 cleanText
    const { cleanText } = parseAnnotations(item.text || "");
    const displayText = cleanText;
    const showPreview = hasAnnotations(item.text || "");
    const previewHtml = showPreview ? highlightText(item.text || "") : "";
    // 连读按钮：第一行没有"上一句"可连
    // UXP 对原生 <button> 的 click 事件不可靠（见 CLAUDE.md），统一用 div + role/tabindex + mousedown 阻止抢焦点
    const linkCell = idx > 0
      ? `<div class="sub-link-btn" role="button" tabindex="0" data-id="${item.id}" title="点击与上一句连读：合并为一句话配音，语气更连贯">🔗</div>`
      : `<span class="sub-link-placeholder"></span>`;
    html += `
      <div class="sub-item-row" id="sub-row-${item.id}">
        <div class="sub-link-bar"></div>
        <div class="sub-col-link">${linkCell}</div>
        <span class="sub-col-idx">${item.id}</span>
        <span class="sub-col-check">
          <sp-checkbox class="sub-row-checkbox" data-id="${item.id}" checked></sp-checkbox>
        </span>
        <div class="sub-col-text-area">
          <input class="sub-edit-input" type="text" data-id="${item.id}" value="${escapeHtml(displayText)}" placeholder="请输入字幕文字..." />
          <div class="sub-preview ${showPreview ? '' : 'hidden'}" data-id="${item.id}">${previewHtml}</div>
        </div>
        <span class="sub-col-time">${item.start.toFixed(2)}s ~ ${item.end.toFixed(2)}s</span>
      </div>
    `;
  });
  wrap.innerHTML = html;
  // 渲染后所有 checkbox 默认 checked，按钮文案复位
  setDisableAllBtnLabel(false);

  // 连读按钮：切换本行是否与上一行合并为同一句话
  // UXP 不允许原生 button + 直接监听 click（事件不可靠），用 div + mousedown preventDefault
  wrap.querySelectorAll(".sub-link-btn").forEach(btn => {
    const btnEl = btn as any;
    const toggle = () => {
      if (btnEl.getAttribute("aria-disabled") === "true") return;
      const id = parseInt(btnEl.getAttribute("data-id") || "0", 10);
      if (state.linkedIds.has(id)) state.linkedIds.delete(id);
      else state.linkedIds.add(id);
      refreshLinkGroupVisuals();
    };
    btnEl.addEventListener("mousedown", (e: any) => { e.preventDefault(); });
    btnEl.addEventListener("click", (e: any) => { e.preventDefault(); toggle(); });
    btnEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
  });

  // 勾选状态变化会影响连读分组的边界，实时刷新分组视觉
  wrap.querySelectorAll(".sub-row-checkbox").forEach(cb => {
    (cb as any).addEventListener("change", () => refreshLinkGroupVisuals());
  });

  bindSubtitleEditInputs(wrap);
  refreshLinkGroupVisuals();
}

// 连读分组左侧色条 class：颜色定义在 CSS，JS 只切换 class（UXP 对 inline style 的
// borderLeftColor 赋值不可靠，且不支持 transparent 关键字）。同组同色、相邻组异色，按组序号轮换。
const LINK_GROUP_CLASSES = ["link-group-0", "link-group-1", "link-group-2", "link-group-3", "link-group-4"];

/**
 * 依据「当前勾选状态 + 连读标记」刷新每行的分组视觉（左侧色条、按钮高亮）。
 * 不重建 DOM，避免打断用户输入。
 */
function refreshLinkGroupVisuals() {
  const items = state.subtitleItems;
  if (!items.length) return;

  // 读取当前勾选状态。
  // sp-checkbox 是自定义元素，innerHTML 赋值后尚未升级时 .checked 为 undefined；
  // 此时回退读 checked 属性（渲染时统一带 checked），否则勾选集合会空导致分组判定全部失效。
  const checked = new Set<number>();
  document.querySelectorAll(".sub-row-checkbox").forEach((c: any) => {
    const isChecked = typeof c.checked === "boolean" ? c.checked : c.hasAttribute("checked");
    if (isChecked) checked.add(parseInt(c.getAttribute("data-id") || "0", 10));
  });

  // prevLinked(i)：第 i 行与第 i-1 行连读（二者都必须已勾选）
  const prevLinked = (i: number) => i > 0
    && checked.has(items[i].id)
    && checked.has(items[i - 1].id)
    && state.linkedIds.has(items[i].id);

  let groupStart = 0;
  let groupIdx = 0;
  for (let i = 0; i < items.length; i++) {
    const nextLinked = (i + 1 < items.length) && prevLinked(i + 1);
    if (nextLinked) continue;

    const size = i - groupStart + 1;
    // 组色 class：仅连读组（size>1）占用一个颜色位，保证相邻连读组颜色必然不同
    const groupCls = size > 1
      ? LINK_GROUP_CLASSES[groupIdx % LINK_GROUP_CLASSES.length]
      : "";
    for (let j = groupStart; j <= i; j++) {
      const row = $(`sub-row-${items[j].id}`);
      if (!row) continue;
      // 先清掉所有色条 class 再按组添加（UXP 不认 inline style，只能切 class）
      row.classList.remove("link-group-0", "link-group-1", "link-group-2", "link-group-3", "link-group-4");
      if (groupCls) row.classList.add(groupCls);
      const btn = row.querySelector(".sub-link-btn") as any;
      if (!btn) continue;
      const linked = prevLinked(j);
      const prevChecked = j > 0 && checked.has(items[j - 1].id);
      btn.classList.toggle("is-linked", linked);
      btn.classList.toggle("is-disabled", !prevChecked);
      btn.tabIndex = prevChecked ? 0 : -1;
      btn.setAttribute("aria-disabled", prevChecked ? "false" : "true");
      btn.title = !prevChecked
        ? "上一行未勾选，无法连读"
        : (linked ? "已与上一句连读，点击断开" : "点击与上一句连读：合并为一句话配音，语气更连贯");
    }
    if (size > 1) groupIdx++;
    groupStart = i + 1;
  }

  updateClearLinkBtn();
}

/** 「清除连读」按钮：仅在存在连读分组时可用，并回显当前分组数 */
function updateClearLinkBtn() {
  const btn = $("subtitleClearLinkBtn") as any;
  if (!btn) return;
  const groupCount = countLinkedGroups();
  if (groupCount > 0) {
    btn.disabled = false;
    btn.textContent = `清除连读(${groupCount})`;
    btn.title = `当前有 ${groupCount} 组连读，点击全部取消`;
  } else {
    btn.disabled = true;
    btn.textContent = "清除连读";
    btn.title = "当前没有连读分组。点击行首的 🔗 可把相邻字幕合并为一整句配音";
  }
}

/** 清除所有连读分组 */
function clearAllSubtitleLinks() {
  if (!state.linkedIds.size) return;
  state.linkedIds = new Set<number>();
  refreshLinkGroupVisuals();
  showToast("已清除所有连读分组", "success");
}

/** 绑定字幕文本框的选区追踪与编辑回写（在 renderSubtitleList 中调用） */
function bindSubtitleEditInputs(wrap: any) {
  wrap.querySelectorAll(".sub-edit-input").forEach((input: any) => {
    const inputEl = input as any;

    // 聚焦时记录当前字幕 id，供「设定停顿/单字纠音」按钮使用
    inputEl.addEventListener("focus", () => {
      const id = parseInt(inputEl.getAttribute("data-id") || "0", 10);
      state.lastFocusedSubtitleId = id;
      recordSubtitleSelection(inputEl);
    });

    // 键盘输入/鼠标点击/拖选时实时记录选区位置
    inputEl.addEventListener("keyup", () => recordSubtitleSelection(inputEl));
    inputEl.addEventListener("click", () => recordSubtitleSelection(inputEl));
    inputEl.addEventListener("select", () => recordSubtitleSelection(inputEl));
    inputEl.addEventListener("blur", () => recordSubtitleSelection(inputEl));

    // 用户编辑文本框后，用 syncAnnotatedText 保留旧标注，写回 item.text
    inputEl.addEventListener("change", (e: any) => {
      const id = parseInt(inputEl.getAttribute("data-id") || "0", 10);
      const item = state.subtitleItems.find(s => s.id === id);
      if (item) {
        const newPlain = e.target.value || "";
        // 将用户输入的干净文字与旧标注合并
        item.text = syncAnnotatedText(item.text || "", newPlain);
        // 更新预览层
        updateSubtitlePreview(id);
      }
    });

    // input 事件：实时更新预览（边打字边看到标注变化）
    inputEl.addEventListener("input", (e: any) => {
      const id = parseInt(inputEl.getAttribute("data-id") || "0", 10);
      const item = state.subtitleItems.find(s => s.id === id);
      if (item) {
        const newPlain = e.target.value || "";
        item.text = syncAnnotatedText(item.text || "", newPlain);
        updateSubtitlePreview(id);
      }
    });
  });
}

/** 更新单条字幕的预览层显示 */
function updateSubtitlePreview(id: number) {
  const item = state.subtitleItems.find(s => s.id === id);
  if (!item) return;
  const previewEl = document.querySelector(`.sub-preview[data-id="${id}"]`) as any;
  if (!previewEl) return;
  const show = hasAnnotations(item.text || "");
  if (show) {
    previewEl.innerHTML = highlightText(item.text || "");
    previewEl.classList.remove("hidden");
  } else {
    previewEl.innerHTML = "";
    previewEl.classList.add("hidden");
  }
}

/**
 * 更新手动配音的效果预览层。
 * 从 state.manualTextWithAnnotations 读取带标注文本，
 * 有标注时显示预览层（含多音字纠音与停顿标记），无标注时隐藏。
 */
function updateManualHighlighter() {
  const ta = $("manualText") as any;
  const hl = $("manualTextHighlight") as any;
  const title = $("manualPreviewTitle") as any;
  if (!ta || !hl) return;

  const annotated = state.manualTextWithAnnotations || "";
  const show = hasAnnotations(annotated);

  if (show) {
    const highlighted = highlightText(annotated);
    hl.innerHTML = highlighted + (highlighted.endsWith("\n") ? " " : "");
    hl.classList.remove("hidden");
    if (title) title.classList.remove("hidden");
  } else {
    hl.innerHTML = "";
    hl.classList.add("hidden");
    if (title) title.classList.add("hidden");
  }
}

/**
 * 程序化回写 textarea value 的辅助：赋值会重置光标（UXP 下还受 IME 状态影响，
 * 表现为光标跳位），因此先记录 selectionStart/End，赋值后恢复。
 */
function writeTextareaValue(ta: any, value: string) {
  let start = -1;
  let end = -1;
  const wasFocused = document.activeElement === ta;
  if (wasFocused) {
    try {
      start = ta.selectionStart;
      end = ta.selectionEnd;
    } catch (_) { /* 不支持 selection 的元素直接整体赋值 */ }
  }
  ta.value = value;
  if (wasFocused && typeof start === "number" && start >= 0 && typeof end === "number") {
    try {
      const max = value.length;
      ta.setSelectionRange(Math.min(start, max), Math.min(end, max));
    } catch (_) { /* 恢复失败则保持默认光标位置 */ }
  }
}

/**
 * 手动文本框最近一次真实键盘操作的时间戳。
 * 用户清空文本（全选删除/退格/剪切）必然伴随 keydown；宿主重绘清空 value 则没有任何键盘事件。
 * 借此区分「用户删光了」和「UXP 面板重绘把 value 清空」。
 */
let manualTextLastKeyDownAt = 0;

/**
 * 将手动配音文本框的 value（干净文字）同步到底层 annotatedText，并更新预览。
 * 在文本框 input/change 事件中调用。
 */
function syncManualTextFromTextarea() {
  const ta = $("manualText") as any;
  if (!ta) return;
  const newPlain = ta.value || "";
  // 宿主清空保护：value 为空、state 非空、且近期无键盘输入 → 是 UXP 面板重绘清空了 value
  // （弹窗、PR 事务都会触发）并连带派发了事件。此时不同步（否则 state 和 localStorage
  // 备份都会被清掉），只把显示恢复回来。
  if (!newPlain && (state.manualTextWithAnnotations || "").trim() &&
    Date.now() - manualTextLastKeyDownAt > 200) {
    ensureManualTextareaValue();
    return;
  }
  state.manualTextWithAnnotations = syncAnnotatedText(state.manualTextWithAnnotations || "", newPlain);
  // 确保文本框显示的是 cleanText（用户可能粘贴了带标注的文本）
  const { cleanText } = parseAnnotations(state.manualTextWithAnnotations);
  if (ta.value !== cleanText) {
    writeTextareaValue(ta, cleanText);
  }
  updateManualHighlighter();
  persistManualText(state.manualTextWithAnnotations);
}

/** 将手动配音文本框的光标位置（基于 cleanText）记录到 state */
function recordManualSelection() {
  const ta = $("manualText") as any;
  if (!ta) return;
  try {
    // 宿主重绘清空 value 后光标读数归零，若照常记录会用 {0,0} 覆盖真实选区，
    // 表现为「设定停顿」插到文本开头。此时保留上次有效记录。
    if (!ta.value) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    // 只在 selectionStart/End 为有效数字时更新，避免 sp-textarea 不支持时误置为 0
    if (typeof start === "number" && typeof end === "number" && !isNaN(start) && !isNaN(end)) {
      state.lastManualSelection = { start, end };
    }
  } catch (_) { /* sp-textarea 可能不支持 selectionStart */ }
}

/** 将字幕输入框的光标位置（基于 cleanText）记录到 state */
function recordSubtitleSelection(inputEl: any) {
  try {
    // 同上：value 为空（含宿主清空）时选区读数无意义，不覆盖已有记录
    if (!inputEl.value) return;
    const start = inputEl.selectionStart;
    const end = inputEl.selectionEnd;
    if (typeof start === "number" && typeof end === "number" && !isNaN(start) && !isNaN(end)) {
      state.lastSubtitleSelection = { start, end };
    }
  } catch (_) { /* sp-textfield 可能不支持 selectionStart */ }
}

/** 设置手动配音底层带标注文本，并刷新文本框显示与预览层 */
function setManualAnnotatedText(annotated: string) {
  state.manualTextWithAnnotations = annotated || "";
  const ta = $("manualText") as any;
  const { cleanText } = parseAnnotations(state.manualTextWithAnnotations);
  if (ta) ta.value = cleanText;
  updateManualHighlighter();
  persistManualText(state.manualTextWithAnnotations);
}

$("subtitleDisableAllBtn")?.addEventListener("click", () => {
  const wrap = $("subtitleListWrap");
  if (!wrap) return;
  const checkboxes = Array.from(wrap.querySelectorAll(".sub-row-checkbox")) as any[];
  if (checkboxes.length === 0) return;

  // 当前是否已全部未勾选：是则全部启用，否则全部禁用
  const allDisabled = checkboxes.every((c) => !c.checked);
  const nextChecked = allDisabled;
  checkboxes.forEach((c) => {
    c.checked = nextChecked;
  });
  setDisableAllBtnLabel(!nextChecked);
  // 勾选状态变了，连读分组边界可能随之变化
  refreshLinkGroupVisuals();
});

$("subtitleClearLinkBtn")?.addEventListener("click", () => clearAllSubtitleLinks());

// ─── 手动配音文本持久化（对齐达芬奇版：localStorage，关闭插件不清空则保留） ───
const MANUAL_TEXT_STORAGE_KEY = "manualTextWithAnnotations";

function persistManualText(text?: string) {
  try {
    const ta = $("manualText") as any;
    const value = text !== undefined ? text : (ta?.value ? String(ta.value) : "");
    if (!value) {
      localStorage.removeItem(MANUAL_TEXT_STORAGE_KEY);
    } else {
      localStorage.setItem(MANUAL_TEXT_STORAGE_KEY, value);
    }
  } catch (err) {
    console.warn("[Momo] 保存手动配音文本失败:", err);
  }
}

function restoreManualText() {
  try {
    const saved = localStorage.getItem(MANUAL_TEXT_STORAGE_KEY);
    if (!saved) return;
    // 恢复到底层带标注文本，文本框显示 cleanText，并刷新预览层
    state.manualTextWithAnnotations = saved;
    const ta = $("manualText") as any;
    if (ta) {
      const { cleanText } = parseAnnotations(saved);
      ta.value = cleanText;
    }
    updateManualHighlighter();
  } catch (err) {
    console.warn("[Momo] 恢复手动配音文本失败:", err);
  }
}

// ─── UXP 模态弹窗：设定停顿 / 单字纠音 / 批量纠音 ───
// UXP 不支持浏览器的 prompt()（需 enableAlerts 且非阻塞），改用 <dialog> + uxpShowModal()

/** 将文本框新值同步回底层数据（字幕 item.text 或手动文本持久化） */
function syncTextareaValue(textarea: any, newVal: string) {
  textarea.value = newVal;

  // 字幕编辑框：同步回 state.subtitleItems
  if (textarea.classList && textarea.classList.contains("sub-edit-input")) {
    const id = parseInt(textarea.getAttribute("data-id") || "0", 10);
    const item = state.subtitleItems.find(s => s.id === id);
    if (item) item.text = newVal;
  }

  // 手动文本框：持久化到 localStorage
  if (textarea.id === "manualText") {
    persistManualText(newVal);
  }
}

/** 显示设定停顿弹窗，返回用户选择的停顿值（如 "500ms"），取消则返回 null */
async function showPauseDialog(): Promise<string | null> {
  const dialog = $("pauseDialog") as any;
  const optionsContainer = $("pauseDialogOptions");
  if (!dialog || !optionsContainer) return null;

  // 构建停顿选项按钮
  optionsContainer.innerHTML = "";
  for (const opt of PAUSE_OPTIONS) {
    const btn = document.createElement("sp-button");
    btn.setAttribute("variant", "secondary");
    btn.setAttribute("size", "s");
    btn.textContent = opt.label;
    btn.addEventListener("click", () => {
      dialog.close(opt.value);
    });
    optionsContainer.appendChild(btn);
  }

  const result = await dialog.uxpShowModal({
    title: "设定停顿",
    resize: "none",
    size: { width: 380, height: 160 }
  });

  return (result === "reasonCanceled" || result === "cancel" || result === undefined) ? null : result;
}

/**
 * 显示单字纠音弹窗，返回用户选择的拼音标注（如 "hang 2"），取消则返回 null。
 * 支持链式调用：可从批量纠音弹窗中调用此函数打开二级弹窗。
 */
async function showPolyDialog(char: string, dict: any[]): Promise<string | null> {
  const dialog = $("polyDialog") as any;
  const optionsEl = $("polyDialogOptions");
  const emptyEl = $("polyDialogEmpty");
  const customInput = $("polyCustomInput") as any;
  if (!dialog || !optionsEl) return null;

  const matches = findPolyEntries(char, dict);

  // 构建读音选项列表
  optionsEl.innerHTML = "";
  if (matches.length === 0) {
    if (emptyEl) (emptyEl as any).style.display = "flex";
  } else {
    if (emptyEl) (emptyEl as any).style.display = "none";
    for (const entry of matches) {
      const option = document.createElement("div");
      option.className = "mm-poly-option";
      option.innerHTML = `
        <div class="mm-poly-option-info">
          <span class="mm-poly-pinyin">${entry.pinyin || ""}</span>
          <span class="mm-poly-context">${entry.context || ""}</span>
        </div>
        <span class="mm-poly-select">选择</span>
      `;
      option.addEventListener("click", () => {
        const phonetic = entry.phonetic || entry.pinyin;
        dialog.close(phonetic);
      });
      optionsEl.appendChild(option);
    }
  }

  // 重置手动输入框
  if (customInput) customInput.value = "";

  // 绑定手动输入确认按钮（每次重新绑定，避免闭包残留旧值）
  const customConfirm = $("polyCustomConfirm") as any;
  if (customConfirm) {
    if ((customConfirm as any)._clickHandler) {
      customConfirm.removeEventListener("click", (customConfirm as any)._clickHandler);
    }
    const handler = () => {
      const val = customInput?.value?.trim();
      if (val) {
        dialog.close(val);
      }
    };
    (customConfirm as any)._clickHandler = handler;
    customConfirm.addEventListener("click", handler);
  }

  // 支持回车确认手动输入
  if (customInput) {
    if ((customInput as any)._keyHandler) {
      customInput.removeEventListener("keydown", (customInput as any)._keyHandler);
    }
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        const val = (e.target as any).value?.trim();
        if (val) dialog.close(val);
      }
    };
    (customInput as any)._keyHandler = keyHandler;
    customInput.addEventListener("keydown", keyHandler);
  }

  const result = await dialog.uxpShowModal({
    title: `选择「${char}」的读音`,
    resize: "none",
    size: { width: 420, height: 340 }
  });

  return (result === "reasonCanceled" || result === "cancel" || result === undefined) ? null : result;
}

// ─── 设定停顿（字幕） ───

async function handleSubtitleInsertPause() {
  const id = state.lastFocusedSubtitleId;
  const item = state.subtitleItems.find(s => s.id === id);
  if (!item) {
    showToast("请先在左侧列表中点击聚焦需要修改的字幕文本框", "info");
    return;
  }

  const duration = await showPauseDialog();
  if (!duration) return;

  // 光标位置（基于 cleanText）
  const plainStart = state.lastSubtitleSelection.start;
  const plainEnd = state.lastSubtitleSelection.end;

  // 映射到 annotatedText 位置
  const annotated = item.text || "";
  const annStart = getAnnotatedPos(annotated, plainStart);
  const annEnd = getAnnotatedPos(annotated, plainEnd);

  // 在光标位置插入 [break:xxx]
  const tag = `[break:${duration}]`;
  const newAnnotated = annotated.slice(0, annStart) + tag + annotated.slice(annEnd);
  item.text = newAnnotated;

  // 更新文本框显示（cleanText 不含 break 标记，所以不变）和预览
  const input = document.querySelector(`.sub-edit-input[data-id="${id}"]`) as any;
  if (input) {
    const { cleanText } = parseAnnotations(newAnnotated);
    input.value = cleanText;
    // 光标位置保持（break 标记不占 cleanText 位）
    try { input.setSelectionRange(plainStart, plainStart); } catch (_) { /* ignore */ }
    input.focus();
  }
  updateSubtitlePreview(id);

  showToast(`已插入停顿 ${duration}`, "success");
}

// ─── 设定停顿（手动） ───

async function handleManualInsertPause() {
  const duration = await showPauseDialog();
  if (!duration) return;

  // 光标位置（基于 cleanText）
  const plainStart = state.lastManualSelection.start;
  const plainEnd = state.lastManualSelection.end;

  // 映射到 annotatedText 位置
  const annotated = state.manualTextWithAnnotations || "";
  const annStart = getAnnotatedPos(annotated, plainStart);
  const annEnd = getAnnotatedPos(annotated, plainEnd);

  // 在光标位置插入 [break:xxx]
  const tag = `[break:${duration}]`;
  const newAnnotated = annotated.slice(0, annStart) + tag + annotated.slice(annEnd);
  setManualAnnotatedText(newAnnotated);

  // 光标位置保持
  const ta = $("manualText") as any;
  if (ta) {
    try { ta.setSelectionRange(plainStart, plainStart); } catch (_) { /* ignore */ }
    ta.focus();
  }

  showToast(`已插入停顿 ${duration}`, "success");
}

// ─── 单字纠音（字幕） ───

async function handleSubtitleSingleCorrect() {
  const id = state.lastFocusedSubtitleId;
  const item = state.subtitleItems.find(s => s.id === id);
  if (!item) {
    showToast("请先在左侧列表中点击聚焦并选中汉字再执行纠音", "info");
    return;
  }

  const plainStart = state.lastSubtitleSelection.start;
  const plainEnd = state.lastSubtitleSelection.end;

  if (plainStart === plainEnd) {
    showToast("请先选中文本框中要纠音的单个汉字", "info");
    return;
  }

  const { cleanText } = parseAnnotations(item.text || "");
  const selectedChar = cleanText.slice(plainStart, plainEnd).trim();
  if (selectedChar.length !== 1) {
    showToast("请只选中单个汉字进行纠音", "info");
    return;
  }

  const settings = await settingsStore.load();
  const allDict = getPolyphonicDict(settings.polyphonicDict);

  const phonetic = await showPolyDialog(selectedChar, allDict);
  if (!phonetic) return;

  // 映射到 annotatedText 位置
  const annotated = item.text || "";
  // 拼音标签必须紧贴选中字插入。不能用 getAnnotatedPos(plainEnd)：
  // 若字后紧跟 [break:xxx]（其起始位置恰好等于 plainEnd），
  // 该映射会把停顿标签一并跳过，导致拼音被插到停顿之后（结 50ms [jie 2]合），
  // 脱离汉字的拼音标签将无法被解析和高亮。选区为连续明文，直接平移即可。
  const annStart = getAnnotatedPos(annotated, plainStart);
  const annEnd = annStart + (plainEnd - plainStart);

  // 检查选中字符后是否已有拼音标注，有则替换
  const afterChar = annotated.slice(annEnd);
  const existingMatch = afterChar.match(/^\[[a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ1-5\s]+\]/);

  let newAnnotated: string;
  if (existingMatch) {
    newAnnotated = annotated.slice(0, annEnd) + `[${phonetic}]` + annotated.slice(annEnd + existingMatch[0].length);
  } else {
    newAnnotated = annotated.slice(0, annEnd) + `[${phonetic}]` + annotated.slice(annEnd);
  }
  item.text = newAnnotated;

  // 更新文本框显示和预览
  const input = document.querySelector(`.sub-edit-input[data-id="${id}"]`) as any;
  if (input) {
    const { cleanText: newClean } = parseAnnotations(newAnnotated);
    input.value = newClean;
    try { input.setSelectionRange(plainStart, plainEnd); } catch (_) { /* ignore */ }
    input.focus();
  }
  updateSubtitlePreview(id);

  showToast(`已标注「${selectedChar}」读音`, "success");
}

// ─── 单字纠音（手动） ───

async function handleManualSingleCorrect() {
  const plainStart = state.lastManualSelection.start;
  const plainEnd = state.lastManualSelection.end;

  if (plainStart === plainEnd) {
    showToast("请先在文本框中选中要纠音的单个汉字", "info");
    return;
  }

  const { cleanText } = parseAnnotations(state.manualTextWithAnnotations || "");
  const selectedChar = cleanText.slice(plainStart, plainEnd).trim();
  if (selectedChar.length !== 1) {
    showToast("请只选中单个汉字进行纠音", "info");
    return;
  }

  const settings = await settingsStore.load();
  const allDict = getPolyphonicDict(settings.polyphonicDict);

  const phonetic = await showPolyDialog(selectedChar, allDict);
  if (!phonetic) return;

  // 映射到 annotatedText 位置
  const annotated = state.manualTextWithAnnotations || "";
  // 同字幕轨单字纠音：拼音须紧贴汉字插入，避免越过紧随其后的 [break:xxx]（见上方注释）
  const annStart = getAnnotatedPos(annotated, plainStart);
  const annEnd = annStart + (plainEnd - plainStart);

  // 检查选中字符后是否已有拼音标注，有则替换
  const afterChar = annotated.slice(annEnd);
  const existingMatch = afterChar.match(/^\[[a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ1-5\s]+\]/);

  let newAnnotated: string;
  if (existingMatch) {
    newAnnotated = annotated.slice(0, annEnd) + `[${phonetic}]` + annotated.slice(annEnd + existingMatch[0].length);
  } else {
    newAnnotated = annotated.slice(0, annEnd) + `[${phonetic}]` + annotated.slice(annEnd);
  }
  setManualAnnotatedText(newAnnotated);

  // 恢复选区，方便用户连续操作
  const ta = $("manualText") as any;
  if (ta) {
    try { ta.setSelectionRange(plainStart, plainEnd); } catch (_) { /* ignore */ }
    ta.focus();
  }

  showToast(`已标注「${selectedChar}」读音`, "success");
}

// ─── 批量纠音（手动单条文本） ───

async function handleManualBatchCorrect() {
  const annotated = state.manualTextWithAnnotations || "";
  if (!annotated.trim()) {
    showToast("请先输入文本", "info");
    return;
  }

  const settings = await settingsStore.load();
  const allDict = getPolyphonicDict(settings.polyphonicDict);
  const tokens = parseTextToTokens(annotated, allDict);

  // 检查是否含有多音字
  if (!tokens.some(t => t.isPoly)) {
    showToast("文本中未检测到已知多音字", "info");
    return;
  }

  const result = await showBatchDialog([{ tokens }], false);
  if (!result) return;

  // 重建带标注文本并写回
  const newAnnotated = reconstructText(tokens);
  setManualAnnotatedText(newAnnotated);
  showToast("批量纠音已写入", "success");
}

// ─── 批量纠音（整轨字幕） ───

async function handleSubtitleBatchCorrect() {
  if (!state.subtitleItems || state.subtitleItems.length === 0) {
    showToast("字幕列表为空，无法进行批量纠音", "info");
    return;
  }

  const settings = await settingsStore.load();
  const allDict = getPolyphonicDict(settings.polyphonicDict);

  // 解析每条字幕的 tokens
  const rowsData = state.subtitleItems.map((item, index) => ({
    item,
    index,
    tokens: parseTextToTokens(item.text || "", allDict)
  }));

  // 检查是否有至少一条字幕含多音字
  if (!rowsData.some(r => r.tokens.some(t => t.isPoly))) {
    showToast("整轨字幕中未检测到已知多音字", "info");
    return;
  }

  const result = await showBatchDialog(rowsData, true);
  if (!result) return;

  // 将修改后的文本回写到各字幕行，并更新文本框显示和预览
  rowsData.forEach(rowData => {
    const newText = reconstructText(rowData.tokens);
    rowData.item.text = newText;
    // 更新对应的文本框（显示 cleanText）
    const tf = document.querySelector(`.sub-edit-input[data-id="${rowData.item.id}"]`) as any;
    if (tf) {
      const { cleanText } = parseAnnotations(newText);
      tf.value = cleanText;
    }
    // 更新预览层
    updateSubtitlePreview(rowData.item.id);
  });

  showToast("批量纠音已写入各字幕行", "success");
}

/**
 * 显示批量纠音弹窗。
 * @param rows 每行包含 tokens 数组；字幕模式还含 item 和 index
 * @param isSubtitleMode 是否为字幕模式（显示行号标签）
 * @returns 用户点击「完成纠音」返回 true，取消返回 false
 */
async function showBatchDialog(rows: any[], isSubtitleMode: boolean): Promise<boolean> {
  const dialog = $("batchDialog") as any;
  const contentEl = $("batchDialogContent");
  if (!dialog || !contentEl) return false;

  // 标题栏由 uxpShowModal 原生渲染，模式信息通过 title 参数传入
  const dialogTitle = isSubtitleMode ? "批量多音字纠音（整轨字幕）" : "批量多音字纠音";

  const settings = await settingsStore.load();
  const allDict = getPolyphonicDict(settings.polyphonicDict);

  // 构建内容
  contentEl.innerHTML = "";

  // 字幕模式：只渲染含多音字的行
  const renderRows = isSubtitleMode
    ? rows.filter(r => r.tokens.some((t: TextToken) => t.isPoly))
    : rows;

  // 追踪当前打开的内联选项面板（同一时间只允许一个，避免链式 dialog）
  let currentInlinePanel: HTMLElement | null = null;
  const closeInlinePanel = () => {
    if (currentInlinePanel && currentInlinePanel.parentNode) {
      currentInlinePanel.parentNode.removeChild(currentInlinePanel);
    }
    currentInlinePanel = null;
  };

  if (renderRows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mm-batch-empty";
    empty.textContent = "未检测到多音字";
    contentEl.appendChild(empty);
  } else {
    for (const rowData of renderRows) {
      const rowEl = document.createElement("div");
      rowEl.className = "mm-batch-row";

      if (isSubtitleMode) {
        const label = document.createElement("div");
        label.className = "mm-batch-row-label";
        label.textContent = `第 ${rowData.index + 1} 条`;
        rowEl.appendChild(label);
      }

      const wordsContainer = document.createElement("div");
      wordsContainer.className = "mm-batch-row-words";

      for (const tok of rowData.tokens) {
        const span = document.createElement("span");
        span.className = "mm-batch-char";

        if (tok.type === "break") {
          // 停顿标记：只读展示
          span.textContent = "⏸";
          span.style.color = "var(--accent-color)";
          wordsContainer.appendChild(span);
          continue;
        }

        if (tok.isPoly) {
          span.className = "mm-batch-char mm-batch-poly-char";
          // 刷新该多音字 span 的显示（已纠音/未纠音）
          const updateSpanDisplay = () => {
            if (tok.isCorrected) {
              span.classList.add("is-corrected");
              span.textContent = `${tok.char}[${tok.phonetic}]`;
            } else {
              span.classList.remove("is-corrected");
              span.textContent = tok.char || "";
            }
          };
          updateSpanDisplay();

          // 点击多音字：展开内联选项面板（避免 UXP 链式 dialog 导致的写入失败问题）
          span.addEventListener("click", (e: Event) => {
            e.stopPropagation();

            // 若当前已为此字打开面板，则关闭（toggle 效果）
            if (currentInlinePanel && currentInlinePanel.getAttribute("data-char") === String(tok.char) && currentInlinePanel.getAttribute("data-row") === String(rowData.index)) {
              closeInlinePanel();
              return;
            }

            closeInlinePanel();

            const matches = findPolyEntries(tok.char || "", allDict);
            const panel = document.createElement("div");
            panel.className = "mm-batch-inline-panel";
            panel.setAttribute("data-char", String(tok.char || ""));
            panel.setAttribute("data-row", String(rowData.index));

            if (matches.length === 0) {
              const hint = document.createElement("div");
              hint.className = "mm-batch-inline-hint";
              hint.textContent = "未找到该字的多音字记录";
              panel.appendChild(hint);
            } else {
              for (const entry of matches) {
                const opt = document.createElement("div");
                opt.className = "mm-batch-inline-opt";
                const pinyinSpan = document.createElement("span");
                pinyinSpan.className = "mm-poly-pinyin";
                pinyinSpan.textContent = entry.pinyin || "";
                const ctxSpan = document.createElement("span");
                ctxSpan.className = "mm-poly-context";
                ctxSpan.textContent = entry.context || "";
                opt.appendChild(pinyinSpan);
                opt.appendChild(ctxSpan);
                opt.addEventListener("click", (ev: Event) => {
                  ev.stopPropagation();
                  const phonetic = entry.phonetic || entry.pinyin;
                  tok.isCorrected = true;
                  tok.phonetic = phonetic;
                  tok.type = "annotated";
                  updateSpanDisplay();
                  closeInlinePanel();
                });
                panel.appendChild(opt);
              }
            }

            // 插入到 span 之后
            if (span.parentNode) {
              span.parentNode.insertBefore(panel, span.nextSibling);
              currentInlinePanel = panel;
            }
          });
        } else {
          span.textContent = tok.char || "";
        }

        wordsContainer.appendChild(span);
      }

      rowEl.appendChild(wordsContainer);
      contentEl.appendChild(rowEl);
    }
  }

  // 绑定「完成纠音」按钮（每次重新绑定）
  const confirmBtn = $("batchDialogConfirm") as any;
  if (confirmBtn) {
    if ((confirmBtn as any)._clickHandler) {
      confirmBtn.removeEventListener("click", (confirmBtn as any)._clickHandler);
    }
    const handler = () => {
      closeInlinePanel();
      dialog.close("confirm");
    };
    (confirmBtn as any)._clickHandler = handler;
    confirmBtn.addEventListener("click", handler);
  }

  const result = await dialog.uxpShowModal({
    title: dialogTitle,
    resize: "both",
    size: { width: 520, height: 380 }
  });

  return result === "confirm";
}

// 所有 mm-dialog 的标题与关闭均由 uxpShowModal 原生标题栏承担，
// HTML 内不再自绘 header/关闭按钮（UXP 核心陷阱 #14：双标题栏）

// 绑定设定停顿与纠音按钮事件 (字幕页)
// 使用 state.lastFocusedSubtitleId 追踪最后聚焦的字幕输入框，
// 避免点击按钮后焦点转移到按钮导致 document.activeElement 失效
// mousedown+preventDefault 阻止按钮抢夺焦点，确保文本框选区（selectionStart/selectionEnd）不丢失
$("subtitleInsertPause")?.addEventListener("mousedown", (e: any) => { e.preventDefault(); });
$("subtitleInsertPause")?.addEventListener("click", () => {
  handleSubtitleInsertPause();
});

$("subtitleSingleCorrect")?.addEventListener("mousedown", (e: any) => { e.preventDefault(); });
$("subtitleSingleCorrect")?.addEventListener("click", () => {
  handleSubtitleSingleCorrect();
});

$("subtitleBatchCorrect")?.addEventListener("click", () => {
  handleSubtitleBatchCorrect();
});

$("manualClearText")?.addEventListener("click", () => {
  // 清空底层带标注文本及文本框显示
  setManualAnnotatedText("");
});

// 手动配音文本框：编辑时同步 annotatedText 并更新预览；聚焦/选区变化时记录位置
$("manualText")?.addEventListener("input", () => syncManualTextFromTextarea());
$("manualText")?.addEventListener("change", () => syncManualTextFromTextarea());
// 记录真实键盘操作时间，供 syncManualTextFromTextarea 区分用户清空与宿主清空
$("manualText")?.addEventListener("keydown", () => { manualTextLastKeyDownAt = Date.now(); });
$("manualText")?.addEventListener("focus", () => recordManualSelection());
$("manualText")?.addEventListener("keyup", () => recordManualSelection());
$("manualText")?.addEventListener("click", () => recordManualSelection());
$("manualText")?.addEventListener("select", () => recordManualSelection());
$("manualText")?.addEventListener("blur", () => recordManualSelection());

// mousedown+preventDefault 阻止按钮抢夺焦点，确保手动配音文本框选区不丢失
$("manualInsertPause")?.addEventListener("mousedown", (e: any) => { e.preventDefault(); });
$("manualInsertPause")?.addEventListener("click", () => {
  handleManualInsertPause();
});

$("manualSingleCorrect")?.addEventListener("mousedown", (e: any) => { e.preventDefault(); });
$("manualSingleCorrect")?.addEventListener("click", () => {
  handleManualSingleCorrect();
});

$("manualBatchCorrect")?.addEventListener("click", () => {
  handleManualBatchCorrect();
});

// ─── 预设下拉改变绑定 ───
$("subtitlePresetDropdown")?.addEventListener("change", (e: any) => {
  applyPreset(e.target.value, "subtitle");
});

$("manualPresetDropdown")?.addEventListener("change", (e: any) => {
  applyPreset(e.target.value, "manual");
});

$("saveSubtitlePreset")?.addEventListener("click", () => savePreset("subtitle"));
$("saveManualPreset")?.addEventListener("click", () => savePreset("manual"));

// ─── 核心批量合成与生成逻辑 ───

// 1. 字幕轨批量配音
$("generateSubtitles")?.addEventListener("click", async () => {
  if (!state.selectedVoice) {
    showToast("请先选择配音音色", "error");
    return;
  }

  const checkboxes = document.querySelectorAll(".sub-row-checkbox") as any;
  const checkedIds: number[] = [];
  checkboxes.forEach((c: any) => {
    if (c.checked) {
      checkedIds.push(parseInt(c.getAttribute("data-id") || "0", 10));
    }
  });

  if (checkedIds.length === 0) {
    showToast("请在列表中勾选至少一条待配音的字幕", "info");
    return;
  }

  const settings = await settingsStore.load();
  const polyToggle = $("subtitlePolyToggle") as any;
  const enablePoly = polyToggle.checked;

  // 读取目标音频轨的选择 (可以是 "auto" 或者是具体的轨道索引)
  const audioTrackDropdown = $("subtitleAudioTrackDropdown") as any;
  const targetAudioTrackIndexVal = audioTrackDropdown ? audioTrackDropdown.value : "auto";

  const style = $("subtitleStyleTags")?.querySelector(".tag-item.active")?.getAttribute("data-style") || "";
  const role = $("subtitleRoleTags")?.querySelector(".tag-item.active")?.getAttribute("data-role") || "";
  const styledegreeSlider = $("subtitleStyledegree") as any;
  const styledegree = styledegreeSlider ? `${parseFloat(styledegreeSlider.value) / 100}` : "1.0";
  const rateSlider = $("subtitleRate") as any;
  const rate = rateSlider.value === "0" ? "0%" : `${rateSlider.value}%`;
  const pitchSlider = $("subtitlePitch") as any;
  const pitch = pitchSlider.value === "0" ? "0%" : `${pitchSlider.value}%`;
  const volumeSlider = $("subtitleVolume") as any;
  const volume = `${volumeSlider.value}%`;

  // 按勾选状态 + 连读标记切分为若干「配音单元」：
  // 一个连读组 → 一次 TTS 合成 → 一个音频片段（语气连贯）
  const groups = buildSubtitleLinkGroups(checkedIds);
  const linkedGroupCount = groups.filter(g => g.items.length > 1).length;

  if (groups.length === 0) {
    showToast("请在列表中勾选至少一条待配音的字幕", "info");
    return;
  }

  showToast(`开始生成字幕配音，共 ${groups.length} 段${linkedGroupCount > 0 ? `（含 ${linkedGroupCount} 段连读合并）` : ''}...`, "info");

  // ─── 批量配音前先保存项目 ───
  // 原因：PR 工程未保存时，内部状态可能不一致（如刚移动过音频片段但未落盘），
  // 此时执行 createOverwriteItemAction 可能导致 PR 闪退（无错误信息）。
  // 保存项目可确保工程状态一致，大幅降低闪退概率。
  try {
    showToast("正在保存项目以确保工程状态一致...", "info");
    const saved = await premiereAdapter.saveProject();
    if (!saved) {
      showToast("项目保存失败，仍尝试继续配音（可能增加闪退风险）", "warning");
    }
  } catch (saveErr: any) {
    console.warn("[generateSubtitles] 项目保存失败:", saveErr);
    showToast("项目保存异常，仍尝试继续配音", "warning");
  }

  // ─── 校验目标音轨索引是否仍有效 ───
  // 防止用户在打开下拉后、点击生成前删除了音轨，导致索引越界闪退
  if (targetAudioTrackIndexVal !== "auto") {
    const targetIdx = parseInt(targetAudioTrackIndexVal, 10);
    const currentSummary = await premiereAdapter.getSummary();
    if (currentSummary && targetIdx >= currentSummary.audioTracks.length) {
      showToast(`目标音轨 A${targetIdx + 1} 已不存在（当前仅有 ${currentSummary.audioTracks.length} 条音轨），请重新选择目标音轨`, "error");
      return;
    }
  }

  // 批量配音锁定统一目标音频轨，避免逐句新建不同音轨
  let targetTrackIndex = 0;
  if (targetAudioTrackIndexVal === "auto") {
    try {
      targetTrackIndex = await premiereAdapter.ensureTargetAudioTrack();
    } catch (e: any) {
      showToast(`无法确定目标音频轨: ${e?.message || e}`, "error");
      return;
    }
  } else {
    targetTrackIndex = parseInt(targetAudioTrackIndexVal, 10);
  }

  for (const group of groups) {
    const head = group.items[0];
    // 连读组：把多条字幕拼成一整句（自动补标点），其余情况按单条处理
    const { cleanText, annotations } = group.items.length === 1
      ? parseAnnotations(head.text || "")
      : mergeLinkedGroupTexts(group.items.map(i => i.text || ""));
    // 整段音频从组内第一条字幕的起点插入
    const insertStart = head.start;

    try {
      const result = await ttsProvider.synthesize({
        text: cleanText,
        voice: state.selectedVoice.shortName,
        voiceLabel: cleanVoiceName(state.selectedVoice.localName || state.selectedVoice.displayName || state.selectedVoice.shortName),
        style,
        rate,
        pitch,
        styledegree,
        role,
        volume,
        annotations,
        polyphonicDict: enablePoly ? settings.polyphonicDict : [],
        timelineFps: state.fps,
        projectName: state.projectName
      });

      if (result && result.filePath) {
        const insertOk = await premiereAdapter.insertAudioToTimeline(
          result.filePath,
          insertStart,
          targetTrackIndex
        );

        if (insertOk) {
          group.items.forEach(gi => { gi.status = "成功"; });
        } else {
          throw new Error("Timeline insertion failed");
        }
      }
    } catch (e: any) {
      console.error("[generateSubtitles] 失败:", e);
      const errMsg = (e && (e.message || e.stack)) || String(e);
      group.items.forEach(gi => {
        gi.status = "失败";
        gi.error = errMsg;
      });
      const label = group.items.length > 1
        ? `第 ${head.id}-${group.items[group.items.length - 1].id} 条（连读组）`
        : `第 ${head.id} 条`;
      showToast(`${label}失败，已中止剩余配音：${errMsg}`, "error");
      // 失败即中止，避免后续字幕继续发请求
      break;
    }
  }

  renderSubtitleList();
  showToast("字幕配音生成结束", "success");
});

// 2. 手动配音生成并插入
$("insertManual")?.addEventListener("click", async () => {
  const textarea = $("manualText") as any;
  // 先同步文本框值到底层 annotatedText（确保最新编辑被捕获）
  syncManualTextFromTextarea();
  const annotated = state.manualTextWithAnnotations || "";
  if (!textarea || !parseAnnotations(annotated).cleanText.trim()) {
    showToast("请输入需要配音的文字", "info");
    return;
  }

  if (!state.selectedVoice) {
    showToast("请选择配音音色", "error");
    return;
  }

  const polyToggle = $("manualPolyToggle") as any;
  const enablePoly = polyToggle.checked;

  // 读取目标音频轨选择
  const audioTrackDropdown = $("manualAudioTrackDropdown") as any;
  const targetAudioTrackIndexVal = audioTrackDropdown ? audioTrackDropdown.value : "auto";

  const style = $("manualStyleTags")?.querySelector(".tag-item.active")?.getAttribute("data-style") || "";
  const role = $("manualRoleTags")?.querySelector(".tag-item.active")?.getAttribute("data-role") || "";
  const styledegreeSlider = $("manualStyledegree") as any;
  const styledegree = styledegreeSlider ? `${parseFloat(styledegreeSlider.value) / 100}` : "1.0";
  const rateSlider = $("manualRate") as any;
  const rate = rateSlider.value === "0" ? "0%" : `${rateSlider.value}%`;
  const pitchSlider = $("manualPitch") as any;
  const pitch = pitchSlider.value === "0" ? "0%" : `${pitchSlider.value}%`;
  const volumeSlider = $("manualVolume") as any;
  const volume = `${volumeSlider.value}%`;

  showToast("正在合成音频...", "info");

  // ─── 插入前先保存项目，确保工程状态一致（避免未保存时闪退） ───
  try {
    const saved = await premiereAdapter.saveProject();
    if (!saved) {
      console.warn("[insertManual] 项目保存失败，仍尝试继续");
    }
  } catch (saveErr: any) {
    console.warn("[insertManual] 项目保存异常:", saveErr);
  }

  // ─── 校验目标音轨索引是否仍有效 ───
  if (targetAudioTrackIndexVal !== "auto") {
    const targetIdx = parseInt(targetAudioTrackIndexVal, 10);
    const currentSummary = await premiereAdapter.getSummary();
    if (currentSummary && targetIdx >= currentSummary.audioTracks.length) {
      showToast(`目标音轨 A${targetIdx + 1} 已不存在（当前仅有 ${currentSummary.audioTracks.length} 条音轨），请重新选择目标音轨`, "error");
      return;
    }
  }

  try {
    const settings = await settingsStore.load();
    const { cleanText, annotations } = parseAnnotations(annotated);

    const activeProject = await ppro.Project.getActiveProject();
    if (!activeProject) throw new Error("No active project");
    const activeSequence = await activeProject.getActiveSequence();
    if (!activeSequence) throw new Error("No active sequence");

    const playerTime = await activeSequence.getPlayerPosition();
    const startSeconds = playerTime.seconds;

    const result = await ttsProvider.synthesize({
      text: cleanText,
      voice: state.selectedVoice.shortName,
      voiceLabel: cleanVoiceName(state.selectedVoice.localName || state.selectedVoice.displayName || state.selectedVoice.shortName),
      style,
      rate,
      pitch,
      styledegree,
      role,
      volume,
      annotations,
      polyphonicDict: enablePoly ? settings.polyphonicDict : [],
      timelineFps: state.fps,
      projectName: state.projectName
    });

    if (result && result.filePath) {
      showToast("合成成功，正在插入到时间轴...", "info");

      let insertOk = false;
      if (targetAudioTrackIndexVal === "auto") {
        insertOk = await premiereAdapter.insertAudioToTimelineAutoTrack(result.filePath, startSeconds);
      } else {
        insertOk = await premiereAdapter.insertAudioToTimeline(
          result.filePath,
          startSeconds,
          parseInt(targetAudioTrackIndexVal, 10)
        );
      }

      if (insertOk) {
        showToast("配音已成功插入到播放头位置", "success");
      } else {
        throw new Error("Insert playhead failed");
      }
    }
  } catch (err: any) {
    console.error("[insertManual] 失败:", err);
    const errMsg = (err && (err.message || err.stack)) || String(err);
    showToast(`生成手动配音失败：${errMsg}`, "error");
  } finally {
    // 配音流程中 PR 执行事务/保存可能导致 UXP 面板重绘，textarea value 偶发被清空，
    // 结束后立即自愈恢复，避免用户看到文字"消失"
    ensureManualTextareaValue();
  }
});

// ─── 左下角"已连接"状态指示器：点击刷新当前工程 ───
// 注：仅字幕自动配音页绑定刷新动作；手动配音页无需读取字幕轨内容，
// 其"已连接"指示器（refreshBtnManual）为静态展示，不绑定点击/键盘事件。
["refreshBtnSubtitles"].forEach(id => {
  const el = $(id);
  if (!el) return;
  el.addEventListener("click", manualRefresh);
  // 支持键盘触发（focus 后按 Enter/Space）
  el.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      manualRefresh();
    }
  });
});

// ─── 预览层标签撤销：事件委托 ───
// 字幕预览层（#subtitleListWrap 内的 .sub-preview）是动态渲染的，用事件委托绑定到父容器只需一次。
// 点击标签上的 × 关闭按钮 → 调用 removeAnnotationByIndex 撤销该标注，同步更新文本框与预览层。
$("subtitleListWrap")?.addEventListener("click", (e: any) => {
  const removeBtn = e.target.closest(".ann-remove");
  if (!removeBtn) return;
  e.stopPropagation();
  const idx = parseInt(removeBtn.getAttribute("data-idx") || "0", 10);
  const previewEl = removeBtn.closest(".sub-preview");
  if (!previewEl) return;
  const id = parseInt(previewEl.getAttribute("data-id") || "0", 10);
  const item = state.subtitleItems.find(s => s.id === id);
  if (!item) return;
  item.text = removeAnnotationByIndex(item.text || "", idx);
  // 同步文本框显示（cleanText）
  const input = document.querySelector(`.sub-edit-input[data-id="${id}"]`) as any;
  if (input) {
    const { cleanText } = parseAnnotations(item.text || "");
    input.value = cleanText;
  }
  updateSubtitlePreview(id);
  showToast("已撤销该标注", "info");
});

// 手动配音预览层（#manualTextHighlight）是静态元素，直接绑定。
$("manualTextHighlight")?.addEventListener("click", (e: any) => {
  const removeBtn = e.target.closest(".ann-remove");
  if (!removeBtn) return;
  e.stopPropagation();
  const idx = parseInt(removeBtn.getAttribute("data-idx") || "0", 10);
  state.manualTextWithAnnotations = removeAnnotationByIndex(state.manualTextWithAnnotations || "", idx);
  const ta = $("manualText") as any;
  if (ta) {
    const { cleanText } = parseAnnotations(state.manualTextWithAnnotations);
    ta.value = cleanText;
  }
  updateManualHighlighter();
  persistManualText(state.manualTextWithAnnotations);
  showToast("已撤销该标注", "info");
});

// 挂载总入口
document.addEventListener("DOMContentLoaded", initPlugin);
