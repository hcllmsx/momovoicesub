#Requires -Version 5.1
<#
.SYNOPSIS
    PR 版 UXP 插件 PluginsInfo JSON 管理脚本
.DESCRIPTION
    安装时：向 %APPDATA%\Adobe\UXP\PluginsInfo\v1\premierepro.json 追加/更新插件记录
    卸载时：从该 JSON 移除插件记录
    直接文件复制 + JSON 操作，不依赖 UPIA / Creative Cloud Desktop。
.PARAMETER Action
    install | uninstall
.PARAMETER PluginId
    插件 ID，默认 com.momo.voicesub.pr
.PARAMETER Version
    插件版本号
.PARAMETER Name
    插件显示名称
.PARAMETER HostMinVersion
    PR 最低版本要求
.EXAMPLE
    pr-manage-json.ps1 -Action install -Version 0.26.722 -Name "默默配音助手" -HostMinVersion 25.6.0
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('install', 'uninstall')]
    [string]$Action,

    [string]$PluginId = 'com.momo.voicesub.pr',
    [string]$Version = '',
    [string]$Name = '默默配音助手',
    [string]$HostMinVersion = '25.6.0'
)

$ErrorActionPreference = 'Stop'

# ─── 定位 PluginsInfo JSON ───
$pluginsInfoDir = Join-Path $env:APPDATA 'Adobe\UXP\PluginsInfo\v1'
$jsonPath = Join-Path $pluginsInfoDir 'premierepro.json'

if (-not (Test-Path $pluginsInfoDir)) {
    New-Item -ItemType Directory -Force -Path $pluginsInfoDir | Out-Null
}

# ─── 读取或初始化 JSON ───
$plugins = @()
if (Test-Path $jsonPath) {
    try {
        $raw = Get-Content -LiteralPath $jsonPath -Raw -Encoding UTF8
        if (-not [string]::IsNullOrWhiteSpace($raw)) {
            $parsed = $raw | ConvertFrom-Json
            if ($parsed.plugins) {
                $plugins = @($parsed.plugins)
            }
        }
    } catch {
        Write-Warning "PluginsInfo JSON 解析失败，将重建。原始错误: $($_.Exception.Message)"
        # 备份损坏的文件
        $backup = "$jsonPath.bak.$([System.IO.Path]::GetRandomFileName().Split('.')[0])"
        Copy-Item $jsonPath $backup -Force -ErrorAction SilentlyContinue
        Write-Warning "已备份损坏的文件到: $backup"
        $plugins = @()
    }
}

# ─── 处理 install / uninstall ───
switch ($Action) {
    'install' {
        if ([string]::IsNullOrWhiteSpace($Version)) {
            throw "install 操作需要 -Version 参数"
        }

        # 插件在 External 下的目录名: <pluginId>_<version>
        $pluginDirName = "${PluginId}_${Version}"
        $entry = [ordered]@{
            hostMinVersion  = $HostMinVersion
            name            = $Name
            path            = "`$localPlugins\External\$pluginDirName"
            pluginId        = $PluginId
            status          = 'enabled'
            type            = 'uxp'
            versionString   = $Version
        }

        # 检查是否已有同 pluginId 的记录
        $existingIndex = -1
        for ($i = 0; $i -lt $plugins.Count; $i++) {
            if ($plugins[$i].pluginId -eq $PluginId) {
                $existingIndex = $i
                break
            }
        }

        if ($existingIndex -ge 0) {
            # 更新已有记录
            $plugins[$existingIndex] = [PSCustomObject]$entry
            Write-Host "已更新插件记录: $PluginId v$Version"
        } else {
            # 追加新记录
            $plugins = @($plugins) + [PSCustomObject]$entry
            Write-Host "已添加插件记录: $PluginId v$Version"
        }
    }

    'uninstall' {
        $before = $plugins.Count
        $plugins = @($plugins | Where-Object { $_.pluginId -ne $PluginId })
        $after = $plugins.Count
        if ($before -ne $after) {
            Write-Host "已移除插件记录: $PluginId (剩余 $after 条)"
        } else {
            Write-Host "未找到插件记录: $PluginId (无需操作)"
        }
    }
}

# ─── 写回 JSON ───
$result = [ordered]@{ plugins = $plugins }
$json = $result | ConvertTo-Json -Depth 5

# ConvertTo-Json 对单元素数组会退化成对象，这里确保 plugins 始终是数组
if ($plugins.Count -eq 0) {
    $json = '{"plugins":[]}'
} elseif ($plugins.Count -eq 1 -and $json -notmatch '"plugins"\s*:\s*\[') {
    # 单元素时手动修正
    $single = $plugins[0] | ConvertTo-Json -Depth 5 -Compress
    $json = "{`"plugins`":[$single]}"
}

Set-Content -LiteralPath $jsonPath -Value $json -NoNewline -Encoding UTF8
Write-Host "已写入: $jsonPath"
