import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { defineConfig } from "vite";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// ─── 读取项目根目录 VERSION 文件，解析 PR 插件版本号（唯一真相源） ───
// VERSION 文件格式：
//   com.momo.voicesub.dr.version=0.26.74
//   com.momo.voicesub.pr.version=0.0.1
function readPrVersion() {
  const versionFilePath = resolve(__dirname, "../../VERSION");
  const content = readFileSync(versionFilePath, "utf8");
  const key = "com.momo.voicesub.pr.version";
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}=`)) {
      return trimmed.slice(key.length + 1).trim();
    }
  }
  throw new Error(`VERSION file is missing '${key}' entry: ${versionFilePath}`);
}

const appVersion = readPrVersion();

// ─── dev 模式判定 ───
// 通过 vite build --mode dev 触发（在 defineConfig 的函数形式中拿到 mode 参数）。
// dev 模式下输出到 dist-dev/，manifest 的 id 改为 com.momo.voicesub.pr.dev，
// name/label 改为「默默配音助手dev」，与正式版（dist/）可同时存在。
const devPluginId = "com.momo.voicesub.pr.dev";
const devPluginName = "默默配音助手dev";

// Vite 插件：构建后处理 dist（或 dist-dev）/manifest.json
//   1. 同步 version 字段为 VERSION 文件中的值
//   2. dev 模式下：id 改为 com.momo.voicesub.pr.dev，name 与面板 label 改为「默默配音助手dev」
// Vite 的 publicDir 机制会把 public/manifest.json 原样拷贝到输出目录，
// 此插件在 writeBundle 钩子中覆盖相应字段。
function syncManifestVersion(isDev) {
  return {
    name: "sync-manifest-version",
    writeBundle() {
      const outDirName = isDev ? "dist-dev" : "dist";
      const distManifestPath = resolve(__dirname, outDirName, "manifest.json");
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(distManifestPath, "utf8"));
      } catch {
        return; // manifest.json 不存在时跳过（publicDir 机制应已拷贝）
      }
      let changed = false;
      if (manifest.version !== appVersion) {
        manifest.version = appVersion;
        changed = true;
      }
      if (isDev) {
        if (manifest.id !== devPluginId) {
          manifest.id = devPluginId;
          changed = true;
        }
        if (manifest.name !== devPluginName) {
          manifest.name = devPluginName;
          changed = true;
        }
        if (Array.isArray(manifest.entrypoints)) {
          for (const ep of manifest.entrypoints) {
            if (ep.label && ep.label.default !== devPluginName) {
              ep.label.default = devPluginName;
              changed = true;
            }
          }
        }
      }
      if (changed) {
        writeFileSync(distManifestPath, JSON.stringify(manifest, null, 2) + "\n");
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const isDev = mode === "dev";
  return {
    publicDir: "public",
    base: "./",
    define: {
      // 构建时将 __APP_VERSION__ 替换为 VERSION 文件中的版本号字符串字面量
      __APP_VERSION__: JSON.stringify(appVersion),
    },
    plugins: [syncManifestVersion(isDev)],
    build: {
      outDir: isDev ? "dist-dev" : "dist",
      emptyOutDir: true,
      minify: false,
      sourcemap: true,
      target: "esnext",
      rollupOptions: {
        input: resolve(__dirname, "src/index.ts"),
        external: ["os", "fs", "premierepro", "uxp"],
        output: {
          format: "cjs",
          entryFileNames: "index.js",
          // 如果是多模块输出可以保留原有模块，这里我们直接打包成一个 index.js 最为稳定方便
          inlineDynamicImports: true
        },
      },
    },
  };
});
