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

// Vite 插件：构建后把 dist/manifest.json 的 version 字段同步为 VERSION 文件中的值。
// Vite 的 publicDir 机制会把 public/manifest.json 原样拷贝到 dist/，
// 此插件在 writeBundle 钩子中覆盖 version 字段，保证打包后的 manifest 与 VERSION 文件一致。
function syncManifestVersion() {
  return {
    name: "sync-manifest-version",
    writeBundle() {
      const distManifestPath = resolve(__dirname, "dist", "manifest.json");
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(distManifestPath, "utf8"));
      } catch {
        return; // dist/manifest.json 不存在时跳过（publicDir 机制应已拷贝）
      }
      if (manifest.version !== appVersion) {
        manifest.version = appVersion;
        writeFileSync(distManifestPath, JSON.stringify(manifest, null, 2) + "\n");
      }
    },
  };
}

export default defineConfig({
  publicDir: "public",
  base: "./",
  define: {
    // 构建时将 __APP_VERSION__ 替换为 VERSION 文件中的版本号字符串字面量
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [syncManifestVersion()],
  build: {
    outDir: "dist",
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
});
