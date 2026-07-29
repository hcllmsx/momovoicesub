#Requires -Version 5.1
<#
.SYNOPSIS
    默默配音助手安装器构建脚本 - 分离构建 DR 版和 PR 版
.DESCRIPTION
    1. 从 VERSION 文件读取 DR/PR 版本号
    2. 构建 PR 版
    3. 准备 payload（分别给 DR 和 PR）
    4. 分别编译 dr-setup.iss 和 pr-setup.iss 生成两个独立 exe
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
$drIssFile = Join-Path $installerDir 'dr-setup.iss'
$prIssFile = Join-Path $installerDir 'pr-setup.iss'

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
Write-Host '  MomoVoiceSub Installer Build (Dual Package)' -ForegroundColor Cyan
Write-Host '=======================================================' -ForegroundColor Cyan
Write-Host ''

# ─── 1. 读取版本号 ───
Write-Host '[1/6] 读取版本号...' -ForegroundColor Yellow
$drVersion = $null
$prVersion = $null
foreach ($line in Get-Content -LiteralPath $versionFile -Encoding UTF8) {
    $trimmed = $line.Trim()
    if ($trimmed -like 'com.momo.voicesub.dr.version=*') {
        $drVersion = $trimmed.Substring('com.momo.voicesub.dr.version='.Length).Trim()
    }
    if ($trimmed -like 'com.momo.voicesub.pr.version=*') {
        $prVersion = $trimmed.Substring('com.momo.voicesub.pr.version='.Length).Trim()
    }
}
if (-not $drVersion) { throw "VERSION 文件缺少 com.momo.voicesub.dr.version 条目" }
if (-not $prVersion) { throw "VERSION 文件缺少 com.momo.voicesub.pr.version 条目" }
Write-Host "  DR 插件版本: $drVersion" -ForegroundColor Green
Write-Host "  PR 插件版本: $prVersion" -ForegroundColor Green

# ─── 2. 构建 PR 版 ───
Write-Host ''
Write-Host '[2/6] 构建 PR 版插件...' -ForegroundColor Yellow
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

# ─── 3. 准备 DR payload ───
Write-Host ''
Write-Host '[3/6] 准备 DR payload...' -ForegroundColor Yellow
$drPayload = Join-Path $payloadDir 'dr'
if (Test-Path $payloadDir) { Remove-Item $payloadDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $drPayload | Out-Null

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

# 复制 WorkflowIntegration.node（从 ProgramData，作为兜底）
$officialNode = Join-Path $env:PROGRAMDATA 'Blackmagic Design\DaVinci Resolve\Support\Developer\Workflow Integrations\Examples\SamplePlugin\WorkflowIntegration.node'
if (Test-Path $officialNode) {
    Copy-Item $officialNode (Join-Path $drPayload 'WorkflowIntegration.node') -Force
    Write-Host '  已打包 WorkflowIntegration.node（兜底用）' -ForegroundColor Gray
} else {
    Write-Host '  ⚠️ 未找到 WorkflowIntegration.node，安装时将从用户机器复制' -ForegroundColor DarkYellow
}

# ─── 4. 准备 PR payload ───
Write-Host ''
Write-Host '[4/6] 准备 PR payload...' -ForegroundColor Yellow
$prPayload = Join-Path $payloadDir 'pr'
New-Item -ItemType Directory -Force -Path $prPayload | Out-Null

Write-Host '  复制 PR dist 文件...' -ForegroundColor Gray
$prDistDir = Join-Path $prAppDir 'dist'
Get-ChildItem -LiteralPath $prDistDir -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($prDistDir.Length).TrimStart('\', '/')
    $destination = Join-Path $prPayload $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
}

# ─── 5. 同步版本号到 .iss 并编译 DR 版 ───
Write-Host ''
Write-Host '[5/6] 编译 DR 安装包...' -ForegroundColor Yellow
$drIssRaw = Get-Content -LiteralPath $drIssFile -Raw -Encoding UTF8
$drIssRaw = $drIssRaw -replace '#define MyAppVersion "[^"]*"', "#define MyAppVersion `"$drVersion`""
$drIssRaw = $drIssRaw -replace '#define MyAppVersion "26\.7\.25"', "#define MyAppVersion `"$drVersion`""
Set-Content -LiteralPath $drIssFile -Value $drIssRaw -NoNewline -Encoding UTF8
Write-Host "  DR 安装包版本: $drVersion" -ForegroundColor Green

if (-not (Test-Path $outputDir)) {
    New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
}

& $iscc /Q $drIssFile
if ($LASTEXITCODE -ne 0) { throw "ISCC 编译 DR 版失败 (exit code: $LASTEXITCODE)" }

$drExePath = Join-Path $outputDir "momovoicesub-dr-setup-v$drVersion.exe"
if (Test-Path $drExePath) {
    $size = [math]::Round((Get-Item $drExePath).Length / 1MB, 2)
    Write-Host "  ✅ DR 安装包: $drExePath (${size} MB)" -ForegroundColor Green
} else {
    throw "编译成功但未找到 DR 输出文件: $drExePath"
}

# ─── 6. 同步版本号到 .iss 并编译 PR 版 ───
Write-Host ''
Write-Host '[6/6] 编译 PR 安装包...' -ForegroundColor Yellow
$prIssRaw = Get-Content -LiteralPath $prIssFile -Raw -Encoding UTF8
$prIssRaw = $prIssRaw -replace '#define MyAppVersion "[^"]*"', "#define MyAppVersion `"$prVersion`""
$prIssRaw = $prIssRaw -replace '#define MyAppVersion "26\.7\.26"', "#define MyAppVersion `"$prVersion`""
Set-Content -LiteralPath $prIssFile -Value $prIssRaw -NoNewline -Encoding UTF8
Write-Host "  PR 安装包版本: $prVersion" -ForegroundColor Green

& $iscc /Q $prIssFile
if ($LASTEXITCODE -ne 0) { throw "ISCC 编译 PR 版失败 (exit code: $LASTEXITCODE)" }

$prExePath = Join-Path $outputDir "momovoicesub-pr-setup-v$prVersion.exe"
if (Test-Path $prExePath) {
    $size = [math]::Round((Get-Item $prExePath).Length / 1MB, 2)
    Write-Host "  ✅ PR 安装包: $prExePath (${size} MB)" -ForegroundColor Green
} else {
    throw "编译成功但未找到 PR 输出文件: $prExePath"
}

Write-Host ''
Write-Host '=======================================================' -ForegroundColor Green
Write-Host '  BUILD SUCCESS!' -ForegroundColor Green
Write-Host "  DR: $drExePath" -ForegroundColor Green
Write-Host "  PR: $prExePath" -ForegroundColor Green
Write-Host '=======================================================' -ForegroundColor Green