$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot "apps\com.momo.voicesub.dr"
$targetRoot = Join-Path $env:PROGRAMDATA "Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins"
$target = Join-Path $targetRoot "com.momo.voicesub.dr"
$officialWorkflowNode = Join-Path $env:PROGRAMDATA "Blackmagic Design\DaVinci Resolve\Support\Developer\Workflow Integrations\Examples\SamplePlugin\WorkflowIntegration.node"
$sourceWorkflowNode = Join-Path $source "WorkflowIntegration.node"
$targetWorkflowNode = Join-Path $target "WorkflowIntegration.node"
$packageJsonPath = Join-Path $source "package.json"
$manifestPath = Join-Path $source "manifest.xml"

if (-not (Test-Path -LiteralPath $source)) {
    throw "Plugin source not found: $source"
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

$packageInfo = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
$pluginVersion = [string]$packageInfo.version
if ([string]::IsNullOrWhiteSpace($pluginVersion)) {
    throw "package.json version is empty."
}

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
Write-Host "Installed 默默配音助手 to:"
Write-Host $target
Write-Host "Restart DaVinci Resolve Studio, then open Workspace > Workflow Integrations > 默默配音助手."
