// @ts-ignore
import uxp from "uxp";
// @ts-ignore
import * as pako from "pako";

declare const require: any;
const ppro = require("premierepro");

export interface SubtitleItem {
  id: number;
  text: string;
  start: number;      // 开始时间（秒）
  end: number;        // 结束时间（秒）
  duration: number;   // 时长（秒）
  status?: string;    // 状态
  error?: string;
  audioPath?: string;
}

export interface TrackInfo {
  index: number;
  name: string;
}

export interface ProjectSummary {
  projectName: string;
  sequenceName: string;
  fps: number;
  audioTracks: TrackInfo[];
  captionTracks: TrackInfo[];
}

/**
 * 把 Uint8Array 按 UTF-8 解码为字符串。
 * UXP 运行时不提供全局 TextDecoder，需要自己实现 UTF-8 解码。
 * 该实现支持 1~4 字节的 UTF-8 编码（含中文）。
 */
function decodeUtf8(bytes: Uint8Array): string {
  let i = 0;
  const len = bytes.length;
  // 用 chunk 拼接提升性能（避免每个字符都做字符串拼接）
  const chunks: string[] = [];
  let chunk = "";
  let chunkSize = 0;
  const CHUNK_LIMIT = 4096;

  const flush = () => {
    if (chunk) {
      chunks.push(chunk);
      chunk = "";
      chunkSize = 0;
    }
  };

  while (i < len) {
    const b1 = bytes[i++];
    let codePoint: number;

    if (b1 < 0x80) {
      // 1 字节：ASCII
      codePoint = b1;
    } else if (b1 < 0xc0) {
      // 非法起始字节（延续字节），用替换字符
      codePoint = 0xfffd;
    } else if (b1 < 0xe0) {
      // 2 字节
      if (i + 1 > len) { codePoint = 0xfffd; i = len; }
      else {
        const b2 = bytes[i++];
        codePoint = ((b1 & 0x1f) << 6) | (b2 & 0x3f);
      }
    } else if (b1 < 0xf0) {
      // 3 字节（常见中文）
      if (i + 2 > len) { codePoint = 0xfffd; i = len; }
      else {
        const b2 = bytes[i++];
        const b3 = bytes[i++];
        codePoint = ((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      }
    } else if (b1 < 0xf8) {
      // 4 字节（emoji 等）
      if (i + 3 > len) { codePoint = 0xfffd; i = len; }
      else {
        const b2 = bytes[i++];
        const b3 = bytes[i++];
        const b4 = bytes[i++];
        codePoint = ((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f);
      }
    } else {
      codePoint = 0xfffd;
    }

    // 处理超出 BMP 的码点（需要用代理对）
    if (codePoint > 0xffff) {
      // 转为 UTF-16 代理对
      const offset = codePoint - 0x10000;
      const high = 0xd800 + (offset >> 10);
      const low = 0xdc00 + (offset & 0x3ff);
      chunk += String.fromCharCode(high, low);
      chunkSize += 2;
    } else {
      chunk += String.fromCharCode(codePoint);
      chunkSize += 1;
    }

    if (chunkSize >= CHUNK_LIMIT) {
      flush();
    }
  }
  flush();
  return chunks.join("");
}

/**
 * Base64 解码器（UXP 运行时不保证提供全局 atob）。
 * 将 base64 字符串解码为 Uint8Array。
 */
function base64Decode(b64: string): Uint8Array {
  // 清理：去除换行/空格
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  const lookup = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookupMap: Record<string, number> = {};
  for (let i = 0; i < lookup.length; i++) lookupMap[lookup[i]] = i;

  const len = clean.length;
  // 计算输出字节长度
  const padding = clean.endsWith("==") ? 2 : (clean.endsWith("=") ? 1 : 0);
  const byteLen = (len * 3) / 4 - padding;
  const result = new Uint8Array(byteLen);

  let outIdx = 0;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < len; i++) {
    const ch = clean[i];
    if (ch === "=") break;
    const val = lookupMap[ch];
    if (val === undefined) continue;
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      result[outIdx++] = (buffer >> bits) & 0xff;
    }
  }
  return result;
}

/**
 * PR 的 tick 基准：1 秒 = 254016000000 ticks（PR 全局固定常量）。
 * .prproj 中 <Start>/<End> 的值就是 ticks。
 */
const PR_TICKS_PER_SECOND = 254016000000;

function ticksToSeconds(ticks: number): number {
  if (!ticks || ticks < 0) return 0;
  return ticks / PR_TICKS_PER_SECOND;
}

/**
 * 从一个 FormattedTextData 的二进制数据中提取字幕文字。
 *
 * 已分析出的二进制结构（PR 2024/2025 实测）：
 *   ... [字体名 UTF-8] 00 00 00 01 00 00 00 0C 00 00 00 08 00 0C 00 04 00 08 00 08 00 00 00 08 00 00 00 [总长 LE32] [字幕UTF8长度 LE32] [字幕 UTF-8 字节] ...
 *
 * 关键稳定特征：字幕 UTF-8 字节紧随在一个 LE32 长度前缀之后，
 * 且该长度前缀之前 8 字节固定为 `08 00 00 00 08 00 00 00`（两个 LE32 = 8, 8）。
 *
 * 扫描策略：在二进制中查找所有 `08 00 00 00 08 00 00 00` 出现位置，
 * 取其后第 8 字节起的 LE32 作为字幕长度，再读取对应字节并按 UTF-8 解码。
 *
 * @returns 提取到的字幕文字（可能为空字符串）
 */
function extractSubtitleFromBinary(bytes: Uint8Array): string {
  // 模式：08 00 00 00 08 00 00 00 <总长 4B> <字幕长度 4B> <字幕字节>
  // 扫描所有匹配位置，返回第一个能成功解码出非空字幕文字的结果
  for (let i = 0; i + 16 <= bytes.length; i++) {
    // 检查 8 字节固定模式 08 00 00 00 08 00 00 00
    if (bytes[i] !== 0x08 || bytes[i + 1] !== 0x00 || bytes[i + 2] !== 0x00 || bytes[i + 3] !== 0x00) continue;
    if (bytes[i + 4] !== 0x08 || bytes[i + 5] !== 0x00 || bytes[i + 6] !== 0x00 || bytes[i + 7] !== 0x00) continue;

    // 跳过固定的 8 字节模式 + 4 字节总长度
    const subLenOffset = i + 12;
    if (subLenOffset + 4 > bytes.length) continue;

    // 读取字幕长度（LE32）
    const subLen =
      bytes[subLenOffset] |
      (bytes[subLenOffset + 1] << 8) |
      (bytes[subLenOffset + 2] << 16) |
      (bytes[subLenOffset + 3] << 24);

    // 合理性校验：字幕长度应在 1~8192 之间
    if (subLen <= 0 || subLen > 8192) continue;

    const subStart = subLenOffset + 4;
    if (subStart + subLen > bytes.length) continue;

    // 提取字幕字节并按 UTF-8 解码
    const subBytes = bytes.subarray(subStart, subStart + subLen);
    const text = decodeUtf8(subBytes);

    // 过滤掉纯空白或明显非字幕内容
    if (text && text.trim().length > 0) {
      return text;
    }
  }
  return "";
}

export class PremiereAdapter {
  /**
   * 每个 Sequence（按 guid）记住「默默配音」目标音频轨索引，避免批量配音时每条音频都新建一条轨道。
   * PR 的音频轨在 UI 上不允许重命名（都是 A1/A2/A3...），所以无法靠名称识别，只能靠会话内记忆。
   */
  private momoTrackBySeqGuid = new Map<string, number>();

  /**
   * 确保项目中存在名为「momo-Voicesub」的素材箱（Bin），存在则返回，不存在则创建。
   *
   * UXP API 要点：
   * - 用 project.getRootItem() 获取根 Bin
   * - 用 await folderItem.getItems() 获取子项列表
   * - 用 ppro.FolderItem.cast(item) 判断是否为 Bin
   * - 用 rootItem.createBinAction(name, makeUnique) 创建子 Bin，必须在 executeTransaction 中执行
   */
  private async ensureMomoBin(project: any): Promise<any> {
    const rootItem = await project.getRootItem();
    if (!rootItem) {
      throw new Error("无法获取项目根 Bin");
    }

    // 查找已有的「momo-Voicesub」Bin
    const findMomoBin = async (folder: any): Promise<any | null> => {
      let items: any[] = [];
      try {
        items = await folder.getItems();
      } catch (e) {
        console.error("[Momo] getItems() failed while finding momo bin:", e);
        return null;
      }
      for (const item of items) {
        if (!item) continue;
        const folderItem = ppro.FolderItem ? ppro.FolderItem.cast(item) : null;
        if (folderItem && item.name === "momo-Voicesub") {
          return item;
        }
      }
      return null;
    };

    const existing = await findMomoBin(rootItem);
    if (existing) return existing;

    // 不存在，创建新 Bin
    let createSuccess = false;
    try {
      project.lockedAccess(() => {
        createSuccess = project.executeTransaction((compoundAction: any) => {
          const createBinAction = rootItem.createBinAction("momo-Voicesub", true);
          compoundAction.addAction(createBinAction);
        }, "Create Momo VoiceSub Bin");
      });
    } catch (e) {
      throw new Error(`创建「momo-Voicesub」素材箱失败: ${this.errMsg(e)}`);
    }
    if (!createSuccess) {
      throw new Error("创建「momo-Voicesub」素材箱失败（事务被拒绝）");
    }

    // 重新查找刚创建的 Bin
    const created = await findMomoBin(rootItem);
    if (!created) {
      throw new Error("创建「momo-Voicesub」素材箱后未能找到它");
    }
    return created;
  }

  /**
   * 获取「momo-Voicesub」素材箱中所有音频素材的文件名集合。
   *
   * 用于缓存管理：
   * - "删除未使用缓存"：删除不在该集合中的缓存文件
   * - "删除当前项目缓存"：删除在该集合中的缓存文件
   *
   * 若素材箱不存在，返回空集合（表示没有缓存被当前项目使用）。
   */
  public async getMomoBinMediaFileNames(): Promise<Set<string>> {
    const project = await ppro.Project.getActiveProject();
    if (!project) return new Set();

    const rootItem = await project.getRootItem();
    if (!rootItem) return new Set();

    // 查找 momo-Voicesub bin（不自动创建）
    let momoBin: any = null;
    try {
      const items = await rootItem.getItems();
      for (const item of items) {
        if (!item) continue;
        const folderItem = ppro.FolderItem ? ppro.FolderItem.cast(item) : null;
        if (folderItem && item.name === "momo-Voicesub") {
          momoBin = item;
          break;
        }
      }
    } catch (_) {}

    if (!momoBin) return new Set();

    const names = new Set<string>();
    const collect = async (binItem: any) => {
      const folderBin = (ppro.FolderItem && ppro.FolderItem.cast(binItem)) || binItem;
      let children: any[] = [];
      try {
        children = await folderBin.getItems();
      } catch (_) { return; }
      for (const child of children) {
        if (!child) continue;
        const clipItem = ppro.ClipProjectItem ? ppro.ClipProjectItem.cast(child) : null;
        if (clipItem) {
          try {
            const name = child.name;
            if (name) {
              names.add(name);
              // 同时添加去掉扩展名的版本，以防 PR 素材名不带扩展名
              const noExt = name.replace(/\.\w+$/, '');
              if (noExt !== name) names.add(noExt);
            }
          } catch (_) {}
        } else {
          const subFolder = ppro.FolderItem ? ppro.FolderItem.cast(child) : null;
          if (subFolder) await collect(subFolder);
        }
      }
    };
    await collect(momoBin);
    return names;
  }

  /**
   * 确保当前序列存在「默默配音」目标音频轨，返回其索引。
   *
   * 策略（PR 音频轨 UI 不允许重命名，都是 A1/A2/A3...，所以靠会话内 Map 记忆）：
   * 1. 用 sequence.guid 作为 key 查 Map，命中且轨道仍存在则返回
   * 2. 扫描所有音频轨，若有名为「默默配音」的（API 重命名在 26.3+ 可能生效），记住并返回
   * 3. 否则目标索引 = 当前音频轨数（createOverwriteItemAction 传入该值会自动新建一条 A{N+1}），记住并返回
   *
   * 这样在单次会话内，批量配音只会新建一条轨道，所有音频都插入到这条轨道上。
   */
  public async ensureTargetAudioTrack(): Promise<number> {
    const project = await ppro.Project.getActiveProject();
    if (!project) throw new Error("ensureTargetAudioTrack: 当前没有打开的 Premiere Pro 项目");
    const sequence = await project.getActiveSequence();
    if (!sequence) throw new Error("ensureTargetAudioTrack: 当前没有激活的时间线序列");

    const seqGuid = String(sequence.guid || "");
    const audioCount = await sequence.getAudioTrackCount();

    // 1. 会话内记忆
    // 注意：不检查 remembered < audioCount，因为 createOverwriteItemAction 传入
    // 大于等于当前轨道数的索引时，PR 会自动新建轨道。插入失败后轨道可能尚未创建，
    // 但目标索引仍然有效，无需重新计算。
    const remembered = this.momoTrackBySeqGuid.get(seqGuid);
    if (remembered !== undefined && remembered >= 0) {
      return remembered;
    }

    // 2. 检查是否有名为「默默配音」的轨道（万一 API 重命名生效了）
    for (let i = 0; i < audioCount; i++) {
      const track = await sequence.getAudioTrack(i);
      if (track && track.name === "默默配音") {
        this.momoTrackBySeqGuid.set(seqGuid, i);
        return i;
      }
    }

    // 3. 用 audioCount 作为目标索引（PR 会自动新建 A{audioCount+1}）
    const newTrackIndex = audioCount;
    this.momoTrackBySeqGuid.set(seqGuid, newTrackIndex);
    console.log(`[Momo] 将为序列「${sequence.name}」新建音频轨 A${newTrackIndex + 1}（索引 ${newTrackIndex}）`);
    return newTrackIndex;
  }
  /**
   * 获取当前活动的项目、序列、帧率以及音轨/字幕轨列表
   */
  public async getSummary(): Promise<ProjectSummary | null> {
    try {
      const project = await ppro.Project.getActiveProject();
      if (!project) return null;

      const sequence = await project.getActiveSequence();
      if (!sequence) {
        return {
          projectName: project.name || "未命名项目",
          sequenceName: "无活动序列",
          fps: 24,
          audioTracks: [],
          captionTracks: []
        };
      }

      // 获取帧率
      let fps = 24;
      try {
        const settings = await sequence.getSettings();
        const frameRate = settings.getVideoFrameRate();
        if (frameRate && frameRate.value) {
          fps = Math.round(frameRate.value);
        }
      } catch (_) {}

      // 音频轨列表
      const audioTracks: TrackInfo[] = [];
      const audioCount = await sequence.getAudioTrackCount();
      for (let i = 0; i < audioCount; i++) {
        const track = await sequence.getAudioTrack(i);
        if (track) {
          audioTracks.push({ index: i, name: track.name || `音频轨 ${i + 1}` });
        }
      }

      // 字幕轨列表
      const captionTracks: TrackInfo[] = [];
      const captionCount = await sequence.getCaptionTrackCount();
      for (let i = 0; i < captionCount; i++) {
        const track = await sequence.getCaptionTrack(i);
        if (track) {
          captionTracks.push({ index: i, name: track.name || `字幕轨 ${i + 1}` });
        }
      }

      return {
        projectName: project.name || "未命名项目",
        sequenceName: sequence.name || "未命名序列",
        fps,
        audioTracks,
        captionTracks
      };
    } catch (e) {
      console.error("Failed to get PR summary:", e);
      return null;
    }
  }

  /**
   * 保存当前项目到磁盘
   * @returns Promise<boolean> 保存成功返回 true，失败返回 false
   */
  public async saveProject(): Promise<boolean> {
    try {
      const project = await ppro.Project.getActiveProject();
      if (!project) {
        console.warn("[Momo] No active project to save");
        return false;
      }

      const result = await project.save();
      if (result) {
        console.log("[Momo] Project saved successfully");
      } else {
        console.warn("[Momo] Project save returned false");
      }
      return result;
    } catch (e) {
      console.error("[Momo] Failed to save project:", e);
      return false;
    }
  }

  /**
   * 读取 PR 的 .prproj 项目文件，同时提取字幕的时间位置和文字内容。
   *
   * 背景：PR UXP API 的 CaptionTrack 类不提供读取字幕文字内容的方法，
   * getName() 返回内部类名 "SyntheticCaption"。FCPXML 导出也不含字幕文字。
   * 而 PR 的 .prproj 项目文件是 XML 格式（可能 gzip 压缩），包含完整的字幕数据，
   * 因此读取 .prproj 是获取字幕文字的可靠方案。
   *
   * .prproj 中字幕的存储结构（PR 2024/2025 实测）：
   *   <CaptionDataClipTrackItem ObjectID="N" ...>
   *     <DataClipTrackItem><ClipTrackItem><TrackItem Version="4">
   *       <Start>ticks</Start>   <- 开始时间（ticks，1秒=254016000000）
   *       <End>ticks</End>         <- 结束时间
   *     </TrackItem></ClipTrackItem></DataClipTrackItem>
   *     <BlockVector Version="1">
   *       <BlockVectorItem Index="0" ObjectRef="M"/>  <- 引用下面的 Block
   *     </BlockVector>
   *   </CaptionDataClipTrackItem>
   *   ...
   *   <Block ObjectID="M" ClassID="d3782b80-..." Version="1">
   *     <FormattedTextData Encoding="base64" ...>base64数据</FormattedTextData>
   *   </Block>
   *
   * base64 解码后的二进制中，字幕 UTF-8 文字前有固定模式
   * `08 00 00 00 08 00 00 00 <总长LE32> <字幕长度LE32>`（见 extractSubtitleFromBinary）。
   *
   * @param captionTrackIndex 目标字幕轨索引（用于筛选对应 DataTrackGroup 中的轨道）
   * @returns 完整的字幕项列表（含时间与文字）
   */
  private async tryLoadFromProjectFile(captionTrackIndex: number): Promise<SubtitleItem[]> {
    try {
      const project = await ppro.Project.getActiveProject();
      if (!project) return [];

      const projectPath = (project as any).path;
      if (!projectPath) {
        console.warn("[Momo] Project path is empty, cannot read .prproj");
        return [];
      }

      console.log("[Momo] Reading project file:", projectPath);

      const xmlText = await this.readPrprojXmlText(projectPath);
      if (!xmlText) return [];

      // 保存 dump 供诊断
      try {
        const dataFolder = await uxp.storage.localFileSystem.getDataFolder();
        const dumpFile = await dataFolder.createEntry("momo_prproj_dump.xml", { overwrite: true });
        await dumpFile.write(xmlText, { format: uxp.storage.formats.utf8 });
        console.log("[Momo] PRPROJ DUMP saved to:", dumpFile.nativePath);
      } catch (dumpErr: any) {
        console.error("[Momo] PRPROJ DUMP save failed:", dumpErr?.message || dumpErr);
      }

      // 解析字幕项（时间 + 文字）
      const items = this.parseSubtitlesFromPrprojXml(xmlText, captionTrackIndex);
      console.log(`[Momo] Extracted ${items.length} caption items from .prproj`);

      return items;
    } catch (e: any) {
      console.error("[Momo] Read project file failed:", e?.message || e);
      return [];
    }
  }

  /**
   * 读取 .prproj 文件并返回解压后的 XML 文本。
   * 支持 gzip 压缩格式，使用 UXP localFileSystem 读取避免路径兼容性问题。
   */
  private async readPrprojXmlText(projectPath: string): Promise<string | null> {
    // 用 UXP localFileSystem 通过 file: URL 获取文件对象
    // 这样避免了 require('fs') 对 Windows \\?\ 前缀路径的兼容性问题
    let fileObj: any = null;
    try {
      // 清理 Windows 扩展路径前缀 \\?\
      const cleanPath = String(projectPath).replace(/^\\\\\?\\/, "");
      // 转为 file: URL（路径分隔符统一为正斜杠）
      const fileUrl = "file://" + cleanPath.replace(/\\/g, "/");
      fileObj = await uxp.storage.localFileSystem.getEntryWithUrl(fileUrl);
    } catch (getEntryErr: any) {
      console.warn("[Momo] getEntryWithUrl failed, trying fs.readFileSync fallback:", getEntryErr?.message || getEntryErr);
    }

    let arrayBuffer: ArrayBuffer;
    if (fileObj && fileObj.isFile) {
      // 用 UXP 文件 API 读取二进制
      try {
        arrayBuffer = await fileObj.read({ format: uxp.storage.formats.binary });
      } catch (readErr: any) {
        console.error("[Momo] UXP file.read(binary) failed:", readErr?.message || readErr);
        return null;
      }
    } else {
      // 兜底：用 require('fs') 同步读取
      console.log("[Momo] Falling back to require('fs') for reading .prproj");
      const fs = require('fs');
      let rawData: any;
      try {
        const cleanPath = String(projectPath).replace(/^\\\\\?\\/, "");
        rawData = fs.readFileSync(cleanPath);
      } catch (readErr: any) {
        console.error("[Momo] Failed to read .prproj file via fs:", readErr?.message || readErr);
        return null;
      }
      if (rawData instanceof ArrayBuffer) {
        arrayBuffer = rawData;
      } else if (rawData instanceof Uint8Array) {
        arrayBuffer = rawData.buffer.slice(rawData.byteOffset, rawData.byteOffset + rawData.byteLength);
      } else if (rawData && typeof rawData === 'object' && 'buffer' in rawData) {
        // Node.js Buffer
        const u8 = new Uint8Array(rawData);
        arrayBuffer = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      } else {
        arrayBuffer = new ArrayBuffer(0);
      }
    }

    const bytes = new Uint8Array(arrayBuffer);
    console.log(`[Momo] .prproj file size: ${bytes.length} bytes`);

    // 检测 gzip (magic bytes 0x1f 0x8b)
    let xmlBytes: Uint8Array;
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      // gzip 压缩，用 pako 解压
      xmlBytes = pako.inflate(bytes);
      console.log("[Momo] .prproj is gzip-compressed, decompressed successfully.");
    } else {
      // 未压缩
      xmlBytes = bytes;
      console.log("[Momo] .prproj is uncompressed XML.");
    }

    // 用自实现的 UTF-8 解码器转为字符串（UXP 无全局 TextDecoder）
    const xmlText = decodeUtf8(xmlBytes);
    console.log(`[Momo] .prproj XML size: ${xmlText.length} chars`);
    return xmlText;
  }

  /**
   * 从 .prproj XML 文本中解析出完整的字幕项（时间 + 文字）。
   *
   * 解析步骤：
   *   1. 找到活动序列对应的所有 CaptionDataClipTrack（按 DataTrackGroup 中的 Track 顺序）
   *   2. 对目标字幕轨，枚举其下的 CaptionDataClipTrackItem
   *   3. 每个 item 的 TrackItem.Start/End 是时间（ticks）
   *   4. 每个 item 的 BlockVectorItem.ObjectRef 指向 Block 对象
   *   5. Block 的 FormattedTextData(base64) 解码后用 extractSubtitleFromBinary 提取文字
   *
   * @param xmlText .prproj 解压后的 XML 文本
   * @param captionTrackIndex 目标字幕轨索引
   */
  private parseSubtitlesFromPrprojXml(xmlText: string, captionTrackIndex: number): SubtitleItem[] {
    // ── 第 1 步：建立 ObjectID -> 元素 XML 的映射 ──
    // 用于通过 BlockVectorItem.ObjectRef="M" / TrackItem.ObjectRef="N" 找到对应元素
    // 注意：只有带 ObjectID 属性的元素才会进入此映射（CaptionDataClipTrack 只有 ObjectUID，不在此映射中）
    const objectById = new Map<string, string>();

    const objectRegex = /<(\w+)\s+ObjectID="(\d+)"[^>]*>([\s\S]*?)<\/\1>/g;
    let objMatch: RegExpExecArray | null;
    while ((objMatch = objectRegex.exec(xmlText)) !== null) {
      const tag = objMatch[1];
      const objId = objMatch[2];
      const inner = objMatch[3];
      objectById.set(objId, `<${tag} ObjectID="${objId}">${inner}</${tag}>`);
    }
    console.log(`[Momo] Parsed ${objectById.size} objects with ObjectID.`);

    // ── 第 2 步：按 ObjectUID 定位所有 CaptionDataClipTrack 的完整 XML ──
    // CaptionDataClipTrack 只有 ObjectUID，没有 ObjectID，需要单独处理
    // 按文件中出现顺序收集（通常与 DataTrackGroup 中 Track 的 Index 顺序一致）
    const captionTrackXmls: string[] = [];
    const ctTrackRegex = /<CaptionDataClipTrack\s+ObjectUID="([^"]+)"[^>]*>([\s\S]*?)<\/CaptionDataClipTrack>/g;
    let ctMatch: RegExpExecArray | null;
    while ((ctMatch = ctTrackRegex.exec(xmlText)) !== null) {
      captionTrackXmls.push(ctMatch[0]);
    }
    console.log(`[Momo] Found ${captionTrackXmls.length} CaptionDataClipTrack(s).`);

    if (captionTrackXmls.length === 0) {
      console.warn("[Momo] No CaptionDataClipTrack found in .prproj");
      return [];
    }

    // 选定目标字幕轨（按索引）；若索引越界，默认取第 0 个
    const targetTrackXml = captionTrackXmls[Math.min(captionTrackIndex, captionTrackXmls.length - 1)];
    console.log(`[Momo] Target caption track #${captionTrackIndex} selected.`);

    // ── 第 3 步：从目标 CaptionDataClipTrack 的 ClipItems 中获取所有 TrackItem 的 ObjectRef ──
    // 结构：<CaptionDataClipTrack ...>...<ClipItems><TrackItems>
    //         <TrackItem Index="0" ObjectRef="64"/>
    //         <TrackItem Index="1" ObjectRef="65"/>
    //         ...
    //       </TrackItems></ClipItems>...</CaptionDataClipTrack>
    // 这些 ObjectRef 指向独立的 <CaptionDataClipTrackItem ObjectID="64" ...> 元素
    const itemIds: string[] = [];
    const trackItemRefRegex = /<TrackItem\s+Index="\d+"\s+ObjectRef="(\d+)"\s*\/>/g;
    let refMatch: RegExpExecArray | null;
    while ((refMatch = trackItemRefRegex.exec(targetTrackXml)) !== null) {
      itemIds.push(refMatch[1]);
    }
    console.log(`[Momo] Target track has ${itemIds.length} CaptionDataClipTrackItem(s).`);

    const items: SubtitleItem[] = [];
    let idCounter = 1;

    for (const itemId of itemIds) {
      // 从 objectById 取出对应的 CaptionDataClipTrackItem
      const itemXml = objectById.get(itemId) || "";
      if (!itemXml) {
        console.warn(`[Momo] CaptionDataClipTrackItem ObjectID=${itemId} not found in object map.`);
        continue;
      }

      // 提取 Start/End（ticks）
      const startMatch = itemXml.match(/<Start>(-?\d+)<\/Start>/i);
      const endMatch = itemXml.match(/<End>(-?\d+)<\/End>/i);
      let startTicks = startMatch ? parseInt(startMatch[1], 10) : 0;
      let endTicks = endMatch ? parseInt(endMatch[1], 10) : 0;
      // 若无 Start，默认 0（第一段从 0 开始）
      if (!startMatch) startTicks = 0;
      if (!endMatch || endTicks < startTicks) {
        // 没有有效 End，给个默认时长（1 秒）
        endTicks = startTicks + PR_TICKS_PER_SECOND;
      }

      const startSec = ticksToSeconds(startTicks);
      const endSec = ticksToSeconds(endTicks);

      // 提取 BlockVectorItem ObjectRef="M" -> Block ObjectID="M" -> FormattedTextData base64
      const blockRefMatch = itemXml.match(/<BlockVectorItem\s+Index="\d+"\s+ObjectRef="(\d+)"/i);
      let text = "";
      if (blockRefMatch) {
        const blockId = blockRefMatch[1];
        const blockXml = objectById.get(blockId) || "";
        // 在 Block 中找 FormattedTextData base64
        const ftdMatch = blockXml.match(/<FormattedTextData\s+Encoding="base64"[^>]*>([A-Za-z0-9+/=\s]*)<\/FormattedTextData>/i);
        if (ftdMatch) {
          const b64 = ftdMatch[1].replace(/\s+/g, "");
          try {
            const binary = base64Decode(b64);
            text = extractSubtitleFromBinary(binary);
          } catch (decodeErr: any) {
            console.warn(`[Momo] Failed to decode FormattedTextData for item ${itemId}:`, decodeErr?.message || decodeErr);
          }
        }
      }

      items.push({
        id: idCounter++,
        text,
        start: startSec,
        end: endSec,
        duration: endSec - startSec,
        status: "待配音"
      });
    }

    items.sort((a, b) => a.start - b.start);
    return items;
  }

  /**
   * 读取指定字幕轨上的所有字幕（含时间位置与文字）。
   *
   * 当前唯一可用方案：读取 .prproj 项目文件。
   * PR UXP API 的 CaptionTrack 类不提供读取字幕文字的方法（getName() 返回 "SyntheticCaption"），
   * FCPXML 导出也不含字幕文字，因此只能直接解析 .prproj。
   *
   * @param captionTrackIndex 目标字幕轨索引
   * @param _fps 保留参数（向后兼容），当前方案不使用，时间由 .prproj 的 ticks 直接换算
   */
  public async loadSubtitlesFromTrack(captionTrackIndex: number, _fps: number = 24): Promise<SubtitleItem[]> {
    const project = await ppro.Project.getActiveProject();
    if (!project) throw new Error("No active project");
    const sequence = await project.getActiveSequence();
    if (!sequence) throw new Error("No active sequence");

    try {
      const items = await this.tryLoadFromProjectFile(captionTrackIndex);
      const textCount = items.filter(i => i.text && i.text.trim().length > 0).length;
      console.log(`[Momo] .prproj: loaded ${items.length} subtitles, ${textCount} with text.`);
      return items;
    } catch (e: any) {
      console.error("[Momo] loadSubtitlesFromTrack failed:", e?.message || e);
      return [];
    }
  }

  /**
   * 解析用户导入的本地 SRT 字幕文件
   */
  public parseSrt(srtContent: string): SubtitleItem[] {
    const items: SubtitleItem[] = [];
    const normalized = srtContent.replace(/\r\n/g, "\n").trim();
    const blocks = normalized.split(/\n\s*\n/);
    let idCounter = 1;

    for (const block of blocks) {
      const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
      if (lines.length < 3) continue;

      const timeLineIndex = lines.findIndex(line => line.includes("-->"));
      if (timeLineIndex === -1) continue;

      const timeStr = lines[timeLineIndex];
      const parts = timeStr.split("-->").map(p => p.trim());
      if (parts.length !== 2) continue;

      const start = this.timeStrToSeconds(parts[0]);
      const end = this.timeStrToSeconds(parts[1]);
      const duration = end - start;

      const text = lines.slice(timeLineIndex + 1).join(" ");

      items.push({
        id: idCounter++,
        text,
        start,
        end,
        duration,
        status: "待配音"
      });
    }

    return items;
  }

  /**
   * 将导入的 SRT 字幕与已有的时间位置字幕按时间匹配合并。
   * 用于「先选字幕轨读到时序，再导入 SRT 补全文字」的场景。
   * 匹配规则：在 1 秒容差内找时间最接近的 SRT 项。
   */
  public mergeSrtWithExisting(existingItems: SubtitleItem[], srtItems: SubtitleItem[]): SubtitleItem[] {
    if (existingItems.length === 0) return srtItems;
    if (srtItems.length === 0) return existingItems;

    return existingItems.map(apiItem => {
      if (apiItem.text && apiItem.text.trim()) return apiItem;

      let bestMatch: SubtitleItem | null = null;
      let bestDiff = Infinity;
      for (const srtItem of srtItems) {
        const diff = Math.abs(srtItem.start - apiItem.start);
        if (diff < bestDiff && diff < 1.0) {
          bestDiff = diff;
          bestMatch = srtItem;
        }
      }
      if (bestMatch && bestMatch.text) {
        return { ...apiItem, text: bestMatch.text };
      }
      return apiItem;
    });
  }

  private timeStrToSeconds(str: string): number {
    const clean = str.replace(",", ".");
    const parts = clean.split(":");
    if (parts.length !== 3) return 0;

    const hrs = parseFloat(parts[0]);
    const mins = parseFloat(parts[1]);
    const secs = parseFloat(parts[2]);

    return hrs * 3600 + mins * 60 + secs;
  }

  /**
   * 将音频覆盖插入到指定的音频轨道索引上。
   * 音频素材会导入到「momo-Voicesub」素材箱（不存在则自动创建）。
   * 成功返回 true；失败抛出带详细原因的 Error，便于上层展示给用户。
   */
  public async insertAudioToTimeline(nativeAudioPath: string, startSeconds: number, targetAudioTrackIndex: number): Promise<boolean> {
    const ctx = "insertAudioToTimeline";
    const project = await ppro.Project.getActiveProject();
    if (!project) throw new Error(`${ctx}: 当前没有打开的 Premiere Pro 项目`);
    const sequence = await project.getActiveSequence();
    if (!sequence) throw new Error(`${ctx}: 当前没有激活的时间线序列`);

    // 确保「momo-Voicesub」素材箱存在，作为导入目标
    const momoBin = await this.ensureMomoBin(project);

    let importSuccess = false;
    try {
      importSuccess = await project.importFiles(
        [nativeAudioPath],
        true,
        momoBin,
        false
      );
    } catch (importErr: any) {
      console.error(`[Momo] ${ctx}: importFiles 抛出异常:`, importErr);
      throw new Error(`${ctx}: 导入音频到项目 Bin 抛出异常: ${this.errMsg(importErr)} (路径: ${nativeAudioPath})`);
    }

    if (!importSuccess) {
      throw new Error(`${ctx}: 导入音频到项目 Bin 失败，路径: ${nativeAudioPath}`);
    }

    // 优先在目标 Bin 中按文件名查找（规避 getMediaFilePath 对中文路径的编码差异问题）
    // importFiles 导入后，素材名通常就是文件名（不含目录）
    const fileName = nativeAudioPath.split(/[\\/]/).pop() || "";
    let importedItem: any = null;
    if (fileName) {
      importedItem = await this.findItemInBinByName(momoBin, fileName);
    }
    // fallback：全项目按路径查找
    if (!importedItem) {
      importedItem = await this.findProjectItemByPath(project, nativeAudioPath);
    }
    if (!importedItem) {
      throw new Error(`${ctx}: 导入后未能在项目 Bin 中找到对应素材: ${nativeAudioPath}`);
    }

    const sequenceEditor = ppro.SequenceEditor.getEditor(sequence);
    const insertTime = ppro.TickTime.createWithSeconds(startSeconds);

    let success = false;
    let txnErr: any = null;
    await project.lockedAccess(() => {
      try {
        const overwriteAction = sequenceEditor.createOverwriteItemAction(
          importedItem,
          insertTime,
          0, // videoTrackIndex：音频文件无视频分量，传 0（UXP 不接受 -1）
          targetAudioTrackIndex
        );

        success = project.executeTransaction((compoundAction: any) => {
          compoundAction.addAction(overwriteAction);
        }, "Momo VoiceSub Overwrite Audio");
      } catch (e) {
        txnErr = e;
      }
    });

    if (txnErr) {
      throw new Error(`${ctx}: 创建/执行覆盖插入动作失败: ${this.errMsg(txnErr)}`);
    }
    if (!success) {
      throw new Error(`${ctx}: 事务提交被拒绝（可能由于轨道索引越界或素材不可用），目标音轨索引=${targetAudioTrackIndex}，插入时间=${startSeconds}s`);
    }
    return success;
  }

  /**
   * 自动模式：确保目标音频轨存在，然后把音频插入到该轨道上。
   *
   * PR 的音频轨在 UI 上不允许重命名（都是 A1/A2/A3...），所以无法靠名称识别「我们的轨道」。
   * 本方法靠会话内 Map 记忆目标轨道索引，确保单次会话内只新建一条轨道，后续音频都插入同一条。
   * 音频素材会导入到「momo-Voicesub」素材箱（不存在则自动创建）。
   *
   * @param nativeAudioPath WAV音频的本地全路径
   * @param startSeconds 插入时间点（秒）
   */
  public async insertAudioToTimelineAutoTrack(nativeAudioPath: string, startSeconds: number): Promise<boolean> {
    const targetTrackIndex = await this.ensureTargetAudioTrack();
    return await this.insertAudioToTimeline(nativeAudioPath, startSeconds, targetTrackIndex);
  }

  /**
   * 在指定 Bin 中按素材名（文件名）递归查找 ProjectItem。
   *
   * 比 findProjectItemByPath 更可靠：后者依赖 getMediaFilePath() 返回的路径与传入路径完全一致，
   * 但 PR API 对中文路径的编码处理可能不一致，导致路径比较失败。
   * 素材名通常就是文件名（不含目录），按名称查找可规避此问题。
   */
  private async findItemInBinByName(binItem: any, targetName: string): Promise<any | null> {
    if (!targetName) return null;
    // 入参 binItem 可能是未转型的 ProjectItem（如 ensureMomoBin 返回的项），
    // ProjectItem 基类没有 getItems() 方法，需要先 cast 为 FolderItem。
    const folderBin = (ppro.FolderItem && ppro.FolderItem.cast(binItem)) || binItem;
    let children: any[] = [];
    try {
      children = await folderBin.getItems();
    } catch (e) {
      console.error("[Momo] getItems() failed while finding by name:", e);
      return null;
    }

    // 去掉扩展名后的目标名（PR 有时不带 .wav 扩展名显示素材名）
    const targetNameNoExt = targetName.replace(/\.\w+$/, "");

    for (const child of children) {
      if (!child) continue;
      const clipItem = ppro.ClipProjectItem ? ppro.ClipProjectItem.cast(child) : null;
      if (clipItem) {
        try {
          const childName = child.name;
          if (childName === targetName || childName === targetNameNoExt) {
            return child;
          }
        } catch (_) {}
      } else {
        const folderItem = ppro.FolderItem ? ppro.FolderItem.cast(child) : null;
        if (folderItem) {
          const found = await this.findItemInBinByName(folderItem, targetName);
          if (found) return found;
        }
      }
    }

    // 调试日志：查找失败时打印 Bin 中所有素材名，方便诊断
    const allNames = children
      .filter(c => c)
      .map(c => { try { return c.name; } catch (_) { return "?"; } })
      .filter(n => n);
    console.warn(`[Momo] findItemInBinByName: 未找到「${targetName}」，Bin 中现有素材: [${allNames.join(", ")}]`);

    return null;
  }

  /**
   * 在项目 Bin 中递归查找匹配本地路径的 ProjectItem
   *
   * UXP API 注意事项：
   * - 必须使用 project.getRootItem() 方法（而非 project.rootItem 属性，后者在 UXP 中不存在）
   * - 必须使用 await folderItem.getItems() 方法获取子项（而非 folderItem.children.numItems / getItemAt(i)，那是 CEP 旧 API）
   * - 必须使用 ppro.ClipProjectItem.cast(item) / ppro.FolderItem.cast(item) 判断类型（而非 child.type === 1/2）
   */
  private async findProjectItemByPath(project: any, targetPath: string): Promise<any | null> {
    const root = await project.getRootItem();
    if (!root) return null;
    return await this.searchBinForItem(root, targetPath);
  }

  private async searchBinForItem(binItem: any, targetPath: string): Promise<any | null> {
    const normalizedTarget = this.normalizePath(targetPath);
    let children: any[] = [];
    try {
      children = await binItem.getItems();
    } catch (e) {
      console.error("[Momo] getItems() failed for bin:", e);
      return null;
    }

    for (const child of children) {
      if (!child) continue;

      // 优先用 ClipProjectItem.cast 判断是否为素材
      const clipItem = ppro.ClipProjectItem ? ppro.ClipProjectItem.cast(child) : null;
      if (clipItem) {
        try {
          // PR API 正确方法名是 getMediaFilePath（不是 getMediaPath），返回 Promise<string>
          const mediaPath: string = await clipItem.getMediaFilePath();
          if (mediaPath && this.normalizePath(mediaPath) === normalizedTarget) {
            return child;
          }
        } catch (e) {
          // 单个素材读取失败不应中断整个查找（例如离线素材）
          console.error("[Momo] getMediaFilePath failed for bin item:", e);
        }
      } else {
        // 否则尝试作为 FolderItem 递归
        const folderItem = ppro.FolderItem ? ppro.FolderItem.cast(child) : null;
        if (folderItem) {
          const found = await this.searchBinForItem(folderItem, targetPath);
          if (found) return found;
        }
      }
    }
    return null;
  }

  private normalizePath(p: string): string {
    if (!p) return "";
    // 清理 Windows 扩展路径前缀 \\?\ （PR API 返回的路径可能带此前缀，UXP 存储返回的不带）
    let cleaned = String(p).replace(/^\\\\\?\\/, "");
    // 统一路径分隔符并小写化，便于跨来源比较
    return cleaned.replace(/\\/g, "/").toLowerCase();
  }

  private errMsg(e: any): string {
    if (!e) return String(e);
    if (e instanceof Error) return e.message || e.stack || String(e);
    if (typeof e === "string") return e;
    try {
      return JSON.stringify(e);
    } catch (_) {
      return String(e);
    }
  }
}
