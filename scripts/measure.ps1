<#
  ingfy 资源占用测量
  用法：先把 ingfy 开起来（正式版或 pnpm tauri dev 都行），然后在项目根目录运行：
    powershell -ExecutionPolicy Bypass -File scripts\measure.ps1
  可选参数：-Minutes 10（测多久，默认 3 分钟）  -Every 5（几秒采一次，默认 5 秒）
  统计的是 ingfy.exe 和它启动的所有 WebView2 进程（msedgewebview2.exe）加起来的总量。
  "内存"一列是专用内存（Private Bytes），一般比任务管理器"内存"列略高一点；"工作集"是实际占着的物理内存。
#>
param([int]$Minutes = 3, [int]$Every = 5)
$ErrorActionPreference = 'SilentlyContinue'
$cores = [Environment]::ProcessorCount

function Get-IngfyTree {
  $all = @(Get-CimInstance Win32_Process)
  $ids = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($p in $all) { if ($p.Name -eq 'ingfy.exe') { [void]$ids.Add([int]$p.ProcessId) } }
  if ($ids.Count -eq 0) { return @() }
  do {
    $added = $false
    foreach ($p in $all) {
      if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added = $true }
    }
  } while ($added)
  return @($all | Where-Object { $ids.Contains([int]$_.ProcessId) })
}

function Get-Kind($p) {
  if ($p.Name -eq 'ingfy.exe') { return 'ingfy（Rust 后端）' }
  if ($p.CommandLine -match '--type=renderer') { return 'WebView2 页面' }
  if ($p.CommandLine -match '--type=gpu-process') { return 'WebView2 GPU' }
  if ($p.CommandLine -match '--type=utility') { return 'WebView2 工具进程' }
  if ($p.CommandLine -match '--type=crashpad') { return 'WebView2 崩溃上报' }
  return 'WebView2 主进程'
}

$tree = Get-IngfyTree
if ($tree.Count -eq 0) { Write-Host '没找到正在运行的 ingfy.exe，先把软件打开再运行这个脚本。' -ForegroundColor Yellow; exit 1 }

$out = Join-Path $PSScriptRoot ("memory-{0}.csv" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$rows = @()
$prevCpu = @{}
$prevTime = Get-Date
$end = (Get-Date).AddMinutes($Minutes)
Write-Host ("开始测量，共 {0} 分钟，每 {1} 秒一次。期间可以正常使用：切页面、播歌、开关桌面歌词、缩到托盘。" -f $Minutes, $Every)
Write-Host ''
Write-Host ('时间      内存(MB)  工作集(MB)  CPU%   进程数')

while ((Get-Date) -lt $end) {
  $tree = Get-IngfyTree
  if ($tree.Count -eq 0) { Write-Host 'ingfy 已退出，停止测量。'; break }
  $now = Get-Date
  $dt = ($now - $prevTime).TotalSeconds
  $mem = 0; $ws = 0; $cpuDelta = 0
  foreach ($p in $tree) {
    $gp = Get-Process -Id $p.ProcessId
    if (-not $gp) { continue }
    $mem += $gp.PrivateMemorySize64
    $ws += $gp.WorkingSet64
    $cpu = $gp.TotalProcessorTime.TotalSeconds
    if ($prevCpu.ContainsKey($p.ProcessId)) { $cpuDelta += $cpu - $prevCpu[$p.ProcessId] }
    $prevCpu[$p.ProcessId] = $cpu
  }
  $cpuPct = 0
  if ($rows.Count -gt 0 -and $dt -gt 0) { $cpuPct = [math]::Round($cpuDelta / $dt / $cores * 100, 1) }
  $row = [pscustomobject]@{
    Time = $now.ToString('HH:mm:ss')
    PrivateMB = [math]::Round($mem / 1MB, 1)
    WorkingSetMB = [math]::Round($ws / 1MB, 1)
    CpuPercent = $cpuPct
    Processes = $tree.Count
  }
  $rows += $row
  Write-Host ('{0}  {1,8}  {2,10}  {3,5}  {4,6}' -f $row.Time, $row.PrivateMB, $row.WorkingSetMB, $row.CpuPercent, $row.Processes)
  $prevTime = $now
  Start-Sleep -Seconds $Every
}

$rows | Export-Csv -Path $out -NoTypeInformation -Encoding UTF8

Write-Host ''
Write-Host '==== 汇总 ====' -ForegroundColor Cyan
if ($rows.Count -gt 0) {
  $m = $rows | Measure-Object PrivateMB -Minimum -Maximum -Average
  $c = $rows | Select-Object -Skip 1 | Measure-Object CpuPercent -Average -Maximum
  Write-Host ('内存：最低 {0} MB，最高 {1} MB，平均 {2} MB' -f $m.Minimum, $m.Maximum, [math]::Round($m.Average, 1))
  Write-Host ('内存变化：开始 {0} MB → 结束 {1} MB（差 {2} MB）' -f $rows[0].PrivateMB, $rows[-1].PrivateMB, [math]::Round($rows[-1].PrivateMB - $rows[0].PrivateMB, 1))
  if ($c.Count -gt 0) { Write-Host ('CPU：平均 {0}%，最高 {1}%（按全部 {2} 个核算）' -f [math]::Round($c.Average, 1), $c.Maximum, $cores) }
}

Write-Host ''
Write-Host '==== 按进程分 ====' -ForegroundColor Cyan
$tree = Get-IngfyTree
$tree | ForEach-Object {
  $gp = Get-Process -Id $_.ProcessId
  [pscustomobject]@{ 类型 = (Get-Kind $_); PID = $_.ProcessId; '内存(MB)' = [math]::Round($gp.PrivateMemorySize64 / 1MB, 1) }
} | Sort-Object '内存(MB)' -Descending | Format-Table -AutoSize

Write-Host '==== 体积 ====' -ForegroundColor Cyan
$root = Split-Path $PSScriptRoot -Parent
foreach ($f in @('src-tauri\target\release\ingfy.exe', 'src-tauri\target\release\bundle\nsis')) {
  $path = Join-Path $root $f
  if (Test-Path $path) {
    $size = (Get-ChildItem $path -Recurse -File | Measure-Object Length -Sum).Sum
    Write-Host ('{0}：{1} MB' -f $f, [math]::Round($size / 1MB, 2))
  }
}
Write-Host ''
Write-Host "每次采样的数据存在 $out"
Write-Host '把上面的输出整段复制给 Claude 就行。'
