'use strict';

/**
 * GPT-SoVITS 整合包引擎层
 *
 * 职责边界（重要）：
 *   本模块只做「使用」，不做「训练」。
 *   训练一律在 GPT-SoVITS 自己的 webui (go-webui.bat) 中完成，
 *   训练产物落在整合包的 GPT_weights 与 SoVITS_weights 系列目录，
 *   本模块负责扫描这些产物并提供给插件用于配音 —— 文件系统即两端的契约。
 *
 * 提供的能力：
 *   1. detect()              探测整合包目录是否合法（runtime/python.exe、api_v2.py 等）
 *   2. scanModels()          扫描已训练的模型（按版本分组，GPT 与 SoVITS 配对）
 *   3. scanReferenceAudios() 扫描训练切片作为参考音频候选
 *   4. lookupPromptText()    从 2-name2text.txt 自动读出参考音频对应的文本
 *   5. GptSoVitsEngine       拉起 / 停止 api_v2.py 进程，并等待其就绪
 */

const fs = (() => {
  try { return require('fs/promises'); } catch (_) {
    const _fs = require('fs');
    const { promisify } = require('util');
    return {
      readFile: promisify(_fs.readFile),
      stat: promisify(_fs.stat),
      readdir: promisify(_fs.readdir)
    };
  }
})();
const path = require('path');
const { spawn } = require('child_process');
const { probeGptSoVits, normalizeBaseUrl } = require('./local-tts-provider');

// 与 GPT-SoVITS config.py 的 SoVITS_weight_root / GPT_weight_root 保持一致。
// 不同版本（v1/v2/v3/v4/v2Pro/v2ProPlus）的权重不通用，必须同版本配对。
const SOVITS_WEIGHT_DIRS = [
  'SoVITS_weights', 'SoVITS_weights_v2', 'SoVITS_weights_v3',
  'SoVITS_weights_v4', 'SoVITS_weights_v2Pro', 'SoVITS_weights_v2ProPlus'
];
const GPT_WEIGHT_DIRS = [
  'GPT_weights', 'GPT_weights_v2', 'GPT_weights_v3',
  'GPT_weights_v4', 'GPT_weights_v2Pro', 'GPT_weights_v2ProPlus'
];

// 官方预训练通用底模（Zero-Shot 零样本声音克隆基础模型）
const PRETRAINED_BASE_MODELS = [
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

// 首次启动需要加载底模 + 权重到显存，耗时可能达数十秒到数分钟
const DEFAULT_READY_TIMEOUT_MS = 180000;
const READY_POLL_INTERVAL_MS = 1500;

const CJK_RE = /[\u4e00-\u9fa5]/;

/**
 * 按行内容判断日志级别，而不是按输出流。
 * Python 常把大量正常的诊断信息（Loading 权重、uvicorn 启动横幅等）打到 stderr，
 * 若把 stderr 一律标红，用户会误以为服务出错。
 */
function classifyLogLevel(line) {
  if (!line) return 'info';
  if (/traceback|exception|^error| failed |cuda out of memory|错误|失败|异常/i.test(line)) return 'error';
  if (/warning|deprecat/i.test(line)) return 'warn';
  return 'info';
}

async function exists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(dir, extensions) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && extensions.some(ext => e.name.toLowerCase().endsWith(ext)))
      .map(e => e.name);
  } catch {
    return [];
  }
}

/**
 * 从权重目录名推导版本 key：
 *   'SoVITS_weights'        → 'v1'
 *   'SoVITS_weights_v2Pro'  → 'v2Pro'
 */
function versionOfDir(dirName, prefix) {
  const rest = dirName.slice(prefix.length).replace(/^_/, '');
  return rest || 'v1';
}

/**
 * 从权重文件名提取模型名：
 *   'axinNico_e8_s96.pth' → 'axinNico'   (SoVITS 命名：<name>_e<epoch>_s<step>.pth)
 *   'axinNico-e15.ckpt'   → 'axinNico'   (GPT 命名：<name>-e<epoch>.ckpt)
 * 无法匹配时回退为去掉扩展名的文件名。
 */
function modelNameOf(fileName, kind) {
  const base = fileName.replace(/\.(pth|ckpt)$/i, '');
  const re = kind === 'sovits' ? /^(.*)_e\d+_s\d+$/ : /^(.*)-e\d+$/;
  const m = base.match(re);
  return (m && m[1]) ? m[1] : base;
}

/**
 * 探测整合包目录。
 *
 * @returns {Promise<{ok:boolean, rootDir:string, pythonPath:string, hasRuntime:boolean,
 *                    apiScript:string, webuiScript:string, versions:string[], issues:string[]}>}
 */
async function detect(rootDir, { pythonPath } = {}) {
  const issues = [];
  const root = String(rootDir || '').trim();
  if (!root) {
    return { ok: false, issues: ['未选择 GPT-SoVITS 目录。'] };
  }
  if (!(await exists(root))) {
    return { ok: false, issues: [`目录不存在：${root}`] };
  }

  // 整合包内嵌解释器：Windows 为 runtime\python.exe，Linux/Mac 为 runtime/python
  const runtimeDir = path.join(root, 'runtime');
  const candidates = [
    path.join(runtimeDir, process.platform === 'win32' ? 'python.exe' : 'python'),
    path.join(root, process.platform === 'win32' ? 'python.exe' : 'python')
  ];
  let detectedPython = '';
  for (const c of candidates) {
    if (await exists(c)) { detectedPython = c; break; }
  }

  const finalPython = String(pythonPath || '').trim() || detectedPython;
  if (!finalPython) {
    issues.push('未找到 Python 解释器。整合包通常自带 runtime\\python.exe；若使用源码仓库，请手动指定 conda/python 路径。');
  } else if (!(await exists(finalPython))) {
    issues.push(`指定的 Python 解释器不存在：${finalPython}`);
  }

  const apiScript = path.join(root, 'api_v2.py');
  const webuiScript = path.join(root, 'webui.py');
  const hasApi = await exists(apiScript);
  const hasWebui = await exists(webuiScript);
  if (!hasApi && !hasWebui) {
    issues.push('目录下未找到 api_v2.py 或 webui.py，请确认选择的是 GPT-SoVITS 整合包根目录。');
  }

  // 收集"真正能用的"权重版本：同版本的 GPT 与 SoVITS 目录都存在，
  // 且至少一方已有权重文件。整合包会预建全部 6 个版本的空目录，
  // 只判断目录存在会列出一堆没有模型的版本，误导用户。
  const versions = new Set();
  for (const d of SOVITS_WEIGHT_DIRS) {
    const version = versionOfDir(d, 'SoVITS_weights');
    const sovitsDir = path.join(root, d);
    if (!(await exists(sovitsDir))) continue;

    const gptDirName = GPT_WEIGHT_DIRS.find(g => versionOfDir(g, 'GPT_weights') === version);
    if (!gptDirName || !(await exists(path.join(root, gptDirName)))) continue;

    const [pth, ckpt] = await Promise.all([
      listFiles(sovitsDir, ['.pth']),
      listFiles(path.join(root, gptDirName), ['.ckpt'])
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

/**
 * 扫描已训练的模型。
 *
 * @returns {Promise<Array<{name:string, version:string, complete:boolean,
 *                          gpt:Array<{file:string, path:string}>,
 *                          sovits:Array<{file:string, path:string}>}>>}
 */
async function scanModels(rootDir) {
  const root = String(rootDir || '').trim();
  if (!root || !(await exists(root))) return [];

  const byKey = new Map();

  const collect = async (dirs, kind, prefix) => {
    for (const dir of dirs) {
      const version = versionOfDir(dir, prefix);
      const absDir = path.join(root, dir);
      if (!(await exists(absDir))) continue;
      const files = await listFiles(absDir, kind === 'sovits' ? ['.pth'] : ['.ckpt']);
      for (const file of files) {
        const name = modelNameOf(file, kind);
        const key = `${version}::${name}`;
        if (!byKey.has(key)) {
          byKey.set(key, { name, version, gpt: [], sovits: [] });
        }
        byKey.get(key)[kind === 'sovits' ? 'sovits' : 'gpt'].push({
          file,
          // 相对整合包根目录的路径，与 GPT-SoVITS webui 下拉框中的取值一致
          path: `${dir}/${file}`
        });
      }
    }
  };

  await collect(SOVITS_WEIGHT_DIRS, 'sovits', 'SoVITS_weights');
  await collect(GPT_WEIGHT_DIRS, 'gpt', 'GPT_weights');

  const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

  // 1. 用户自己训练的模型（自定义微调模型，排列在上方）
  const customModels = [...byKey.values()]
    .map(item => ({
      ...item,
      isBase: false,
      gpt: item.gpt.sort((a, b) => natural(a.file, b.file)),
      sovits: item.sovits.sort((a, b) => natural(a.file, b.file)),
      // 只有同时具备 GPT 与 SoVITS 权重才能推理；缺 SoVITS 说明训练时没点「开启 SoVITS 训练」
      complete: item.gpt.length > 0 && item.sovits.length > 0
    }))
    .sort((a, b) => (a.version === b.version ? natural(a.name, b.name) : natural(a.version, b.version)));

  // 2. 官方通用底模（零样本声音克隆，排列在下方）
  const baseModels = [];
  for (const item of PRETRAINED_BASE_MODELS) {
    const gptAbs = path.join(root, item.gptFile);
    const sovitsAbs = path.join(root, item.sovitsFile);
    const hasGpt = await exists(gptAbs);
    const hasSovits = await exists(sovitsAbs);
    if (hasGpt && hasSovits) {
      baseModels.push({
        name: item.name,
        version: item.version,
        isBase: true,
        complete: true,
        gpt: [{ file: path.basename(item.gptFile), path: item.gptFile.replace(/\\/g, '/') }],
        sovits: [{ file: path.basename(item.sovitsFile), path: item.sovitsFile.replace(/\\/g, '/') }]
      });
    }
  }

  // 自定义已训练模型在上，通用底模在下
  return [...customModels, ...baseModels];
}

/**
 * 扫描参考音频候选。
 *
 * 优先 logs/<模型名>/5-wav32k（训练切片，与训练素材同源，音色一致性最好），
 * 其次 output/slicer_opt（原始切片，未降采样）。
 *
 * @returns {Promise<Array<{file:string, path:string, source:string}>>}
 */
async function scanReferenceAudios({ rootDir, modelName }) {
  const root = String(rootDir || '').trim();
  if (!root) return [];

  const candidates = [];
  if (modelName) {
    candidates.push({
      dir: path.join(root, 'logs', String(modelName), '5-wav32k'),
      source: '训练切片 (5-wav32k)'
    });
  }
  candidates.push({ dir: path.join(root, 'output', 'slicer_opt'), source: '原始切片 (slicer_opt)' });

  const result = [];
  for (const c of candidates) {
    if (!(await exists(c.dir))) continue;
    const files = await listFiles(c.dir, ['.wav', '.mp3', '.flac', '.m4a']);
    for (const file of files) {
      result.push({ file, path: path.join(c.dir, file), source: c.source });
    }
  }
  return result;
}

/**
 * 从 logs/<模型名>/2-name2text.txt 中查找某段切片对应的文本。
 *
 * 该文件为 tab 分隔，形如：
 *   小默默-原声.wav_0000388480_0000516800.wav \t z ai4 z h e4 ... \t [2,2,...] \t 更容易
 * 字段 2 是拼音（纯 ASCII），字段 4 才是真实汉字文本。
 * 这里取「最后一个含汉字的字段」，避免把拼音误当作提示文本。
 *
 * @returns {Promise<string>} 找不到时返回空串
 */
async function lookupPromptText({ rootDir, modelName, wavFileName }) {
  const root = String(rootDir || '').trim();
  if (!root || !modelName || !wavFileName) return '';

  const txtPath = path.join(root, 'logs', String(modelName), '2-name2text.txt');
  let raw;
  try {
    raw = await fs.readFile(txtPath, 'utf8');
  } catch {
    return '';
  }

  const target = path.basename(String(wavFileName));
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.split('\t');
    if (!fields.length) continue;
    if (path.basename(fields[0].trim()) !== target) continue;

    for (let i = fields.length - 1; i >= 1; i -= 1) {
      const value = fields[i].trim();
      if (value && CJK_RE.test(value)) return value;
    }
    return '';
  }
  return '';
}

/**
 * 托管模式下的进程管理器。
 *
 * 一个插件实例同时只托管一个 api_v2.py 进程；切换端口或目录会先停掉旧进程。
 */
class GptSoVitsEngine {
  constructor({ sendLog } = {}) {
    this.child = null;
    this.port = null;
    this.startedAt = null;
    this.sendLog = sendLog || (() => { });
    this.logBuffer = [];
    this.logSeq = 0;
  }

  _log(level, message) {
    const entry = { seq: ++this.logSeq, at: new Date().toISOString(), level, message };
    this.logBuffer.push(entry);
    if (this.logBuffer.length > 500) this.logBuffer.shift();
    this.sendLog(entry);
  }

  getLogs() {
    return this.logBuffer.slice();
  }

  clearLogs() {
    this.logBuffer = [];
    return { ok: true };
  }

  async getStatus() {
    const running = Boolean(this.child) && !this.child.killed;
    const reused = Boolean(this.reused);
    const port = this.port || 9880;

    return {
      running: running || reused,
      reused,
      pid: this.child ? this.child.pid : null,
      port,
      startedAt: this.startedAt
    };
  }

  async start({ rootDir, pythonPath, script = 'api_v2.py', port = 9880 }) {
    if (typeof globalThis.fetch !== 'function') {
      throw new Error('当前达芬奇内置的 Node.js 版本过低（缺少 fetch），无法使用托管模式。请升级达芬奇，或在「连接已有服务」模式下手动启动 api_v2.py 并填写地址。');
    }

    if (this.child) {
      await this.stop();
    }

    const detection = await detect(rootDir, { pythonPath });
    if (!detection.ok) {
      throw new Error(detection.issues.join(' '));
    }

    const baseUrl = normalizeBaseUrl(`http://127.0.0.1:${port}`);

    // 端口已被占用：若已是 GPT-SoVITS 服务则直接接管，避免重复加载模型、重复占用显存
    try {
      const probe = await probeGptSoVits({ baseUrl, timeoutMs: 2000 });
      this.port = port;
      this.reused = true;
      this._log('info', `检测到 ${baseUrl} 已有 GPT-SoVITS 服务在运行，直接接管（不重复启动）。`);
      return { status: 'reused', baseUrl, endpoints: probe.endpoints };
    } catch {
      // 未占用或不是 GPT-SoVITS，继续启动新进程
    }

    const scriptPath = path.isAbsolute(script) ? script : path.join(detection.rootDir, script);
    if (!(await exists(scriptPath))) {
      throw new Error(`启动脚本不存在：${scriptPath}`);
    }

    const runtimeDir = path.join(detection.rootDir, 'runtime');
    const env = {
      ...process.env,
      // 与 go-webui.bat 一致：把整合包自带的 runtime 提到 PATH 最前，
      // 保证 python 加载的是整合包内的 CUDA/torch 依赖而非系统里其它版本
      PATH: `${runtimeDir}${path.delimiter}${process.env.PATH || ''}`,
      // 强制 Python 以 UTF-8 输出，避免中文日志在 Windows 控制台编码下变乱码。
      // 注意：不能改用 PYTHONIOENCODING 环境变量 —— 下面用了 -I（isolated）模式，
      // 该模式下的 -E 会忽略所有 PYTHON* 环境变量，但 -X 是命令行选项，不受影响。
      PYTHONUNBUFFERED: '1'
    };

    // -I 隔离模式（同 go-webui.bat），避免用户 site-packages 干扰整合包自带的依赖版本
    const args = ['-I', '-X', 'utf8', scriptPath, '-a', '127.0.0.1', '-p', String(port)];

    this._log('info', `启动服务：${detection.pythonPath} ${args.join(' ')}`);
    this._log('info', `工作目录：${detection.rootDir}`);

    const child = spawn(detection.pythonPath, args, {
      cwd: detection.rootDir,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.child = child;
    this.port = port;
    this.startedAt = new Date().toISOString();

    const pipe = (stream) => {
      stream.setEncoding('utf8');
      let pending = '';
      stream.on('data', (chunk) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) this._log(classifyLogLevel(line), line);
        }
      });
      stream.on('end', () => {
        if (pending.trim()) this._log(classifyLogLevel(pending), pending);
      });
    };
    // 两个流都按内容分级，不能把 stderr 一棍子全标成 error
    pipe(child.stdout);
    pipe(child.stderr);

    child.on('error', (err) => {
      this._log('error', `进程启动失败：${err.message}`);
      this.child = null;
    });

    child.on('exit', (code, signal) => {
      this._log(code === 0 ? 'info' : 'error', `进程已退出（code=${code}, signal=${signal || 'none'}）`);
      this.child = null;
    });

    return { status: 'starting', baseUrl, pid: child.pid };
  }

  /**
   * 轮询等待服务就绪。首次启动要加载模型，可能耗时很久。
   */
  async waitReady({ timeoutMs = DEFAULT_READY_TIMEOUT_MS } = {}) {
    if (!this.port) throw new Error('服务未启动，无法等待就绪。');

    const baseUrl = normalizeBaseUrl(`http://127.0.0.1:${this.port}`);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (!this.child && !(await this._probeOnce(baseUrl))) {
        throw new Error('服务进程已退出，请查看日志确认原因（常见：显存不足、缺少依赖、模型路径错误）。');
      }
      const probe = await this._probeOnce(baseUrl);
      if (probe) {
        this._log('info', '服务已就绪。');
        return { status: 'ready', baseUrl, endpoints: probe.endpoints };
      }
      await new Promise(r => setTimeout(r, READY_POLL_INTERVAL_MS));
    }

    throw new Error(`等待服务就绪超时（${Math.round(timeoutMs / 1000)} 秒）。模型加载较慢时可在设置中增大超时，或查看日志确认是否报错。`);
  }

  async _probeOnce(baseUrl) {
    try {
      return await probeGptSoVits({ baseUrl, timeoutMs: 2000 });
    } catch {
      return null;
    }
  }

  async stop() {
    this.reused = false;
    const child = this.child;
    if (!child) {
      this.port = null;
      return { status: 'stopped' };
    }

    this.child = null;
    const pid = child.pid;
    this._log('info', `停止服务（pid=${pid}）...`);

    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      child.once('exit', finish);
      child.kill();
      // Windows 上 kill 只发 SIGTERM，对控制台程序常无效，超时后强制杀进程树
      setTimeout(() => {
        if (done) return;
        try {
          if (process.platform === 'win32') {
            require('child_process').execSync(`taskkill /pid ${pid} /t /f`, { stdio: 'ignore' });
          } else {
            child.kill('SIGKILL');
          }
        } catch { }
        finish();
      }, 3000);
    });

    this.port = null;
    return { status: 'stopped' };
  }
}

module.exports = {
  GptSoVitsEngine,
  detect,
  scanModels,
  scanReferenceAudios,
  lookupPromptText,
  SOVITS_WEIGHT_DIRS,
  GPT_WEIGHT_DIRS
};
