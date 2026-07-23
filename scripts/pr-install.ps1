# 默默配音助手Premiere Pro版本的开发脚本
# 用于UDT开发环境：自动构建并同步版本号
# 产出 dist-dev/ 目录（id=com.momo.voicesub.pr.dev，显示名「默默配音助手dev」），
# 与正式安装版（dist/，id=com.momo.voicesub.pr）可同时存在。

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot "apps\com.momo.voicesub.pr"
$packageJsonPath = Join-Path $source "package.json"
$manifestPath = Join-Path $source "public\manifest.json"
$versionFilePath = Join-Path $repoRoot "VERSION"
$prVersionKey = "com.momo.voicesub.pr.version"

if (-not (Test-Path -LiteralPath $source)) {
    throw "Plugin source not found: $source"
}

if (-not (Test-Path -LiteralPath $versionFilePath)) {
    throw "VERSION file not found: $versionFilePath"
}

if (-not (Test-Path -LiteralPath $packageJsonPath)) {
    throw "Plugin package.json not found: $packageJsonPath"
}

if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "Plugin manifest.json not found: $manifestPath"
}

# ─── 1. 读取 VERSION 文件作为版本号唯一真相源 ───
$canonicalVersion = $null
foreach ($line in Get-Content -LiteralPath $versionFilePath -Encoding UTF8) {
    $trimmed = $line.Trim()
    if ($trimmed -like "$prVersionKey=*") {
        $canonicalVersion = $trimmed.Substring($prVersionKey.Length + 1).Trim()
        break
    }
}
if ([string]::IsNullOrWhiteSpace($canonicalVersion)) {
    throw "VERSION file is missing '$prVersionKey' entry: $versionFilePath"
}
$pluginVersion = $canonicalVersion

# ─── 2. 同步 VERSION → package.json（保留原文件格式，仅替换 version 字段）───
$packageJsonRaw = Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8
$packageVersionPattern = '"version"\s*:\s*"([^"]*)"'
if ($packageJsonRaw -notmatch $packageVersionPattern) {
    throw "package.json is missing 'version' field."
}
$currentPackageVersion = $Matches[1]
if ($currentPackageVersion -ne $pluginVersion) {
    $packageJsonRaw = $packageJsonRaw -replace $packageVersionPattern, "`"version`": `"$pluginVersion`""
    Set-Content -LiteralPath $packageJsonPath -Value $packageJsonRaw -NoNewline -Encoding utf8
    Write-Host "Synced package.json version -> $pluginVersion"
}

# ─── 3. 同步 package.json → manifest.json ───
$manifestJsonRaw = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8
$manifestVersionPattern = '"version"\s*:\s*"([^"]*)"'
if ($manifestJsonRaw -notmatch $manifestVersionPattern) {
    throw "manifest.json is missing 'version' field."
}
$currentManifestVersion = $Matches[1]
if ($currentManifestVersion -ne $pluginVersion) {
    $manifestJsonRaw = $manifestJsonRaw -replace $manifestVersionPattern, "`"version`": `"$pluginVersion`""
    Set-Content -LiteralPath $manifestPath -Value $manifestJsonRaw -NoNewline -Encoding utf8
    Write-Host "Synced manifest.json version -> $pluginVersion"
}

# ─── 4. 自动构建项目 ───
$projectDir = $source
Write-Host "正在构建项目..."
$oldLocation = Get-Location
Set-Location -Path $projectDir

try {
    # 检查是否已经存在node_modules
    $nodeModulesExists = Test-Path -Path "node_modules"
    
    if (-not $nodeModulesExists) {
        Write-Host "首次运行，正在安装依赖..."
        npm install
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed"
        }
    }
    
    # 运行构建（dev 模式，产出 dist-dev/）
    npm run build:dev
    if ($LASTEXITCODE -ne 0) {
        throw "npm run build:dev failed"
    }
    
    Write-Host "✅ 构建完成！"
    Write-Host "UDT开发模式 - 插件已更新到 dist-dev/ 目录（默默配音助手dev）"
    Write-Host "打开 UXP Developer Tools 并重新加载插件即可测试"
} catch {
    Write-Host "❌ 构建失败: $_"
    Set-Location -Path $oldLocation
    exit 1
} finally {
    Set-Location -Path $oldLocation
}