# 定期重跑 wrapper：清除断点 → 启动采集 → 等待完成 → 等待 3 天 → 循环
# 日志追加到 periodic.log，进程脱离 IDE 会话运行

$intervalSeconds = 3 * 24 * 3600  # 3 天
$logFile = Join-Path $PSScriptRoot "periodic.log"
$errFile = Join-Path $PSScriptRoot "periodic.err.log"

Set-Location $PSScriptRoot

while ($true) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "[$timestamp] ===== 开始新一轮采集 =====" | Out-File -Append -FilePath $logFile -Encoding UTF8
    
    # 清除断点（从第 1 页重跑，捕捉新帖）
    "[$timestamp] 清除断点..." | Out-File -Append -FilePath $logFile -Encoding UTF8
    & npx tsx reset-state.ts 2>&1 | Out-File -Append -FilePath $logFile -Encoding UTF8
    
    # 启动采集（同步等待，直到完成）
    "[$timestamp] 启动采集..." | Out-File -Append -FilePath $logFile -Encoding UTF8
    & npx tsx collect-unified.ts 2>&1 | Out-File -Append -FilePath $logFile -Encoding UTF8
    $exitCode = $LASTEXITCODE
    
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "[$timestamp] 采集完成 (exit code: $exitCode)，等待 3 天后重跑" | Out-File -Append -FilePath $logFile -Encoding UTF8
    
    # 等待 3 天
    Start-Sleep -Seconds $intervalSeconds
}
