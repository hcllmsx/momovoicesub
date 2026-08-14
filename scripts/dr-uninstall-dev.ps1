$ErrorActionPreference = "Stop"

# 默默配音助手DaVinci Resolve版dev卸载脚本
# 删除 dev 版插件目录（com.momo.voicesub.dr.dev），使达芬奇工作区菜单不再显示「默默配音助手dev」。
# 仅删除 dev 版，不影响正式安装版（com.momo.voicesub.dr）。
# 与 scripts\dr-install.ps1 对称：安装用 dr-install.ps1，卸载用本脚本。

$targetRoot = Join-Path $env:PROGRAMDATA "Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins"
$devPluginId = "com.momo.voicesub.dr.dev"
$devTarget = Join-Path $targetRoot $devPluginId

if (-not (Test-Path -LiteralPath $devTarget)) {
    Write-Host "未找到 dev 版插件目录，无需卸载："
    Write-Host $devTarget
    exit 0
}

try {
    Remove-Item -LiteralPath $devTarget -Recurse -Force | Out-Null
} catch {
    $msg = "删除 dev 版插件目录失败，请确认达芬奇已关闭后重试：$devTarget"
    throw "$msg`n$($_.Exception.Message)"
}

Write-Host "已卸载默默配音助手(dev)，删除目录："
Write-Host $devTarget
Write-Host "重启 DaVinci Resolve Studio 后，工作区 > 流程整合 中将不再显示 dev 版。"
