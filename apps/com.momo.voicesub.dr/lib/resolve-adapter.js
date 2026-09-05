'use strict';

const fs = (() => {
  try { return require('fs/promises'); } catch (_) {
    const _fs = require('fs');
    const { promisify } = require('util');
    return {
      readFile: promisify(_fs.readFile),
      writeFile: promisify(_fs.writeFile),
      mkdir: promisify(_fs.mkdir),
      readdir: promisify(_fs.readdir),
      rm: promisify(_fs.rm),
      rmdir: promisify(_fs.rmdir),
      copyFile: promisify(_fs.copyFile),
      stat: promisify(_fs.stat),
    };
  }
})();
const path = require('path');
const { currentTimecodeToRecordFrame, parseTimelineFrameRate } = require('./timecode');
const { sha1 } = require('./azure-tts');

const TARGET_TRACK_NAME = 'momoVoicesub';
const CLIP_SUFFIX = '_momo';
const MEDIAPOOL_FOLDER_NAME = 'momo-Voicesub';
const TEXT_PREVIEW_LENGTH = 28;

function sanitizeName(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|#%&{}$!'@+`=]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

function textPreview(value, limit = TEXT_PREVIEW_LENGTH) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  if (!compact) return 'empty';
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

/**
 * 将 SRT 时间码（HH:MM:SS,mmm 或 HH:MM:SS.mmm）转换为秒（浮点数）。
 * 解析失败返回 NaN，由调用方判断。
 */
function srtTimeToSeconds(str) {
  const clean = String(str || '').trim().replace(',', '.');
  const parts = clean.split(':');
  if (parts.length !== 3) return NaN;
  const hrs = parseFloat(parts[0]);
  const mins = parseFloat(parts[1]);
  const secs = parseFloat(parts[2]);
  if (!Number.isFinite(hrs) || !Number.isFinite(mins) || !Number.isFinite(secs)) return NaN;
  return hrs * 3600 + mins * 60 + secs;
}

function isMomoClipName(value) {
  return String(value || '').endsWith(CLIP_SUFFIX);
}

async function voiceDisplayName(settingsStore, voiceShortName) {
  const settings = await settingsStore.load();
  let voice = (settings.voices || []).find((item) => item.shortName === voiceShortName);
  if (!voice && settings.localTts?.voices) {
    const lv = settings.localTts.voices.find(v => v.id === voiceShortName);
    if (lv) {
      voice = { localName: lv.name, displayName: lv.name };
    }
  }
  return sanitizeName(voice?.localName || voice?.displayName || voiceShortName || 'voice');
}

class ResolveAdapter {
  constructor({ getResolve, ttsProvider, settingsStore, appDataDir }) {
    this.getResolve = getResolve;
    this.ttsProvider = ttsProvider;
    this.settingsStore = settingsStore;
    this.appDataDir = appDataDir;
    this.importedAudioItems = new Map();
    this.importCounter = 0;
  }

  async getContext() {
    const resolve = await this.getResolve();
    if (!resolve) throw new Error('无法连接 DaVinci Resolve。请确认 Resolve Studio 已正常打开。');

    const projectManager = await resolve.GetProjectManager();
    const project = projectManager ? await projectManager.GetCurrentProject() : null;
    if (!project) throw new Error('当前没有打开项目。请先打开或创建一个项目。');

    const mediaPool = await project.GetMediaPool();
    const mediaStorage = await resolve.GetMediaStorage();

    const timeline = await project.GetCurrentTimeline();
    if (!timeline) throw new Error('当前项目没有选中的时间线。请先创建并打开一条时间线。');

    return { resolve, project, timeline, mediaPool, mediaStorage };
  }

  async getProjectContext() {
    const resolve = await this.getResolve();
    if (!resolve) throw new Error('无法连接 DaVinci Resolve。请确认 Resolve Studio 已正常打开。');

    const projectManager = await resolve.GetProjectManager();
    const project = projectManager ? await projectManager.GetCurrentProject() : null;
    if (!project) throw new Error('当前没有打开项目。请先打开或创建一个项目。');

    const mediaPool = await project.GetMediaPool();
    const mediaStorage = await resolve.GetMediaStorage();
    return { resolve, project, mediaPool, mediaStorage };
  }

  async getSummary() {
    try {
      const { project, timeline } = await this.getContext();
      return {
        ok: true,
        projectName: await project.GetName(),
        timelineName: await timeline.GetName(),
        subtitleTracks: await this.listSubtitleTracks(),
        audioTracks: await this.listAudioTracks()
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async listSubtitleTracks() {
    const { timeline } = await this.getContext();
    const count = Number(await timeline.GetTrackCount('subtitle')) || 0;
    const tracks = [];
    for (let index = 1; index <= count; index += 1) {
      const items = await timeline.GetItemListInTrack('subtitle', index) || [];
      tracks.push({
        index,
        name: await timeline.GetTrackName('subtitle', index) || `Subtitle ${index}`,
        itemCount: items.length
      });
    }
    return tracks;
  }

  async listAudioTracks() {
    const { timeline } = await this.getContext();
    const count = Number(await timeline.GetTrackCount('audio')) || 0;
    const tracks = [];
    for (let index = 1; index <= count; index += 1) {
      tracks.push({
        index,
        name: await timeline.GetTrackName('audio', index) || `Audio ${index}`,
        subtype: await timeline.GetTrackSubType('audio', index)
      });
    }
    return tracks;
  }

  async ensureTargetAudioTrack(preferredIndex) {
    const { timeline } = await this.getContext();
    if (preferredIndex && preferredIndex !== 'auto') {
      const idx = Number(preferredIndex);
      const count = Number(await timeline.GetTrackCount('audio')) || 0;
      if (idx < 1 || idx > count) {
        throw new Error(`音频轨道 ${idx} 不存在。当前时间线共有 ${count} 条音频轨道，请刷新状态后重新选择目标轨道。`);
      }
      return idx;
    }

    let count = Number(await timeline.GetTrackCount('audio')) || 0;
    for (let index = 1; index <= count; index += 1) {
      if ((await timeline.GetTrackName('audio', index)) === TARGET_TRACK_NAME) {
        return index;
      }
    }

    const added = await timeline.AddTrack('audio', 'mono');
    if (!added) throw new Error('Failed to add target audio track');
    count = Number(await timeline.GetTrackCount('audio')) || count + 1;
    await timeline.SetTrackName('audio', count, TARGET_TRACK_NAME);
    return count;
  }

  async getTimelineFps(project) {
    const rate = parseTimelineFrameRate(await project.GetSetting('timelineFrameRate'));
    return rate.fps;
  }

  /**
   * 获取当前项目的缓存目录（{cacheDir}/{projectName}/）。
   *
   * 不同工程的缓存完全隔离：
   * - 避免 hash 冲突时误删其他工程的缓存（两个工程有同一句字幕+同一音色时，
   *   hash 相同、文件名相同，若共用目录会互相覆盖/误删）。
   * - "删除当前工程缓存"只删除当前项目子目录，不影响其他工程。
   *
   * 同一项目内不同时间线可以复用缓存（节省 Azure 调用），因为缓存键仅基于
   * 文本+音色+参数，与时间线无关。
   */
  async getProjectCacheDir(project) {
    const projectName = sanitizeName(await project.GetName()) || 'project';
    return path.join(await this.getBaseCacheDir(), projectName);
  }

  async getBaseCacheDir() {
    const settings = await this.settingsStore.load();
    return settings.cacheDir || path.join(this.appDataDir, 'cache');
  }

  normalizeFilePath(filePath) {
    return path.resolve(String(filePath || '')).toLowerCase();
  }

  extractClipFilePaths(properties) {
    if (!properties) return [];
    if (typeof properties === 'string') {
      return /\.(wav|wave|mp3|m4a|aif|aiff)$/i.test(properties) ? [properties] : [];
    }

    const paths = [];
    for (const [key, value] of Object.entries(properties)) {
      if (typeof value !== 'string') continue;
      const keyLooksLikePath = /path|file/i.test(key);
      const valueLooksLikeAudio = /\.(wav|wave|mp3|m4a|aif|aiff)$/i.test(value);
      if (keyLooksLikePath || valueLooksLikeAudio) {
        paths.push(value);
      }
    }
    return paths;
  }

  async readMediaPoolItemPaths(mediaPoolItem) {
    const paths = [];
    if (!mediaPoolItem) return paths;

    if (typeof mediaPoolItem.GetThirdPartyMetadata === 'function') {
      try {
        paths.push(...this.extractClipFilePaths(await mediaPoolItem.GetThirdPartyMetadata()));
      } catch {
        // Some Resolve objects expose the method but still fail for imported media.
      }
    }

    if (typeof mediaPoolItem.GetClipProperty === 'function') {
      try {
        paths.push(...this.extractClipFilePaths(await mediaPoolItem.GetClipProperty()));
      } catch {
        // Keep scanning other clips; cache deletion will become conservative if unresolved.
      }
    }

    return paths;
  }

  async findMediaPoolItemByPath(filePath) {
    const { mediaPool } = await this.getProjectContext();
    const rootFolder = mediaPool && typeof mediaPool.GetRootFolder === 'function'
      ? await mediaPool.GetRootFolder()
      : null;
    if (!rootFolder) return null;

    const targetPath = this.normalizeFilePath(filePath);

    const visit = async (folder) => {
      const clips = typeof folder.GetClipList === 'function' ? await folder.GetClipList() || [] : [];
      for (const clip of clips) {
        const clipPaths = await this.readMediaPoolItemPaths(clip);
        if (clipPaths.some((clipPath) => this.normalizeFilePath(clipPath) === targetPath)) {
          return clip;
        }
      }

      const subFolders = typeof folder.GetSubFolderList === 'function' ? await folder.GetSubFolderList() || [] : [];
      for (const subFolder of subFolders) {
        const found = await visit(subFolder);
        if (found) return found;
      }

      return null;
    };

    return visit(rootFolder);
  }

  async listProjectTimelines(project) {
    const timelineCount = Number(await project.GetTimelineCount()) || 0;
    const timelines = [];
    for (let index = 1; index <= timelineCount; index += 1) {
      const timeline = await project.GetTimelineByIndex(index);
      if (timeline) timelines.push(timeline);
    }
    return timelines;
  }

  async collectUsedCachePaths(projectCacheDir) {
    const { project } = await this.getProjectContext();
    const timelines = await this.listProjectTimelines(project);
    const used = new Set();
    let unresolved = 0;
    const normalizedCacheDir = `${this.normalizeFilePath(projectCacheDir)}${path.sep}`;

    for (const timeline of timelines) {
      const audioTrackCount = Number(await timeline.GetTrackCount('audio')) || 0;
      for (let trackIndex = 1; trackIndex <= audioTrackCount; trackIndex += 1) {
        const items = await timeline.GetItemListInTrack('audio', trackIndex) || [];
        for (const item of items) {
          const itemName = typeof item.GetName === 'function' ? await item.GetName() : '';
          if (!isMomoClipName(itemName)) continue;

          const mediaPoolItem = typeof item.GetMediaPoolItem === 'function' ? await item.GetMediaPoolItem() : null;
          const mediaPaths = await this.readMediaPoolItemPaths(mediaPoolItem);
          let matched = false;

          for (const filePath of mediaPaths) {
            const normalized = this.normalizeFilePath(filePath);
            if (normalized.startsWith(normalizedCacheDir)) {
              used.add(normalized);
              matched = true;
            }
          }

          if (!matched) unresolved += 1;
        }
      }
    }

    return { used, unresolved };
  }

  async listCacheFiles(rootDir, skipPreview = true) {
    const files = [];

    async function visit(dir) {
      if (skipPreview && path.basename(dir) === 'preview') return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(fullPath);
        } else if (entry.isFile() && /\.(wav|wave|mp3|m4a|aif|aiff)$/i.test(entry.name)) {
          files.push(fullPath);
        }
      }
    }

    await visit(rootDir);
    return files;
  }

  async removeEmptyDirs(rootDir) {
    let entries;
    try {
      entries = await fs.readdir(rootDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        await this.removeEmptyDirs(path.join(rootDir, entry.name));
      }
    }

    try {
      const after = await fs.readdir(rootDir);
      if (after.length === 0) {
        await fs.rmdir(rootDir);
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
    }
  }

  async pruneCacheIndexes(rootDir, deletedPaths) {
    const deleted = new Set(deletedPaths.map((filePath) => this.normalizeFilePath(filePath)));

    async function visit(dir) {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(fullPath);
        }
      }

      const indexPath = path.join(dir, 'cache-index.json');
      let index;
      try {
        index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }

      const entriesMap = index.entries || {};
      for (const [key, entry] of Object.entries(entriesMap)) {
        const fileName = entry && entry.fileName;
        if (!fileName) continue;
        if (deleted.has(path.resolve(dir, fileName).toLowerCase())) {
          delete entriesMap[key];
        }
      }

      if (Object.keys(entriesMap).length === 0) {
        await fs.rm(indexPath, { force: true });
      } else {
        index.entries = entriesMap;
        await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
      }
    }

    await visit(rootDir);
  }

  forgetImportedAudioItems(filePaths) {
    for (const filePath of filePaths) {
      this.importedAudioItems.delete(filePath);
    }
  }

  async deleteUnusedCurrentProjectCache() {
    const { project } = await this.getProjectContext();
    const projectCacheDir = await this.getProjectCacheDir(project);
    const cacheFiles = await this.listCacheFiles(projectCacheDir);
    const { used: usedPaths, unresolved } = await this.collectUsedCachePaths(projectCacheDir);
    const deleted = [];
    const kept = [];

    if (unresolved > 0) {
      return {
        scope: 'unused-current-project',
        projectCacheDir,
        scanned: cacheFiles.length,
        deleted: 0,
        kept: cacheFiles.length,
        unresolved,
        conservative: true
      };
    }

    for (const filePath of cacheFiles) {
      if (usedPaths.has(this.normalizeFilePath(filePath))) {
        kept.push(filePath);
        continue;
      }

      await fs.rm(filePath, { force: true });
      deleted.push(filePath);
    }

    await this.pruneCacheIndexes(projectCacheDir, deleted);
    this.forgetImportedAudioItems(deleted);
    await this.removeEmptyDirs(projectCacheDir);
    return {
      scope: 'unused-current-project',
      projectCacheDir,
      scanned: cacheFiles.length,
      deleted: deleted.length,
      kept: kept.length,
      unresolved,
      conservative: false
    };
  }

  async deleteCurrentProjectCache() {
    const { project } = await this.getProjectContext();
    const projectCacheDir = await this.getProjectCacheDir(project);
    const cacheFiles = await this.listCacheFiles(projectCacheDir, false);

    const previewDir = path.join(projectCacheDir, 'preview');

    const toDelete = [];
    for (const entry of await fs.readdir(projectCacheDir, { withFileTypes: true })) {
      if (entry.name === 'preview') continue;
      const fullPath = path.join(projectCacheDir, entry.name);
      toDelete.push(fullPath);
    }

    for (const filePath of toDelete) {
      await fs.rm(filePath, { recursive: true, force: true });
    }

    const remaining = await fs.readdir(projectCacheDir).catch(() => []);
    if (remaining.length === 0) {
      await fs.rm(projectCacheDir, { recursive: true, force: true });
    }

    const nonPreviewFiles = cacheFiles.filter((f) => !f.startsWith(previewDir));
    this.forgetImportedAudioItems(nonPreviewFiles);
    return {
      scope: 'current-project',
      projectCacheDir,
      deleted: nonPreviewFiles.length
    };
  }

  async deleteAllProjectCache() {
    const cacheDir = await this.getBaseCacheDir();
    const cacheFiles = await this.listCacheFiles(cacheDir, false);

    const previewDir = path.join(cacheDir, 'preview');

    const toDelete = [];
    for (const entry of await fs.readdir(cacheDir, { withFileTypes: true })) {
      if (entry.name === 'preview') continue;
      const fullPath = path.join(cacheDir, entry.name);
      toDelete.push(fullPath);
    }

    for (const filePath of toDelete) {
      await fs.rm(filePath, { recursive: true, force: true });
    }

    const remaining = await fs.readdir(cacheDir).catch(() => []);
    if (remaining.length === 0) {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }

    const nonPreviewFiles = cacheFiles.filter((f) => !f.startsWith(previewDir));
    this.importedAudioItems.clear();
    return {
      scope: 'all-projects',
      cacheDir,
      deleted: nonPreviewFiles.length
    };
  }

  async findGeneratedItemsAt(audioTrackIndex, startFrame) {
    const { timeline } = await this.getContext();
    let items;
    try {
      items = await timeline.GetItemListInTrack('audio', audioTrackIndex) || [];
    } catch (e) {
      // DR Workflow Integration API 偶发 "Track with specified index does not exist" 错误，
      // 即使轨道确实存在（GetTrackCount/GetTrackName 可正常返回）。
      // 此处仅为插入前的预检查（查找已生成的 clip 用于 skip/replace），
      // 容错为空数组，让后续 AppendToTimeline 决定真正的成功/失败。
      const msg = String((e && e.message) || '');
      if (/does not exist|errorCode.*8/i.test(msg)) {
        return [];
      }
      throw e;
    }
    const found = [];

    for (const item of items) {
      const name = await item.GetName();
      const start = Math.round(Number(await item.GetStart(false)));
      if (start === Math.round(Number(startFrame)) && isMomoClipName(name)) {
        found.push(item);
      }
    }

    return found;
  }

  async makeImportCopy(filePath, clipName) {
    const dir = path.join(path.dirname(filePath), '_resolve_imports');
    const ext = path.extname(filePath) || '.wav';
    const base = sanitizeName(clipName || path.basename(filePath, ext)) || 'momo_voice';
    this.importCounter += 1;
    const copyPath = path.join(dir, `${base}_${Date.now()}_${this.importCounter}${ext}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(filePath, copyPath);
    return copyPath;
  }

  async ensureMediaPoolFolder(mediaPool) {
    const rootFolder = mediaPool && typeof mediaPool.GetRootFolder === 'function'
      ? await mediaPool.GetRootFolder()
      : null;
    if (!rootFolder) return null;

    // DR API 的 folder.GetName() 返回 Promise，必须 await。
    // Array.find 不支持 async 回调（回调返回 Promise 时永远 truthy），
    // 因此用 for 循环逐个 await 比较。
    const findFolder = async () => {
      const subFolders = typeof rootFolder.GetSubFolderList === 'function'
        ? await rootFolder.GetSubFolderList() || []
        : [];
      for (const f of subFolders) {
        if (typeof f.GetName === 'function') {
          const name = await f.GetName();
          if (name === MEDIAPOOL_FOLDER_NAME) return f;
        }
      }
      return null;
    };

    const existing = await findFolder();
    if (existing) return existing;

    if (mediaPool.AddSubFolder) {
      // AddSubFolder 在同名文件夹已存在时可能返回 null，不依赖返回值，
      // 创建后再次查找确认。
      await mediaPool.AddSubFolder(rootFolder, MEDIAPOOL_FOLDER_NAME);
    }
    return await findFolder();
  }

  async importAudio(filePath, clipName, options = {}) {
    const { mediaPool, mediaStorage } = await this.getProjectContext();
    const cached = this.importedAudioItems.get(filePath);
    if (cached && !options.forceReimport) {
      return cached;
    }

    const targetFolder = await this.ensureMediaPoolFolder(mediaPool);

    // DR 的 AddItemListToMediaPool(filePaths, folder) 第二参数在不同版本中行为不一致，
    // 实际往往将文件导入到「媒体池当前选中的文件夹」而非参数指定的 folder。
    // 首次创建 momo-Voicesub 时 AddSubFolder 会自动切换 currentFolder 到新文件夹，
    // 所以第一次能正确导入；但文件夹已存在时仅返回 folder 对象、不切换 currentFolder，
    // 若用户手动切到了根目录，音频就会导入到根目录。
    // 解决：导入前显式 SetCurrentFolder 到目标文件夹（即用户说的"先打开文件夹再放入"）。
    if (targetFolder && typeof mediaPool.SetCurrentFolder === 'function') {
      try {
        await mediaPool.SetCurrentFolder(targetFolder);
      } catch {
        // 部分 DR 版本可能不支持，忽略后由 AddItemListToMediaPool 的 folder 参数兜底。
      }
    }

    let mediaItems = await mediaStorage.AddItemListToMediaPool([filePath], targetFolder);
    let mediaPoolItem = mediaItems && mediaItems[0];

    if (!mediaPoolItem) {
      mediaPoolItem = await this.findMediaPoolItemByPath(filePath);
    }

    if (!mediaPoolItem) {
      const importCopy = await this.makeImportCopy(filePath, clipName);
      mediaItems = await mediaStorage.AddItemListToMediaPool([importCopy], targetFolder);
      mediaPoolItem = mediaItems && mediaItems[0];
    }

    if (!mediaPoolItem) {
      throw new Error(`导入音频失败：${filePath}`);
    }

    if (typeof mediaPoolItem.SetName === 'function') {
      await mediaPoolItem.SetName(clipName);
    }

    if (typeof mediaPoolItem.SetThirdPartyMetadata === 'function') {
      try {
        await mediaPoolItem.SetThirdPartyMetadata({
          momoVoiceSubCachePath: filePath,
          momoVoiceSubDisplayName: clipName
        });
      } catch {
        // Metadata is a best-effort hint for future cache cleanup.
      }
    }

    this.importedAudioItems.set(filePath, mediaPoolItem);
    return mediaPoolItem;
  }

  async insertAudioFile({ filePath, audioTrackIndex, recordFrame, durationFrames, clipName, overwriteMode = 'skip', forceReimport = false, skipExistingCheck = false }) {
    const { timeline, mediaPool } = await this.getContext();
    // skip 模式在合成前已做过占位检查（避免为已存在的片段白白合成），
    // 传 skipExistingCheck 时不再重复全轨扫描
    const existing = skipExistingCheck
      ? []
      : await this.findGeneratedItemsAt(audioTrackIndex, recordFrame);

    if (existing.length && overwriteMode === 'skip') {
      return { status: 'skipped', reason: 'existing', recordFrame };
    }

    if (existing.length && overwriteMode === 'replace') {
      await timeline.DeleteClips(existing, false);
    }

    const mediaPoolItem = await this.importAudio(filePath, clipName, { forceReimport });
    const sourceFrames = Math.max(1, Math.round(Number(durationFrames)));
    const timelineItems = await mediaPool.AppendToTimeline([{
      mediaPoolItem,
      startFrame: 0,
      endFrame: sourceFrames - 1,
      mediaType: 2,
      trackIndex: Number(audioTrackIndex),
      recordFrame: Math.round(Number(recordFrame))
    }]);

    const timelineItem = timelineItems && timelineItems[0];
    if (!timelineItem) throw new Error('Failed to append audio to timeline');
    if (typeof timelineItem.SetName === 'function') {
      await timelineItem.SetName(clipName);
    }

    return { status: 'inserted', recordFrame, durationFrames: sourceFrames };
  }

  async getSubtitleItems(trackIndex) {
    const { timeline } = await this.getContext();
    const items = await timeline.GetItemListInTrack('subtitle', Number(trackIndex)) || [];
    const result = [];
    for (const item of items) {
      const text = String(await item.GetName() || '').trim();
      const start = Math.round(Number(await item.GetStart(false)));
      const end = Math.round(Number(await item.GetEnd(false)));
      result.push({
        index: result.length,
        text,
        startFrame: start,
        endFrame: end,
        durationFrames: Math.max(1, end - start),
        annotations: []
      });
    }
    return result;
  }

  /**
   * 解析用户导入的本地 SRT 字幕文件内容，返回与 getSubtitleItems 一致结构的字幕项数组。
   *
   * SRT 时间码（HH:MM:SS,mmm）按当前时间线 fps 换算为帧，使得导入的 SRT 字幕
   * 可以与「从字幕轨读取」的字幕项完全等同地用于批量配音生成。
   *
   * @param {string} srtContent SRT 文件文本内容
   * @param {number} fps 当前时间线帧率（来自 getTimelineFps）
   * @returns {Array<{index:number,text:string,startFrame:number,endFrame:number,durationFrames:number,annotations:[]}>}
   */
  parseSrt(srtContent, fps) {
    const items = [];
    const normalized = String(srtContent || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();
    if (!normalized) return items;

    const safeFps = Number(fps) > 0 ? Number(fps) : 24;
    const blocks = normalized.split(/\n\s*\n/);
    let idCounter = 0;

    for (const block of blocks) {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) continue;

      const timeLineIndex = lines.findIndex((line) => line.includes('-->'));
      if (timeLineIndex === -1) continue;

      const timeStr = lines[timeLineIndex];
      const parts = timeStr.split('-->').map((p) => p.trim());
      if (parts.length !== 2) continue;

      const startSec = srtTimeToSeconds(parts[0]);
      const endSec = srtTimeToSeconds(parts[1]);
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec < startSec) continue;

      // SRT 文本可能跨多行，保留换行以兼容多行字幕（合成时会归一化为空格）
      const text = lines.slice(timeLineIndex + 1).join('\n').trim();
      if (!text) continue;

      const startFrame = Math.round(startSec * safeFps);
      const endFrame = Math.max(startFrame + 1, Math.round(endSec * safeFps));

      items.push({
        index: idCounter++,
        text,
        startFrame,
        endFrame,
        durationFrames: Math.max(1, endFrame - startFrame),
        annotations: []
      });
    }

    return items;
  }

  async generateFromSubtitleTrack({ subtitleTrackIndex, audioTrackIndex = 'auto', voiceSettings = {}, overwriteMode = 'skip', subtitleItems }) {
    const { project, timeline } = await this.getContext();
    const targetTrack = await this.ensureTargetAudioTrack(audioTrackIndex);
    const fps = await this.getTimelineFps(project);
    const cacheDir = await this.getProjectCacheDir(project);

    let subtitles;
    if (subtitleItems && subtitleItems.length) {
      subtitles = subtitleItems;
    } else {
      const raw = await timeline.GetItemListInTrack('subtitle', Number(subtitleTrackIndex)) || [];
      const items = [];
      for (const item of raw) {
        items.push({
          text: String(await item.GetName() || '').trim(),
          startFrame: Math.round(Number(await item.GetStart(false))),
          endFrame: Math.round(Number(await item.GetEnd(false))),
          durationFrames: Math.max(1, Math.round(Number(await item.GetEnd(false))) - Math.round(Number(await item.GetStart(false)))),
          annotations: []
        });
      }
      subtitles = items;
    }

    const polyphonicDict = voiceSettings.polyphonicDict;
    const enablePoly = voiceSettings.enablePolyphonic !== false;

    const results = [];
    for (const sub of subtitles) {
      const text = String(sub.text || '').trim();
      if (!text) {
        results.push({ status: 'skipped', reason: 'empty-subtitle' });
        continue;
      }

      // 覆盖策略为「跳过」且该位置已有本插件生成的片段 → 直接跳过，
      // 不调用合成（避免本地重复算 / 云端白烧 token）
      if (overwriteMode === 'skip') {
        const existingClips = await this.findGeneratedItemsAt(targetTrack, sub.startFrame);
        if (existingClips && existingClips.length) {
          results.push({ text, start: sub.startFrame, end: sub.endFrame, status: 'skipped', reason: 'existing-clip' });
          continue;
        }
      }

      const maxFrames = sub.durationFrames;
      const cacheKey = sha1(JSON.stringify({ mode: 'subtitle', text, voiceSettings, annotations: sub.annotations, v: 2 }));
      const speakerName = await voiceDisplayName(this.settingsStore, voiceSettings.voice);
      const clipName = `${sub.startFrame}_${sanitizeName(textPreview(text))}_${speakerName}_momo`;

      const synthOptions = {
        ...voiceSettings,
        text,
        cacheKey,
        timelineFps: fps,
        cacheDir
      };

      if (enablePoly) {
        if (sub.annotations && sub.annotations.length) synthOptions.annotations = sub.annotations;
        if (polyphonicDict && polyphonicDict.length) synthOptions.polyphonicDict = polyphonicDict;
      }

      try {
        const audio = await this.ttsProvider.synthesize(synthOptions);

        const durationFrames = Math.min(audio.durationFrames, maxFrames);
        const insert = await this.insertAudioFile({
          filePath: audio.filePath,
          audioTrackIndex: targetTrack,
          recordFrame: sub.startFrame,
          durationFrames,
          clipName,
          overwriteMode,
          forceReimport: audio.cacheHit === false,
          skipExistingCheck: overwriteMode === 'skip'
        });
        results.push({ text, start: sub.startFrame, end: sub.endFrame, audio, ...insert });
      } catch (synthErr) {
        // 单条合成/插入失败，中止剩余字幕，抛出友好错误
        const errMsg = synthErr && synthErr.message ? synthErr.message : String(synthErr);
        throw new Error(`字幕「${textPreview(text)}」配音失败，已中止剩余 ${subtitles.length - results.length - 1} 条：${errMsg}`);
      }
    }

    return {
      status: 'done',
      total: subtitles.length,
      inserted: results.filter((item) => item.status === 'inserted').length,
      skipped: results.filter((item) => item.status === 'skipped').length,
      audioTrackIndex: targetTrack,
      results
    };
  }

  async insertTextAtPlayhead({ text, audioTrackIndex = 'auto', voiceSettings = {}, overwriteMode = 'allowDuplicate' }) {
    const { resolve, project, timeline } = await this.getContext();
    const currentPage = typeof resolve.GetCurrentPage === 'function' ? await resolve.GetCurrentPage() : '';
    if (currentPage && !['cut', 'edit'].includes(String(currentPage).toLowerCase())) {
      throw new Error('当前页面不能读取播放头位置。请切换到“快编”或“剪辑”页面后再插入配音。');
    }

    const targetTrack = await this.ensureTargetAudioTrack(audioTrackIndex);
    const fps = await this.getTimelineFps(project);
    const cacheDir = await this.getProjectCacheDir(project);

    let currentTimecode;
    try {
      currentTimecode = await timeline.GetCurrentTimecode();
    } catch (error) {
      if (/GetCurrentTimecode|Not supported on current page/i.test(String(error && error.message))) {
        throw new Error('当前页面不能读取播放头位置。请切换到“快编”或“剪辑”页面后再插入配音。');
      }
      throw error;
    }
    const startTimecode = await timeline.GetStartTimecode();
    const startFrame = Number(await timeline.GetStartFrame()) || 0;
    const recordFrame = currentTimecodeToRecordFrame(
      currentTimecode,
      startTimecode,
      await project.GetSetting('timelineFrameRate'),
      startFrame
    );
    const cacheKey = sha1(JSON.stringify({ manual: true, text, voiceSettings, v: 2 }));
    const speakerName = await voiceDisplayName(this.settingsStore, voiceSettings.voice);
    const clipName = `${recordFrame}_${sanitizeName(textPreview(text))}_${speakerName}_momo`;

    const synthOptions = {
      ...voiceSettings,
      text,
      cacheKey,
      timelineFps: fps,
      cacheDir
    };
    const enablePoly = voiceSettings.enablePolyphonic !== false;
    if (enablePoly) {
      if (voiceSettings.annotations) synthOptions.annotations = voiceSettings.annotations;
      if (voiceSettings.polyphonicDict) synthOptions.polyphonicDict = voiceSettings.polyphonicDict;
    }

    // 覆盖策略为「跳过」且播放头位置已有本插件生成的片段 → 不合成、不插入
    if (overwriteMode === 'skip') {
      const existingClips = await this.findGeneratedItemsAt(targetTrack, recordFrame);
      if (existingClips && existingClips.length) {
        return {
          status: 'skipped',
          reason: 'existing-clip',
          currentTimecode,
          recordFrame,
          audioTrackIndex: targetTrack,
          skipped: 1,
          inserted: 0
        };
      }
    }

    const audio = await this.ttsProvider.synthesize(synthOptions);

    const insert = await this.insertAudioFile({
      filePath: audio.filePath,
      audioTrackIndex: targetTrack,
      recordFrame,
      durationFrames: audio.durationFrames,
      clipName,
      overwriteMode,
      forceReimport: audio.cacheHit === false,
      skipExistingCheck: overwriteMode === 'skip'
    });

    return {
      status: 'done',
      currentTimecode,
      recordFrame,
      audioTrackIndex: targetTrack,
      audio,
      ...insert
    };
  }
}

module.exports = {
  ResolveAdapter,
  TARGET_TRACK_NAME,
  CLIP_SUFFIX,
  sanitizeName,
  textPreview,
  isMomoClipName,
  voiceDisplayName
};
