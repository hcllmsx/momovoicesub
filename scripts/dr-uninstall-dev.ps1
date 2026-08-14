$ErrorActionPreference = "Stop"

# 默默配音助手 DaVinci Resolve 版 dev 卸载脚本
# 删除 dev 版插件目录（com.momo.voicesub.dr.dev），使达芬奇工作区菜单不再显示「默默配音助手dev」。
# 仅删除 dev 版，不影响正式安装版（com.momo.voicesub.dr）。
# 与 scripts\dr-install.ps1 对称：安装用 dr-install.ps1，卸载用本脚本。

$targetRoot = Join-Path $env:PROGRAMDATA "Blackmagic Design\DaVinci Resolve\Support\Workflow Integration Plugins"
$devPluginId = "com.momo.voicesub.dr.dev"
$devTarget = Join-Path $targetRoot $devPluginId

# dev 版用户数据目录（与 main.js 的 getAppDataDir() 一致）
$devDataDir = Join-Path $env:APPDATA "momovoicesub-$devPluginId"

if (-not (Test-Path -LiteralPath $devTarget)) {
    Write-Host "未找到 dev 版插件目录，无需卸载："
    Write-Host $devTarget
} else {
    try {
        Remove-Item -LiteralPath $devTarget -Recurse -Force | Out-Null
    } catch {
        $msg = "删除 dev 版插件目录失败，请确认达芬奇已关闭后重试：$devTarget"
        throw "$msg`n$($_.Exception.Message)"
    }
    Write-Host "已卸载默默配音助手(dev)，删除目录："
    Write-Host $devTarget
}

# 询问是否删除 dev 版用户数据（设置、自填Key、登录状态、缓存等）
if (Test-Path -LiteralPath $devDataDir) {
    Write-Host ""
    Write-Host "检测到 dev 版用户数据目录："
    Write-Host $devDataDir
    Write-Host "包含：设置、自填Key、云端登录状态、多音字词典、缓存等。"
    Write-Host ""
    $answer = Read-Host "是否同时删除以上用户数据？[y/N]（回车默认不删除）"
    if ($answer -and $answer.Trim() -match '^[yY]') {
        try {
            Remove-Item -LiteralPath $devDataDir -Recurse -Force | Out-Null
            Write-Host "已删除 dev 版用户数据：$devDataDir"
        } catch {
            Write-Warning "删除 dev 版用户数据失败：$devDataDir"
            Write-Warning $_.Exception.Message
        }
    } else {
        Write-Host "已保留 dev 版用户数据：$devDataDir"
    }
} else {
    Write-Host ""
    Write-Host "dev 版用户数据目录不存在，无需清理：$devDataDir"
}

Write-Host ""
Write-Host "重启 DaVinci Resolve Studio 后，工作区 > 流程整合 中将不再显示 dev 版。"
