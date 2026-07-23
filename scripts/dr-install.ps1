$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot "apps\com.momo.voicesub.dr"
$targetRoot = Join-Path $env:PROGRAMDATA "Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins"
# 开发版使用独立的插件目录 Id，与正式安装版分开，达芬奇工作区菜单中会显示为「默默配音助手dev」
$devPluginId = "com.momo.voicesub.dr.dev"
$target = Join-Path $targetRoot $devPluginId
$officialWorkflowNode = Join-Path $env:PROGRAMDATA "Blackmagic Design\DaVinci Resolve\Support\Developer\Workflow Integrations\Examples\SamplePlugin\WorkflowIntegration.node"
$sourceWorkflowNode = Join-Path $source "WorkflowIntegration.node"
$targetWorkflowNode = Join-Path $target "WorkflowIntegration.node"
$packageJsonPath = Join-Path $source "package.json"
$manifestPath = Join-Path $source "manifest.xml"
$versionFilePath = Join-Path $repoRoot "VERSION"
$drVersionKey = "com.momo.voicesub.dr.version"

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
    throw "Plugin manifest.xml not found: $manifestPath"
}

if (-not (Test-Path -LiteralPath $officialWorkflowNode)) {
    throw "Official WorkflowIntegration.node not found: $officialWorkflowNode"
}

# ─── 1. 读取 VERSION 文件作为版本号唯一真相源 ───
$canonicalVersion = $null
foreach ($line in Get-Content -LiteralPath $versionFilePath -Encoding UTF8) {
    $trimmed = $line.Trim()
    if ($trimmed -like "$drVersionKey=*") {
        $canonicalVersion = $trimmed.Substring($drVersionKey.Length + 1).Trim()
        break
    }
}
if ([string]::IsNullOrWhiteSpace($canonicalVersion)) {
    throw "VERSION file is missing '$drVersionKey' entry: $versionFilePath"
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

# ─── 3. 同步 package.json → manifest.xml ───
$manifest = New-Object System.Xml.XmlDocument
$manifest.PreserveWhitespace = $true
$manifest.Load($manifestPath)
$versionNode = $manifest.SelectSingleNode("/BlackmagicDesign/Plugin/Version")
if ($null -eq $versionNode) {
    throw "manifest.xml is missing /BlackmagicDesign/Plugin/Version."
}
if ($versionNode.InnerText -ne $pluginVersion) {
    $versionNode.InnerText = $pluginVersion
    $writerSettings = New-Object System.Xml.XmlWriterSettings
    $writerSettings.Encoding = New-Object System.Text.UTF8Encoding($false)
    $writerSettings.Indent = $false
    $writer = [System.Xml.XmlWriter]::Create($manifestPath, $writerSettings)
    try {
        $manifest.Save($writer)
    }
    finally {
        $writer.Close()
    }
    Write-Host "Synced manifest.xml version -> $pluginVersion"
}
# 清理旧版本的安装目录
$oldTarget = Join-Path $targetRoot "com.momo.voicesub"
if (Test-Path -LiteralPath $oldTarget) {
    Remove-Item -LiteralPath $oldTarget -Recurse -Force | Out-Null
}

New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -LiteralPath $officialWorkflowNode -Destination $sourceWorkflowNode -Force

Get-ChildItem -LiteralPath $source -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($source.Length).TrimStart("\", "/")
    if ($relative -like "test\*") {
        return
    }
    if ($relative -eq "WorkflowIntegration.node") {
        return
    }

    $destination = Join-Path $target $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
}

try {
    Copy-Item -LiteralPath $officialWorkflowNode -Destination $targetWorkflowNode -Force
}
catch {
    Write-Warning "Failed to update WorkflowIntegration.node in target. Close DaVinci Resolve and run this installer again if you need the latest bridge file. $($_.Exception.Message)"
}

$testDir = Join-Path $target "test"
if (Test-Path -LiteralPath $testDir) {
    Remove-Item -LiteralPath $testDir -Recurse -Force
}

# ─── 4. 改写目标目录中的 manifest.xml，使其成为开发版 ───
# 源文件保持正式版不变，仅在安装到 dev 目录后就地改写 Id 与 Name
$targetManifest = Join-Path $target "manifest.xml"
if (Test-Path -LiteralPath $targetManifest) {
    $devManifest = New-Object System.Xml.XmlDocument
    $devManifest.PreserveWhitespace = $true
    $devManifest.Load($targetManifest)
    $idNode = $devManifest.SelectSingleNode("/BlackmagicDesign/Plugin/Id")
    $nameNode = $devManifest.SelectSingleNode("/BlackmagicDesign/Plugin/Name")
    if ($null -ne $idNode) { $idNode.InnerText = $devPluginId }
    if ($null -ne $nameNode) { $nameNode.InnerText = "默默配音助手dev" }
    $writerSettings = New-Object System.Xml.XmlWriterSettings
    $writerSettings.Encoding = New-Object System.Text.UTF8Encoding($false)
    $writerSettings.Indent = $false
    $writer = [System.Xml.XmlWriter]::Create($targetManifest, $writerSettings)
    try {
        $devManifest.Save($writer)
    }
    finally {
        $writer.Close()
    }
    Write-Host "Patched manifest.xml -> Id=$devPluginId, Name=默默配音助手dev"
} else {
    Write-Warning "manifest.xml not found in target, skipping dev patch: $targetManifest"
}

Write-Host "Installed 默默配音助手(dev) to:"
Write-Host $target
Write-Host "Restart DaVinci Resolve Studio, then open Workspace > Workflow Integrations > 默默配音助手dev."
