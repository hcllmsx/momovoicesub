// @ts-ignore
import uxp from "uxp";
import { normalizeBaseUrl, probeGptSoVits } from "./local-tts-provider";

declare const require: any;
declare const __APP_VERSION__: string;

const SOVITS_WEIGHT_DIRS = [
  'SoVITS_weights', 'SoVITS_weights_v2', 'SoVITS_weights_v3',
  'SoVITS_weights_v4', 'SoVITS_weights_v2Pro', 'SoVITS_weights_v2ProPlus'
];
const GPT_WEIGHT_DIRS = [
  'GPT_weights', 'GPT_weights_v2', 'GPT_weights_v3',
  'GPT_weights_v4', 'GPT_weights_v2Pro', 'GPT_weights_v2ProPlus'
];

export interface PretrainedBaseModel {
  name: string;
  version: string;
  gptFile: string;
  sovitsFile: string;
}

const PRETRAINED_BASE_MODELS: PretrainedBaseModel[] = [
  {
    name: 'v2Pro 通用底模',
    version: 'v2Pro',
    gptFile: 'GPT_SoVITS/pretrained_models/s1v3.ckpt',
    sovitsFile: 'GPT_SoVITS/pretrained_models/v2Pro/s2Gv2Pro.pth'
  },
  {
    name: 'v2ProPlus 通用底模',
    version: 'v2ProPlus',
    gptFile: 'GPT_SoVITS/pretrained_models/s1v3.ckpt',
    sovitsFile: 'GPT_SoVITS/pretrained_models/v2Pro/s2Gv2ProPlus.pth'
  },
  {
    name: 'v2 通用底模',
    version: 'v2',
    gptFile: 'GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt',
    sovitsFile: 'GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s2G2333k.pth'
  },
  {
    name: 'v1 通用底模',
    version: 'v1',
    gptFile: 'GPT_SoVITS/pretrained_models/s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt',
    sovitsFile: 'GPT_SoVITS/pretrained_models/s2G488k.pth'
  },
  {
    name: 'v3 通用底模',
    version: 'v3',
    gptFile: 'GPT_SoVITS/pretrained_models/s1v3.ckpt',
    sovitsFile: 'GPT_SoVITS/pretrained_models/s2Gv3.pth'
  },
  {
    name: 'v4 通用底模',
    version: 'v4',
    gptFile: 'GPT_SoVITS/pretrained_models/gsv-v4-pretrained/s2Gv4.pth',
    sovitsFile: 'GPT_SoVITS/pretrained_models/s1v3.ckpt'
  }
];

const CJK_RE = /[\u4e00-\u9fa5]/;

function pathJoin(...parts: string[]): string {
  return parts
    .map((p, i) => {
      let s = String(p || '').replace(/\\/g, '/');
      if (i > 0) s = s.replace(/^\/+/, '');
      if (i < parts.length - 1) s = s.replace(/\/+$/, '');
      return s;
    })
    .filter(Boolean)
    .join('/');
}

function pathBasename(p: string): string {
  const clean = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = clean.lastIndexOf('/');
  return idx >= 0 ? clean.slice(idx + 1) : clean;
}

function safeGetFs(): any {
  try {
    return require('fs');
  } catch (_) {
    return null;
  }
}

async function exists(target: string): Promise<boolean> {
  const fs = safeGetFs();
  if (!fs) return false;
  try {
    if (typeof fs.lstatSync === 'function') {
      fs.lstatSync(target);
      return true;
    }
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(dir: string, extensions: string[]): Promise<string[]> {
  const fs = safeGetFs();
  if (!fs) return [];
  try {
    let entries: string[] = [];
    if (typeof fs.readdirSync === 'function') {
      entries = fs.readdirSync(dir);
    } else {
      entries = await fs.readdir(dir);
    }
    return entries
      .filter(name => extensions.some(ext => name.toLowerCase().endsWith(ext)));
  } catch {
    return [];
  }
}

async function readFileText(filePath: string): Promise<string> {
  const fs = safeGetFs();
  if (!fs) return '';
  try {
    if (typeof fs.readFileSync === 'function') {
      return fs.readFileSync(filePath, { encoding: 'utf-8' });
    }
    return await fs.readFile(filePath, { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

function versionOfDir(dirName: string, prefix: string): string {
  const rest = dirName.slice(prefix.length).replace(/^_/, '');
  return rest || 'v1';
}

function modelNameOf(fileName: string, kind: 'sovits' | 'gpt'): string {
  const base = fileName.replace(/\.(pth|ckpt)$/i, '');
  const re = kind === 'sovits' ? /^(.*)_e\d+_s\d+$/ : /^(.*)-e\d+$/;
  const m = base.match(re);
  return (m && m[1]) ? m[1] : base;
}

export interface DetectResult {
  ok: boolean;
  rootDir: string;
  pythonPath: string;
  hasRuntime: boolean;
  apiScript: string;
  webuiScript: string;
  versions: string[];
  issues: string[];
}

export async function detect(rootDir: string, { pythonPath }: { pythonPath?: string } = {}): Promise<DetectResult> {
  const issues: string[] = [];
  const root = String(rootDir || '').trim();
  if (!root) {
    return {
      ok: false,
      rootDir: '',
      pythonPath: '',
      hasRuntime: false,
      apiScript: '',
      webuiScript: '',
      versions: [],
      issues: ['未选择 GPT-SoVITS 目录。']
    };
  }

  if (!(await exists(root))) {
    return {
      ok: false,
      rootDir: root,
      pythonPath: '',
      hasRuntime: false,
      apiScript: '',
      webuiScript: '',
      versions: [],
      issues: [`目录不存在：${root}`]
    };
  }

  const runtimeDir = pathJoin(root, 'runtime');
  const candidates = [
    pathJoin(runtimeDir, 'python.exe'),
    pathJoin(runtimeDir, 'python'),
    pathJoin(root, 'python.exe'),
    pathJoin(root, 'python')
  ];

  let detectedPython = '';
  for (const c of candidates) {
    if (await exists(c)) {
      detectedPython = c;
      break;
    }
  }

  const finalPython = String(pythonPath || '').trim() || detectedPython;
  if (!finalPython) {
    issues.push('未找到 Python 解释器。整合包通常自带 runtime\\python.exe；若使用源码仓库，请手动指定 conda/python 路径。');
  } else if (!(await exists(finalPython))) {
    issues.push(`指定的 Python 解释器不存在：${finalPython}`);
  }

  const apiScript = pathJoin(root, 'api_v2.py');
  const webuiScript = pathJoin(root, 'webui.py');
  const hasApi = await exists(apiScript);
  const hasWebui = await exists(webuiScript);
  if (!hasApi && !hasWebui) {
    issues.push('目录下未找到 api_v2.py 或 webui.py，请确认选择的是 GPT-SoVITS 整合包根目录。');
  }

  const versions = new Set<string>();
  for (const d of SOVITS_WEIGHT_DIRS) {
    const version = versionOfDir(d, 'SoVITS_weights');
    const sovitsDir = pathJoin(root, d);
    if (!(await exists(sovitsDir))) continue;

    const gptDirName = GPT_WEIGHT_DIRS.find(g => versionOfDir(g, 'GPT_weights') === version);
    if (!gptDirName || !(await exists(pathJoin(root, gptDirName)))) continue;

    const [pth, ckpt] = await Promise.all([
      listFiles(sovitsDir, ['.pth']),
      listFiles(pathJoin(root, gptDirName), ['.ckpt'])
    ]);
    if (pth.length || ckpt.length) versions.add(version);
  }

  return {
    ok: issues.length === 0,
    rootDir: root,
    pythonPath: finalPython,
    hasRuntime: Boolean(detectedPython),
    apiScript: hasApi ? apiScript : '',
    webuiScript: hasWebui ? webuiScript : '',
    versions: [...versions],
    issues
  };
}

export interface ModelWeightItem {
  file: string;
  path: string;
}

export interface ScannedModel {
  name: string;
  version: string;
  complete: boolean;
  isBase?: boolean;
  gpt: ModelWeightItem[];
  sovits: ModelWeightItem[];
}

export async function scanModels(rootDir: string): Promise<ScannedModel[]> {
  const root = String(rootDir || '').trim();
  if (!root || !(await exists(root))) return [];

  const byKey = new Map<string, { name: string; version: string; gpt: ModelWeightItem[]; sovits: ModelWeightItem[] }>();

  const collect = async (dirs: string[], kind: 'sovits' | 'gpt', prefix: string) => {
    for (const dir of dirs) {
      const version = versionOfDir(dir, prefix);
      const absDir = pathJoin(root, dir);
      if (!(await exists(absDir))) continue;
      const files = await listFiles(absDir, kind === 'sovits' ? ['.pth'] : ['.ckpt']);
      for (const file of files) {
        const name = modelNameOf(file, kind);
        const key = `${version}::${name}`;
        if (!byKey.has(key)) {
          byKey.set(key, { name, version, gpt: [], sovits: [] });
        }
        byKey.get(key)![kind === 'sovits' ? 'sovits' : 'gpt'].push({
          file,
          path: `${dir}/${file}`
        });
      }
    }
  };

  await collect(SOVITS_WEIGHT_DIRS, 'sovits', 'SoVITS_weights');
  await collect(GPT_WEIGHT_DIRS, 'gpt', 'GPT_weights');

  const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

  const customModels: ScannedModel[] = [...byKey.values()]
    .map(item => ({
      ...item,
      isBase: false,
      gpt: item.gpt.sort((a, b) => natural(a.file, b.file)),
      sovits: item.sovits.sort((a, b) => natural(a.file, b.file)),
      complete: item.gpt.length > 0 && item.sovits.length > 0
    }))
    .sort((a, b) => (a.version === b.version ? natural(a.name, b.name) : natural(a.version, b.version)));

  const baseModels: ScannedModel[] = [];
  for (const item of PRETRAINED_BASE_MODELS) {
    const gptAbs = pathJoin(root, item.gptFile);
    const sovitsAbs = pathJoin(root, item.sovitsFile);
    const hasGpt = await exists(gptAbs);
    const hasSovits = await exists(sovitsAbs);
    if (hasGpt && hasSovits) {
      baseModels.push({
        name: item.name,
        version: item.version,
        isBase: true,
        complete: true,
        gpt: [{ file: pathBasename(item.gptFile), path: item.gptFile.replace(/\\/g, '/') }],
        sovits: [{ file: pathBasename(item.sovitsFile), path: item.sovitsFile.replace(/\\/g, '/') }]
      });
    }
  }

  return [...customModels, ...baseModels];
}

export interface ReferenceAudioItem {
  file: string;
  path: string;
  source: string;
}

export async function scanReferenceAudios({
  rootDir,
  modelName
}: {
  rootDir: string;
  modelName?: string;
}): Promise<ReferenceAudioItem[]> {
  const root = String(rootDir || '').trim();
  if (!root) return [];

  const candidates: { dir: string; source: string }[] = [];
  if (modelName) {
    candidates.push({
      dir: pathJoin(root, 'logs', String(modelName), '5-wav32k'),
      source: '训练切片 (5-wav32k)'
    });
  }
  candidates.push({
    dir: pathJoin(root, 'output', 'slicer_opt'),
    source: '原始切片 (slicer_opt)'
  });

  const result: ReferenceAudioItem[] = [];
  for (const c of candidates) {
    if (!(await exists(c.dir))) continue;
    const files = await listFiles(c.dir, ['.wav', '.mp3', '.flac', '.m4a']);
    for (const file of files) {
      result.push({ file, path: pathJoin(c.dir, file), source: c.source });
    }
  }
  return result;
}

export async function lookupPromptText({
  rootDir,
  modelName,
  wavFileName
}: {
  rootDir: string;
  modelName: string;
  wavFileName: string;
}): Promise<string> {
  const root = String(rootDir || '').trim();
  if (!root || !modelName || !wavFileName) return '';

  const txtPath = pathJoin(root, 'logs', String(modelName), '2-name2text.txt');
  const raw = await readFileText(txtPath);
  if (!raw) return '';

  const target = pathBasename(String(wavFileName));
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.split('\t');
    if (!fields.length) continue;
    if (pathBasename(fields[0].trim()) !== target) continue;

    for (let i = fields.length - 1; i >= 1; i -= 1) {
      const value = fields[i].trim();
      if (value && CJK_RE.test(value)) return value;
    }
    return '';
  }
  return '';
}

/**
 * 在 UXP 下一键拉起或接管本地整合包服务
 */
export async function launchGptSoVitsService({
  rootDir,
  port = 9880,
  pythonPath
}: {
  rootDir: string;
  port?: number;
  pythonPath?: string;
}): Promise<{ status: 'reused' | 'starting'; baseUrl: string; manualBat?: boolean; batPath?: string }> {
  const baseUrl = normalizeBaseUrl(`http://127.0.0.1:${port}`);

  // 1. 若当前端口已有服务在运行，直接复用
  try {
    const probe = await probeGptSoVits({ baseUrl, timeoutMs: 2000 });
    if (probe.ok && probe.ready) {
      return { status: 'reused', baseUrl };
    }
  } catch (_) {}

  // 2. 校验整合包
  const detection = await detect(rootDir, { pythonPath });
  if (!detection.ok) {
    throw new Error(detection.issues.join(' '));
  }

  const pyExe = detection.pythonPath.replace(/\//g, '\\');
  const rootWin = detection.rootDir.replace(/\//g, '\\');

  const appVer = typeof __APP_VERSION__ !== 'undefined' ? `v${__APP_VERSION__}` : '';
  const bannerBrand = appVer ? `默默配音助手 ${appVer}` : '默默配音助手';

  // 3. 在整合包目录生成启动 bat 脚本
  const batContent = [
    '@echo off',
    'chcp 65001 >nul',
    'title 默默配音助手',
    `cd /d "${rootWin}"`,
    `set PATH=${rootWin}\\runtime;%PATH%`,
    'set PYTHONUNBUFFERED=1',
    'echo ============================================================',
    `echo   ${bannerBrand}`,
    'echo ============================================================',
    'echo 正在启动GPT-SoVITS服务，请不要关闭此窗口。',
    'echo.',
    'ping 127.0.0.1 -n 2 >nul',
    'echo 正在加载引擎与模型，服务启动后请保持此窗口常驻后台...',
    'echo ============================================================',
    'echo.',
    `"${pyExe}" -I -X utf8 api_v2.py -a 127.0.0.1 -p ${port}`,
    'echo.',
    'echo ============================================================',
    'echo GPT-SoVITS 服务已结束运行，你可以关闭这个窗口了。',
    'echo ============================================================',
    'pause'
  ].join('\r\n');

  const fs = safeGetFs();
  const batPath = pathJoin(rootWin, 'momo_start_api_v2.bat').replace(/\//g, '\\');
  let written = false;
  if (fs) {
    try {
      if (typeof fs.writeFileSync === 'function') {
        fs.writeFileSync(batPath, batContent, { encoding: 'utf-8' });
        written = true;
      } else {
        await fs.writeFile(batPath, batContent, { encoding: 'utf-8' });
        written = true;
      }
    } catch (e: any) {
      console.warn('[Momo] fs.writeFileSync failed, trying UXP localFileSystem fallback:', e);
    }
  }

  if (!written) {
    try {
      const cleanRoot = rootWin.replace(/^[a-zA-Z]:/, '').replace(/\\/g, '/');
      const drive = (rootWin.match(/^[a-zA-Z]:/) || [''])[0];
      const folderUrl = drive ? `file:///${drive}${cleanRoot}` : `file://${cleanRoot}`;
      const folderEntry = await (uxp.storage.localFileSystem as any).getEntryWithUrl(folderUrl);
      if (folderEntry && folderEntry.isFolder) {
        const fileEntry = await folderEntry.createEntry('momo_start_api_v2.bat', { overwrite: true });
        await fileEntry.write(batContent, { format: (uxp.storage.formats as any).utf8 });
        written = true;
      }
    } catch (e: any) {
      console.error('[Momo] Failed to write bat via UXP storage:', e);
    }
  }

  // 4. 调用 UXP shell 唤起服务（UXP 宿主策略拦截 .bat 执行时回退为自动打开文件夹引导双击）
  const shell = (uxp as any).shell;
  if (!shell || typeof shell.openPath !== 'function') {
    throw new Error('当前 UXP 环境不支持 openPath，请手动在整合包根目录运行 api_v2.py');
  }

  let manualBat = false;
  try {
    const openErr = await shell.openPath(batPath, '启动 GPT-SoVITS 本地服务');
    if (openErr && String(openErr).length > 0) {
      throw new Error(String(openErr));
    }
  } catch (err: any) {
    console.warn('[Momo] UXP blocked direct execution of .bat, opening root folder instead:', err?.message || err);
    manualBat = true;
    try {
      await shell.openPath(rootWin, '打开 GPT-SoVITS 整合包目录');
    } catch (_) {}
  }

  return { status: 'starting', baseUrl, manualBat, batPath };
}
