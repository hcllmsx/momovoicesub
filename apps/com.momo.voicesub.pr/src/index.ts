// @ts-ignore
import uxp from "uxp";
import { SettingsStore, VoiceInfo } from "./lib/settings-store";
import { AzureTtsProvider, styleNameCn } from "./lib/azure-tts";
import { PremiereAdapter, SubtitleItem } from "./adapter/premiere-adapter";
import polyphonicBuiltin from "./lib/polyphonic-builtin.json";

declare const require: any;
// 构建时由 Vite define 注入，取自项目根目录 VERSION 文件中的 com.momo.voicesub.pr.version 字段
declare const __APP_VERSION__: string;
// 引用全局宿主
const ppro = require("premierepro");
// UXP shell 模块：用于用系统默认应用打开试听 wav 文件
const uxpShell = (uxp as any).shell;

// 实例化模块
const settingsStore = new SettingsStore();
const premiereAdapter = new PremiereAdapter();
let ttsProvider: AzureTtsProvider;

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
  
  // 选中的音色
  selectedVoice: null as VoiceInfo | null,
  
  // 参数预设列表
  presets: [] as any[],
  defaultPresetId: 'preset-default',
  currentPresetName: "",

  // 音色列表（缓存）
  voices: [] as VoiceInfo[],
  favoriteVoices: [] as string[],

  // ─── 标注编辑追踪（与达芬奇版对齐：文本框显示干净文字，底层存储带标注文本） ───
  // 最后聚焦的字幕输入框 id（点击按钮时焦点会转移到按钮，需提前记录）
  lastFocusedSubtitleId: 0 as number,
  // 最后聚焦的字幕选区（基于 cleanText 的位置）
  lastSubtitleSelection: { start: 0, end: 0 } as { start: number, end: number },
  // 手动配音文本框最后的选区（基于 cleanText 的位置）
  lastManualSelection: { start: 0, end: 0 } as { start: number, end: number },
  // 手动配音底层带标注文本（文本框只显示其 cleanText）
  manualTextWithAnnotations: "" as string
};

// ─── 音色选择器辅助定义（移植自达芬奇版 renderer.js） ───

// 头像图片路径。
// ⚠️ UXP 的 <img src> 不支持 data: URI（文档仅声明 string|File），且 SVG 渲染器
// 针对简单图标、复杂 SVG 可能无法渲染（见 UXP Known Issues）。因此必须用真实图片文件，
// 不能用 data:image/svg+xml 内联。路径相对于 index.html（构建后 dist/ 同级 img/）。
const AVATAR_MAP: Record<string, string> = {
  Female: "./img/woman-default.jpg",
  Male: "./img/man-default.jpg"
};

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
  { id: 'zh', label: '中文', match: (l) => !!l && (l.startsWith('zh-') || l.startsWith('yue-') || l.startsWith('wuu-')),
    subs: {
      'zh-CN': { label: '普通话', locales: ['zh-CN'] },
      'yue':   { label: '粤语',   locales: ['zh-HK', 'yue-CN'] },
      'zh-TW': { label: '国语(台湾)', locales: ['zh-TW'] },
    } },
  { id: 'en', label: 'English', match: (l) => !!l && l.startsWith('en-'),
    subs: {
      'en-US': { label: '美国',   locales: ['en-US'] },
      'en-GB': { label: '英国',   locales: ['en-GB'] },
      'en-AU': { label: '澳洲',   locales: ['en-AU'] },
      'en-CA': { label: '加拿大', locales: ['en-CA'] },
      'en-IN': { label: '印度',   locales: ['en-IN'] },
    } },
  { id: 'ja', label: '日本語', match: (l) => l === 'ja-JP', subs: {} },
  { id: 'ko', label: '한국어', match: (l) => l === 'ko-KR', subs: {} },
  { id: 'fr', label: 'Français', match: (l) => !!l && l.startsWith('fr-'),
    subs: {
      'fr-FR': { label: '法国',   locales: ['fr-FR'] },
      'fr-CA': { label: '加拿大', locales: ['fr-CA'] },
      'fr-CH': { label: '瑞士',   locales: ['fr-CH'] },
    } },
  { id: 'de', label: 'Deutsch', match: (l) => !!l && l.startsWith('de-'),
    subs: {
      'de-DE': { label: '德国',   locales: ['de-DE'] },
      'de-AT': { label: '奥地利', locales: ['de-AT'] },
      'de-CH': { label: '瑞士',   locales: ['de-CH'] },
    } },
  { id: 'es', label: 'Español', match: (l) => !!l && l.startsWith('es-'),
    subs: {
      'es-ES': { label: '西班牙', locales: ['es-ES'] },
      'es-MX': { label: '墨西哥', locales: ['es-MX'] },
    } },
  { id: 'pt', label: 'Português', match: (l) => !!l && l.startsWith('pt-'),
    subs: {
      'pt-BR': { label: '巴西',   locales: ['pt-BR'] },
      'pt-PT': { label: '葡萄牙', locales: ['pt-PT'] },
    } },
  { id: 'it', label: 'Italiano', match: (l) => l === 'it-IT', subs: {} },
  { id: 'ru', label: 'Русский', match: (l) => l === 'ru-RU', subs: {} },
  { id: 'ar', label: 'العربية', match: (l) => !!l && l.startsWith('ar-'),
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

/** 根据风格名归类情感强度 */
function emotionCat(style: string): string {
  const strong = new Set(['angry', 'excited', 'fearful', 'terrified', 'shouting', 'unfriendly', 'cheerful', 'envy', 'narration-sports-excited', 'live-commercial', 'sports_commentary_excited', 'advertisement_upbeat']);
  const emotional = new Set(['sad', 'sorrowful', 'calm', 'hopeful', 'serious', 'lyrical', 'narration-professional', 'narration-relaxed', 'embarrassed', 'whispering', 'depressed', 'affectionate', 'disgruntled', 'poetry-reading', 'documentary-narration']);
  if (strong.has(style)) return 'strong';
  if (emotional.has(style)) return 'emotional';
  return 'normal';
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
  for (const ann of annotations) {
    if (ann.type === "phoneme") {
      const idx = ann.start;
      if (idx >= 0 && idx < charAnns.length) {
        charAnns[idx].phoneme = ann.phonetic;
      }
    } else if (ann.type === "break") {
      // break 标注的 start 表示插入位置（在 cleanText 的 start 之前）
      const idx = Math.min(ann.start, charAnns.length);
      if (idx >= 0 && idx <= charAnns.length) {
        const safeIdx = Math.min(idx, charAnns.length - 1);
        if (safeIdx >= 0) charAnns[safeIdx].breaks.push(ann.duration);
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

  // 前缀部分：保留标注
  for (let i = 0; i < prefixLen; i++) {
    result += newPlain[i];
    const ca = charAnns[i];
    if (ca && ca.phoneme) {
      result += `[${ca.phoneme}]`;
    }
    if (ca && ca.breaks.length > 0) {
      for (const b of ca.breaks) {
        result += `[break:${b}]`;
      }
    }
  }

  // 中间部分（新增/修改的字符）：无标注
  result += newPlain.slice(prefixLen, newPlain.length - suffixLen);

  // 后缀部分：保留标注
  for (let i = 0; i < suffixLen; i++) {
    const newIdx = newPlain.length - suffixLen + i;
    const oldIdx = oldPlain.length - suffixLen + i;
    result += newPlain[newIdx];
    const ca = charAnns[oldIdx];
    if (ca && ca.phoneme) {
      result += `[${ca.phoneme}]`;
    }
    if (ca && ca.breaks.length > 0) {
      for (const b of ca.breaks) {
        result += `[break:${b}]`;
      }
    }
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

// ─── 初始化与连接 ───
async function initPlugin() {
  try {
    // 设置页底部版本号显示（构建时从 VERSION 文件注入）
    // 「momoVoicesub」为指向 GitHub 仓库的超链接，点击调 shell.openExternal 打开浏览器
    const appVersionEl = $("appVersion");
    if (appVersionEl) {
      appVersionEl.innerHTML = `默默配音助手（<a id="appVersionLink" class="app-version-link" href="javascript:void(0)">momoVoicesub</a>） v${__APP_VERSION__}`;
      const linkEl = $("appVersionLink");
      if (linkEl) {
        linkEl.addEventListener("click", async () => {
          if (uxpShell && typeof (uxpShell as any).openExternal === "function") {
            const err = await (uxpShell as any).openExternal(
              "https://github.com/hcllmsx/momovoicesub",
              "默默配音助手将打开 GitHub 开源仓库页面"
            );
            if (err && String(err).length > 0) {
              showToast(`打开链接失败：${err}`, "error");
            }
          } else {
            showToast("当前运行时不支持打开外部链接", "error");
          }
        });
      }
    }

    const settings = await settingsStore.load();
    state.voices = settings.voices || [];
    state.favoriteVoices = settings.favoriteVoices || [];
    
    ttsProvider = new AzureTtsProvider({
      getSettings: () => settingsStore.load(),
      getAzureKey: () => settingsStore.getAzureKey()
    });

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

    const endpointInput = $("settingEndpoint") as any;
    if (endpointInput) endpointInput.value = settings.endpoint || "";

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

    renderDictList(settings.polyphonicDict || []);

    // 恢复手动配音文本（与达芬奇版一致：不清空则跨会话保留）
    restoreManualText();

  } catch (err) {
    console.error("Init plugin failed:", err);
    showToast("初始化插件失败", "error");
  }
}

// 同步 PR 时间线状态
async function syncWithPremiere() {
  const summary = await premiereAdapter.getSummary();
  if (!summary) {
    $("projectNameText")!.innerText = "未检测到项目";
    $("sequenceNameText")!.innerText = "无活动序列";
    return;
  }

  const projectChanged = state.projectName !== summary.projectName;
  const sequenceChanged = state.sequenceName !== summary.sequenceName;

  state.projectName = summary.projectName;
  state.sequenceName = summary.sequenceName;
  state.fps = summary.fps;

  $("projectNameText")!.innerText = summary.projectName;
  $("sequenceNameText")!.innerText = summary.sequenceName;

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
      // 没有字幕轨
      if (state.activeCaptionTrackIndex >= 0) {
        // 之前选中了某个字幕轨，现在该轨道没了（如切换序列），切回手动模式
        state.activeCaptionTrackIndex = -1;
        // 恢复手动 SRT 备份（若有），避免字幕列表被清空
        state.subtitleItems = state.manualSrtItemsBackup.slice();
        renderSubtitleList();
      }
      // 注意：若已经是手动模式（activeCaptionTrackIndex === -1），保留当前 subtitleItems
      // （可能是用户手动导入的 SRT），不因音频轨数量变化等无关刷新而清空
      updateImportSrtBtnVisibility();
    }
  }
}

// 仅在「无字幕轨 (手动SRT模式)」时显示「导入本地 SRT」按钮
function updateImportSrtBtnVisibility() {
  const btn = $("subtitleImportSrtBtn");
  if (!btn) return;
  if (state.activeCaptionTrackIndex === -1) {
    btn.classList.remove("hidden");
  } else {
    btn.classList.add("hidden");
  }
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
          `已读到 ${items.length} 条字幕时序，但未能自动提取字幕文字。请点击「导入本地 SRT」完成配对。`,
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
  filterEmotion: string;
  showFavoritesOnly: boolean;
  returnTab: string;
  built: boolean;
}

const voicePage: VoicePageState = {
  filterText: '',
  filterLocaleGroup: 'zh',
  filterLocaleSub: null,
  filterGender: 'all',
  filterEmotion: 'all',
  showFavoritesOnly: false,
  returnTab: 'subtitles',
  built: false,
};

function getLocaleGroups() {
  return LOCALE_GROUPS.map(g => {
    const count = state.voices.filter(v => g.match(v.locale)).length;
    return { ...g, count };
  }).filter(g => g.count > 0 || g.id === 'all');
}

function getActiveSubLocales(): [string, { label: string; count: number }][] {
  const group = LOCALE_GROUPS.find(g => g.id === voicePage.filterLocaleGroup);
  if (!group || !Object.keys(group.subs).length) return [];

  const result: [string, { label: string; count: number }][] = [];
  for (const [key, subDef] of Object.entries(group.subs)) {
    const count = state.voices.filter(v => group.match(v.locale) && subMatchesLocale(subDef, v.locale)).length;
    result.push([key, { label: subDef.label, count }]);
  }

  // 追加未覆盖的 locale 作为动态 sub
  const coveredLocales = new Set<string>();
  for (const subDef of Object.values(group.subs)) {
    if (subDef.locales) subDef.locales.forEach(l => coveredLocales.add(l));
  }
  const uncovered = state.voices
    .filter(v => group.match(v.locale) && !coveredLocales.has(v.locale))
    .map(v => v.locale);
  const uniqUncovered = Array.from(new Set(uncovered));
  for (const loc of uniqUncovered) {
    const count = state.voices.filter(v => v.locale === loc).length;
    result.push([loc, { label: localeLabel(loc), count }]);
  }
  return result;
}

function filteredVoices(): VoiceInfo[] {
  const result = state.voices.filter((v) => {
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
    if (voicePage.filterEmotion !== 'all') {
      const hasMatchingStyle = (v.styles || []).some(s => emotionCat(s) === voicePage.filterEmotion);
      if (!hasMatchingStyle) return false;
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
  const avatarSrc = AVATAR_MAP[voice.gender] || AVATAR_MAP.Female;
  const styleTags = (voice.styles || []).slice(0, 2);
  const extraStyles = (voice.styles || []).length - 2;

  const card = document.createElement('div');
  card.className = `vp-card${isSelected ? ' selected' : ''}`;
  card.dataset.shortName = voice.shortName;

  card.innerHTML = `
    <img class="vp-card-avatar" src="${avatarSrc}" alt="">
    <div class="vp-card-info">
      <div class="vp-card-name">${cleanVoiceName(voice.localName || voice.displayName || voice.shortName)}</div>
      <div class="vp-card-meta">
        <span class="vp-card-tag">${localeLabel(voice.locale) || voice.locale}</span>
        <span class="vp-card-tag">${voice.gender === 'Female' ? '女声' : voice.gender === 'Male' ? '男声' : voice.gender || ''}</span>
        ${styleTags.map(s => `<span class="vp-card-tag style-tag">${styleNameCn(s)}</span>`).join('')}
        ${extraStyles > 0 ? `<span class="vp-card-tag">+${extraStyles}</span>` : ''}
      </div>
    </div>
    <div class="vp-card-actions">
      <div class="vp-card-preview-btn" role="button" tabindex="0" title="试听">▶</div>
      <div class="vp-card-fav-btn${isFav ? ' favorited' : ''}" role="button" tabindex="0" title="${isFav ? '取消收藏' : '收藏'}">${isFav ? '❤' : '♡'}</div>
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
  grid.innerHTML = '';

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'vp-grid-empty';
    if (!state.voices || state.voices.length === 0) {
      empty.textContent = '暂无音色数据，请到设置页「刷新音色」获取';
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
<sp-textfield class="vp-filter-search" type="search" placeholder="搜索音色名 / 语种..." value="${voicePage.filterText}"></sp-textfield>
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
        <span class="vp-filter-label">情感</span>
        <span class="vp-tag${voicePage.filterEmotion === 'all' ? ' active' : ''}" data-emotion="all">全部</span>
        <span class="vp-tag${voicePage.filterEmotion === 'strong' ? ' active' : ''}" data-emotion="strong">超强情感</span>
        <span class="vp-tag${voicePage.filterEmotion === 'emotional' ? ' active' : ''}" data-emotion="emotional">有情感</span>
        <span class="vp-tag${voicePage.filterEmotion === 'normal' ? ' active' : ''}" data-emotion="normal">普通</span>
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

  container.querySelectorAll('[data-emotion]').forEach(el => {
    el.addEventListener('click', () => {
      container.querySelectorAll('[data-emotion]').forEach(t => t.classList.remove('active'));
      el.classList.add('active');
      voicePage.filterEmotion = (el as HTMLElement).dataset.emotion || 'all';
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

/** 渲染音色选择独立页面（筛选栏 + 网格）。切到 voices tab 或数据更新时调用 */
function renderVoicesPage() {
  const container = $('voicesPageContainer');
  if (!container) return;
  if (!voicePage.built) {
    container.innerHTML = `
      <div class="vp-filter-bar"></div>
      <div class="vp-grid" id="voicesGrid"></div>
    `;
    voicePage.built = true;
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
  // 若当前未选中或选中音色已不在列表中，尝试从设置恢复上次选中的音色
  if (state.voices.length > 0) {
    const cur = state.selectedVoice;
    if (!cur || !state.voices.some(v => v.shortName === cur.shortName)) {
      // 优先从设置中恢复上次选中的音色
      try {
        const settings = await settingsStore.load();
        const savedVoice = settings.defaultVoice;
        if (savedVoice) {
          const found = state.voices.find(v => v.shortName === savedVoice);
          if (found) {
            state.selectedVoice = found;
            renderStylesAndRoles(found);
          } else {
            state.selectedVoice = state.voices[0];
            renderStylesAndRoles(state.voices[0]);
          }
        } else {
          state.selectedVoice = state.voices[0];
          renderStylesAndRoles(state.voices[0]);
        }
      } catch (_) {
        state.selectedVoice = state.voices[0];
        renderStylesAndRoles(state.voices[0]);
      }
    }
  }

  // 容器前缀 → tab 名映射（容器 id 用 subtitle，但导航 tab 用 subtitles）
  const tabByPrefix: Record<string, string> = { subtitle: 'subtitles', manual: 'manual' };
  for (const prefix of ['subtitle', 'manual']) {
    const container = $(`${prefix}VoiceContainer`);
    if (!container) continue;
    const voice = state.selectedVoice;
    const hasVoice = !!voice;
    const avatar = hasVoice ? (AVATAR_MAP[voice.gender] || AVATAR_MAP.Female) : AVATAR_MAP.Female;
    const name = hasVoice ? cleanVoiceName(voice.localName || voice.displayName || voice.shortName) : '请选择音色';
    const locale = hasVoice ? (localeLabel(voice.locale) || voice.locale || '') : '';
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
  label.textContent = voice
    ? `${cleanVoiceName(voice.localName || voice.displayName || voice.shortName)} · ${localeLabel(voice.locale) || voice.locale}`
    : '未选择音色';
}

/** 切换到指定 tab（封装导航逻辑，供音色页返回使用） */
function switchToTab(tabName: string) {
  const btn = document.querySelector(`.nav-btn[data-tab="${tabName}"]`);
  if (btn) btn.dispatchEvent(new Event('click'));
}

/** 从字幕/手动页跳转到音色选择页 */
function openVoicePicker(fromTab: string) {
  if (!state.voices || state.voices.length === 0) {
    showToast("暂无音色数据，请到设置页「刷新音色」获取", "info");
    return;
  }
  voicePage.returnTab = fromTab;
  switchToTab('voices');
  renderVoicesPage();
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
  // 只传 defaultVoice 字段，避免 load() 失败时用默认值覆盖文件中的其他数据
  try {
    await settingsStore.save({ defaultVoice: voice.shortName });
  } catch (e) {
    console.error("[Momo] 保存选中音色失败:", e);
  }
}

function renderStylesAndRoles(voice: VoiceInfo) {
  const renderPanel = (prefix: "subtitle" | "manual") => {
    const styleTagsWrap = $(`${prefix}StyleTags`);
    if (styleTagsWrap) {
      let html = '<div class="tag-item active" data-style="">通用</div>';
      for (const style of voice.styles) {
        html += `<div class="tag-item" data-style="${style}">${styleNameCn(style)}</div>`;
      }
      styleTagsWrap.innerHTML = html;

      styleTagsWrap.querySelectorAll(".tag-item").forEach(tag => {
        tag.addEventListener("click", () => {
          styleTagsWrap.querySelectorAll(".tag-item").forEach(t => t.classList.remove("active"));
          tag.classList.add("active");
          
          const isGeneral = tag.getAttribute("data-style") === "";
          const styledegreeArea = $(`${prefix}StyledegreeArea`);
          if (styledegreeArea) {
            if (isGeneral) styledegreeArea.classList.add("hidden");
            else styledegreeArea.classList.remove("hidden");
          }
        });
      });
    }

    const roleArea = $(`${prefix}RoleArea`);
    const roleTagsWrap = $(`${prefix}RoleTags`);
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
    const voice = state.voices.find(v => v.shortName === shortName);
    if (!voice) return;

    if (!uxpShell || typeof uxpShell.openPath !== 'function') {
      showToast("当前 UXP 运行时不支持调用系统播放器，无法试听", "error");
      return;
    }

    // 找到试听按钮并标记 loading 状态
    const btn = document.querySelector(`.vp-card[data-short-name="${shortName}"] .vp-card-preview-btn`) as HTMLElement | null;
    if (btn) btn.classList.add('loading');

    const voiceName = cleanVoiceName(voice.localName || voice.displayName || voice.shortName);
    showToast(`正在准备「${voiceName}」的试听样本...`, "info");

    const result = await ttsProvider.synthesizePreview({
      shortName,
      localName: voice.localName,
      displayName: voice.displayName,
      locale: voice.locale
    });

    if (result && result.wavBuffer) {
      // 写入固定文件名（覆盖旧内容），路径固定 → openPath 权限只弹一次
      const dataFolder = await uxp.storage.localFileSystem.getDataFolder();
      let previewFolder;
      try {
        previewFolder = await dataFolder.getEntry('preview');
      } catch (_) {
        previewFolder = await dataFolder.createFolder('preview');
      }
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
      try { inputEl.select(); } catch (_) {}

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
    const input = $('cacheDirPath') as any;
    if (input) input.value = path;
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
  const endpointInput = $("settingEndpoint") as any;

  // 读取表单值
  const formSettings: any = {
    rememberKey: rememberKeyCheckbox.checked,
    region: regionInput.value.trim(),
    endpoint: endpointInput.value.trim()
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
  showToast(saved.hasAzureKey ? "设置已保存，密钥可用" : "设置已保存，但没有可用密钥", "success");
});

$("testTtsConnection")?.addEventListener("click", async () => {
  const keyInput = $("settingAzureKey") as any;
  const regionInput = $("settingRegion") as any;
  const endpointInput = $("settingEndpoint") as any;

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
    showToast("请输入服务区域", "error");
    return;
  }

  showToast("正在测试与微软语音服务连接...", "info");

  try {
    const testSettings = {
      azureKey: effectiveKey,
      region: regionInput.value.trim(),
      endpoint: endpointInput.value.trim()
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
        endpoint: endpointInput.value.trim(),
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

// 独立「刷新音色」按钮：用已保存的密钥拉取最新音色列表（不要求重新输入 key）
$("refreshVoicesBtn")?.addEventListener("click", async () => {
  const regionInput = $("settingRegion") as any;
  const endpointInput = $("settingEndpoint") as any;

  const key = await settingsStore.getAzureKey();
  if (!key) {
    showToast("请先在上方输入密钥并点「测试连接」或「保存所有设置」", "error");
    return;
  }
  if (!regionInput?.value) {
    showToast("请先填写服务区域", "error");
    return;
  }

  showToast("正在刷新音色列表...", "info");
  try {
    const tempProvider = new AzureTtsProvider({
      getSettings: () => Promise.resolve({
        azureKey: key,
        region: regionInput.value.trim(),
        endpoint: endpointInput?.value?.trim() || ""
      }),
      getAzureKey: () => Promise.resolve(key)
    });

    const voices = await tempProvider.listVoices();

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
  }
});

// ─── 多音字字典管理 ───
function renderDictList(polyDict: any[]) {
  const wrap = $("dictListWrap");
  if (!wrap) return;

  if (polyDict.length === 0) {
    wrap.innerHTML = '<div style="padding:10px;text-align:center;color:gray;">字典中暂无自定义条目</div>';
    return;
  }

  let html = "";
  polyDict.forEach((entry, idx) => {
    html += `
      <div class="dict-list-row">
        <span class="col-char">${entry.char}</span>
        <span class="col-pinyin">${entry.pinyin}</span>
        <span class="col-phonetic">${entry.phonetic || "-"}</span>
        <span class="col-action">
          <sp-button variant="secondary" quiet size="s" class="dict-del-btn" data-idx="${idx}">删除</sp-sp-button>
        </span>
      </div>
    `;
  });
  wrap.innerHTML = html;

  wrap.querySelectorAll(".dict-del-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const idx = parseInt(btn.getAttribute("data-idx") || "0", 10);
      const settings = await settingsStore.load();
      const dict = settings.polyphonicDict || [];
      dict.splice(idx, 1);
      // 只传 polyphonicDict 字段，避免覆盖其他数据
      await settingsStore.save({ polyphonicDict: dict });
      
      showToast("词条已成功删除", "success");
      renderDictList(dict);
    });
  });
}

$("dictAddBtn")?.addEventListener("click", async () => {
  const charInput = $("dictAddChar") as any;
  const pinyinInput = $("dictAddPinyin") as any;
  const phoneticInput = $("dictAddPhonetic") as any;

  const char = charInput.value.trim();
  const pinyin = pinyinInput.value.trim();
  const phonetic = phoneticInput.value.trim();

  if (!char || !pinyin) {
    showToast("汉字与拼音标示为必填项", "error");
    return;
  }

  const settings = await settingsStore.load();
  const dict = settings.polyphonicDict || [];
  
  dict.push({ char, pinyin, phonetic });
  // 只传 polyphonicDict 字段，避免覆盖其他数据
  await settingsStore.save({ polyphonicDict: dict });

  showToast(`已成功添加词条「${char}」`, "success");
  
  charInput.value = "";
  pinyinInput.value = "";
  phoneticInput.value = "";

  renderDictList(dict);
});

// ─── 字幕读取与载入 ───
$("subtitleTrackDropdown")?.addEventListener("change", async (e: any) => {
  const val = parseInt(e.target.value, 10);
  const prevIndex = state.activeCaptionTrackIndex;

  // 从手动模式切走到字幕轨：备份当前手动导入的 SRT，以便切回时恢复
  if (prevIndex === -1 && val !== -1) {
    state.manualSrtItemsBackup = state.subtitleItems.slice();
  }

  state.activeCaptionTrackIndex = val;
  updateImportSrtBtnVisibility();
  if (val === -1) {
    // 切回手动模式：恢复之前备份的 SRT（若有），而非清空
    state.subtitleItems = state.manualSrtItemsBackup.slice();
    renderSubtitleList();
    if (state.subtitleItems.length > 0) {
      showToast(`已切换到手动 SRT 模式，恢复 ${state.subtitleItems.length} 条字幕`, "info");
    } else {
      showToast("已切换到手动 SRT 模式，可导入本地 SRT 开始", "info");
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
      // 在手动模式下，同步更新备份，以便切换轨道后能恢复
      if (state.activeCaptionTrackIndex === -1) {
        state.manualSrtItemsBackup = srtItems.slice();
      }
      renderSubtitleList();
      showToast(`SRT 导入成功！共 ${srtItems.length} 条字幕`, "success");
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
    wrap.innerHTML = '<div class="list-placeholder">请选择上方字幕轨或导入本地 SRT 开始配音</div>';
    setDisableAllBtnLabel(false);
    return;
  }

  let html = "";
  state.subtitleItems.forEach((item) => {
    const statusClass = item.status === "成功" ? "status-success" : (item.status === "失败" ? "status-error" : "status-wait");
    // item.text 为带标注的底层文本，文本框只显示其 cleanText
    const { cleanText } = parseAnnotations(item.text || "");
    const displayText = cleanText;
    const showPreview = hasAnnotations(item.text || "");
    const previewHtml = showPreview ? highlightText(item.text || "") : "";
    html += `
      <div class="sub-item-row" id="sub-row-${item.id}">
        <span class="sub-col-idx">${item.id}</span>
        <span class="sub-col-check">
          <sp-checkbox class="sub-row-checkbox" data-id="${item.id}" checked></sp-checkbox>
        </span>
        <div class="sub-col-text-area">
          <input class="sub-edit-input" type="text" data-id="${item.id}" value="${escapeHtml(displayText)}" placeholder="请输入字幕文字..." />
          <div class="sub-preview ${showPreview ? '' : 'hidden'}" data-id="${item.id}">${previewHtml}</div>
        </div>
        <span class="sub-col-time">${item.start.toFixed(2)}s ~ ${item.end.toFixed(2)}s</span>
        <span class="sub-col-status ${statusClass}">${item.status || "待配音"}</span>
      </div>
    `;
  });
  wrap.innerHTML = html;
  // 渲染后所有 checkbox 默认 checked，按钮文案复位
  setDisableAllBtnLabel(false);

  wrap.querySelectorAll(".sub-edit-input").forEach(input => {
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
 * 将手动配音文本框的 value（干净文字）同步到底层 annotatedText，并更新预览。
 * 在文本框 input/change 事件中调用。
 */
function syncManualTextFromTextarea() {
  const ta = $("manualText") as any;
  if (!ta) return;
  const newPlain = ta.value || "";
  state.manualTextWithAnnotations = syncAnnotatedText(state.manualTextWithAnnotations || "", newPlain);
  // 确保文本框显示的是 cleanText（用户可能粘贴了带标注的文本）
  const { cleanText } = parseAnnotations(state.manualTextWithAnnotations);
  if (ta.value !== cleanText) {
    ta.value = cleanText;
  }
  updateManualHighlighter();
  persistManualText(state.manualTextWithAnnotations);
}

/** 将手动配音文本框的光标位置（基于 cleanText）记录到 state */
function recordManualSelection() {
  const ta = $("manualText") as any;
  if (!ta) return;
  try {
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
});

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
    size: { width: 380, height: 200 }
  });

  return (result === "reasonCanceled" || result === "cancel" || result === undefined) ? null : result;
}

/**
 * 显示单字纠音弹窗，返回用户选择的拼音标注（如 "hang 2"），取消则返回 null。
 * 支持链式调用：可从批量纠音弹窗中调用此函数打开二级弹窗。
 */
async function showPolyDialog(char: string, dict: any[]): Promise<string | null> {
  const dialog = $("polyDialog") as any;
  const titleEl = $("polyDialogTitle");
  const optionsEl = $("polyDialogOptions");
  const emptyEl = $("polyDialogEmpty");
  const customInput = $("polyCustomInput") as any;
  if (!dialog || !optionsEl) return null;

  if (titleEl) titleEl.textContent = `选择「${char}」的读音`;

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
    title: `选择读音`,
    resize: "none",
    size: { width: 420, height: 380 }
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
  const annEnd = getAnnotatedPos(annotated, plainEnd);

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
  const annEnd = getAnnotatedPos(annotated, plainEnd);

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
  const titleEl = $("batchDialogTitle");
  if (!dialog || !contentEl) return false;

  if (titleEl) {
    titleEl.textContent = isSubtitleMode ? "批量多音字纠音（整轨字幕）" : "批量多音字纠音";
  }

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
    title: "批量多音字纠音",
    resize: "both",
    size: { width: 520, height: 420 }
  });

  return result === "confirm";
}

/** 初始化弹窗关闭按钮事件（只需绑定一次） */
function initDialogs() {
  $("pauseDialogClose")?.addEventListener("click", () => {
    ($("pauseDialog") as any).close("cancel");
  });
  $("polyDialogClose")?.addEventListener("click", () => {
    ($("polyDialog") as any).close("cancel");
  });
  $("batchDialogClose")?.addEventListener("click", () => {
    ($("batchDialog") as any).close("cancel");
  });
}

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

  showToast(`开始生成字幕配音，共 ${checkedIds.length} 条...`, "info");

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

  for (const id of checkedIds) {
    const item = state.subtitleItems.find(s => s.id === id);
    if (!item) continue;

    const row = $(`sub-row-${item.id}`);
    const statusCol = row?.querySelector(".sub-col-status") as HTMLElement;

    if (statusCol) {
      statusCol.innerText = "合成中...";
      statusCol.className = "sub-col-status status-wait";
    }

    try {
      const { cleanText, annotations } = parseAnnotations(item.text);

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
        if (statusCol) {
          statusCol.innerText = "插入中...";
        }

        // 根据下拉框选择调用不同插入方案：
        // 自动默默配音轨还是手动指定覆盖音轨
        let insertOk = false;
        if (targetAudioTrackIndexVal === "auto") {
          insertOk = await premiereAdapter.insertAudioToTimelineAutoTrack(result.filePath, item.start);
        } else {
          insertOk = await premiereAdapter.insertAudioToTimeline(
            result.filePath, 
            item.start, 
            parseInt(targetAudioTrackIndexVal, 10)
          );
        }

        if (insertOk) {
          item.status = "成功";
          if (statusCol) {
            statusCol.innerText = "成功";
            statusCol.className = "sub-col-status status-success";
          }
        } else {
          throw new Error("Timeline insertion failed");
        }
      }
    } catch (e: any) {
      console.error("[generateSubtitles] 失败:", e);
      const errMsg = (e && (e.message || e.stack)) || String(e);
      item.status = "失败";
      item.error = errMsg;
      if (statusCol) {
        statusCol.innerText = "失败";
        statusCol.className = "sub-col-status status-error";
        statusCol.setAttribute("title", errMsg);
      }
      showToast(`第 ${item.id} 条失败，已中止剩余配音：${errMsg}`, "error");
      // 失败即中止，避免后续字幕继续发请求
      break;
    }
  }

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

// 初始化弹窗关闭按钮事件（只需绑定一次）
initDialogs();

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
