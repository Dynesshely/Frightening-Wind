# Frightening-Wind -> Screeps 客户端 同步脚本（模板）
#
# 用法：
#   1. 复制本文件为 deploy.ps1（deploy.ps1 已被 .gitignore 忽略，不会入库）
#   2. 按自己的环境修改 $dst 路径
#   3. pwsh -File tools/deploy.ps1

$repoRoot = Split-Path -Parent $PSScriptRoot
$src      = Join-Path $repoRoot 'src'
$dst      = "$env:USERPROFILE\AppData\Local\Screeps\scripts\YOUR_SERVER_ID\default"

if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }

$files = Get-ChildItem $src -Filter *.js -File
foreach ($f in $files) { Copy-Item $f.FullName (Join-Path $dst $f.Name) -Force }

# 清理目标目录里已从仓库删除的 js
Get-ChildItem $dst -Filter *.js -File | ForEach-Object {
    if (-not (Test-Path (Join-Path $src $_.Name))) {
        Remove-Item $_.FullName -Force
        Write-Output ("removed: " + $_.Name)
    }
}

Write-Output ("deployed {0} files" -f $files.Count)
