#Requires -Version 5.1
<#
.SYNOPSIS
    默默配音助手安装器构建脚本
.DESCRIPTION
    1. 从 VERSION 文件读取版本号
    2. 构建 PR 版（npm run build → dist/）
    3. 准备 payload（DR 插件文件 + PR dist + 卸载脚本）
    4. 同步版本号到 .iss 脚本
    5. 调用 ISCC 编译生成 exe
.NOTES
    在项目根目录运行: powershell -ExecutionPolicy Bypass -File .\installer\build.ps1
#>

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$installerDir = $PSScriptRoot
$drAppDir = Join-Path $repoRoot 'apps\com.momo.voicesub.dr'
$prAppDir = Join-Path $repoRoot 'apps\com.momo.voicesub.pr'
$versionFile = Join-Path $repoRoot 'VERSION'
$payloadDir = Join-Path $installerDir 'payload'
$outputDir = Join-Path $repoRoot '_output'
$issFile = Join-Path $installerDir 'momovoicesub.iss'

# ISCC 路径（自动检测）
$isccCandidates = @(
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe"
)
$iscc = $null
foreach ($p in $isccCandidates) {
    if (Test-Path $p) { $iscc = $p; break }
}
if (-not $iscc) {
    throw "未找到 Inno Setup 编译器 (ISCC.exe)。请先安装: winget install JRSoftware.InnoSetup"
}

Write-Host ''
Write-Host '=======================================================' -ForegroundColor Cyan
Write-Host '  MomoVoiceSub Installer Build' -ForegroundColor Cyan
Write-Host '=======================================================' -ForegroundColor Cyan
Write-Host ''

# ─── 1. 读取版本号 ───
Write-Host '[1/5] 读取版本号...' -ForegroundColor Yellow
$drVersion = $null
$prVersion = $null
$setupVersion = $null
foreach ($line in Get-Content -LiteralPath $versionFile -Encoding UTF8) {
    $trimmed = $line.Trim()
    if ($trimmed -like 'com.momo.voicesub.dr.version=*') {
        $drVersion = $trimmed.Substring('com.momo.voicesub.dr.version='.Length).Trim()
    }
    if ($trimmed -like 'com.momo.voicesub.pr.version=*') {
        $prVersion = $trimmed.Substring('com.momo.voicesub.pr.version='.Length).Trim()
    }
    if ($trimmed -like 'com.momo.voicesub.setup.version=*') {
        $setupVersion = $trimmed.Substring('com.momo.voicesub.setup.version='.Length).Trim()
    }
}
if (-not $drVersion) { throw "VERSION 文件缺少 com.momo.voicesub.dr.version 条目" }
if (-not $prVersion) { throw "VERSION 文件缺少 com.momo.voicesub.pr.version 条目" }
if (-not $setupVersion) { throw "VERSION 文件缺少 com.momo.voicesub.setup.version 条目" }
Write-Host "  DR 插件: $drVersion" -ForegroundColor Green
Write-Host "  PR 插件: $prVersion" -ForegroundColor Green
Write-Host "  安装包:  $setupVersion" -ForegroundColor Green

# ─── 2. 构建 PR 版 ───
Write-Host ''
Write-Host '[2/5] 构建 PR 版插件...' -ForegroundColor Yellow
Push-Location $prAppDir
try {
    if (-not (Test-Path 'node_modules')) {
        Write-Host '  首次构建，安装依赖...' -ForegroundColor Gray
        npm install
        if ($LASTEXITCODE -ne 0) { throw 'npm install 失败' }
    }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build 失败' }
    Write-Host '  PR 构建完成' -ForegroundColor Green
} finally {
    Pop-Location
}

# ─── 3. 准备 payload ───
Write-Host ''
Write-Host '[3/5] 准备 payload...' -ForegroundColor Yellow
$drPayload = Join-Path $payloadDir 'dr'
$prPayload = Join-Path $payloadDir 'pr'

# 清理旧 payload
if (Test-Path $payloadDir) { Remove-Item $payloadDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $drPayload | Out-Null
New-Item -ItemType Directory -Force -Path $prPayload | Out-Null

# 复制 DR 插件文件（排除 test 目录）
Write-Host '  复制 DR 插件文件...' -ForegroundColor Gray
Get-ChildItem -LiteralPath $drAppDir -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($drAppDir.Length).TrimStart('\', '/')
    if ($relative -like 'test\*' -or $relative -like 'test/*') { return }
    if ($relative -eq 'WorkflowIntegration.node') { return }
    if ($relative -like 'docs\*' -or $relative -like 'docs/*') { return }
    $destination = Join-Path $drPayload $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
}

# 复制 PR dist 文件
Write-Host '  复制 PR dist 文件...' -ForegroundColor Gray
Get-ChildItem -LiteralPath (Join-Path $prAppDir 'dist') -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring((Join-Path $prAppDir 'dist').Length).TrimStart('\', '/')
    $destination = Join-Path $prPayload $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
}

# 复制 WorkflowIntegration.node（从 ProgramData，作为兜底）
$officialNode = Join-Path $env:PROGRAMDATA 'Blackmagic Design\DaVinci Resolve\Support\Developer\Workflow Integrations\Examples\SamplePlugin\WorkflowIntegration.node'
if (Test-Path $officialNode) {
    Copy-Item $officialNode (Join-Path $drPayload 'WorkflowIntegration.node') -Force
    Write-Host '  已打包 WorkflowIntegration.node（兜底用）' -ForegroundColor Gray
} else {
    Write-Host '  ⚠️ 未找到 WorkflowIntegration.node，安装时将从用户机器复制' -ForegroundColor DarkYellow
}

# ─── 4. 同步版本号到 .iss ───
Write-Host ''
Write-Host '[4/5] 同步版本号到 .iss...' -ForegroundColor Yellow
$issRaw = Get-Content -LiteralPath $issFile -Raw -Encoding UTF8
$issRaw = $issRaw -replace '#define MyAppVersion "[^"]*"', "#define MyAppVersion `"$setupVersion`""
$issRaw = $issRaw -replace '#define PrPluginVersion "[^"]*"', "#define PrPluginVersion `"$prVersion`""
Set-Content -LiteralPath $issFile -Value $issRaw -NoNewline -Encoding UTF8
Write-Host "  安装包版本: $setupVersion" -ForegroundColor Green
Write-Host "  PR 插件版本: $prVersion" -ForegroundColor Green

# ─── 5. 编译 ───
Write-Host ''
Write-Host '[5/5] 编译 exe...' -ForegroundColor Yellow
if (-not (Test-Path $outputDir)) {
    New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
}

& $iscc /Q $issFile
if ($LASTEXITCODE -ne 0) { throw "ISCC 编译失败 (exit code: $LASTEXITCODE)" }

$exePath = Join-Path $outputDir "momovoicesub-setup-v$setupVersion.exe"
if (Test-Path $exePath) {
    $size = [math]::Round((Get-Item $exePath).Length / 1MB, 2)
    Write-Host ''
    Write-Host '=======================================================' -ForegroundColor Green
    Write-Host '  BUILD SUCCESS!' -ForegroundColor Green
    Write-Host "  Output: $exePath" -ForegroundColor Green
    Write-Host "  Size: ${size} MB" -ForegroundColor Green
    Write-Host '=======================================================' -ForegroundColor Green
} else {
    throw "编译成功但未找到输出文件: $exePath"
}
