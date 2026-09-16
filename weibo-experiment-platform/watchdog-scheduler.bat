@echo off
REM ============================================================================
REM 微博调度器守护脚本
REM   自动重启崩溃的调度器，最大 5 次/小时
REM ============================================================================
setlocal enabledelayedexpansion

set MAX_RESTARTS=5
set RESTART_COUNT=0
set WINDOW_START=

cd /d %~dp0

:loop
REM 每小时重置计数器
for /f "tokens=1 delims=:" %%a in ("%TIME%") do set CURRENT_HOUR=%%a
if not defined WINDOW_START set WINDOW_START=%CURRENT_HOUR%
if not "%CURRENT_HOUR%"=="%WINDOW_START%" (
    set RESTART_COUNT=0
    set WINDOW_START=%CURRENT_HOUR%
    echo [%date% %time%] 新的一小时，重启计数器重置
)

if !RESTART_COUNT! geq %MAX_RESTARTS% (
    echo [%date% %time%] 已达本小时最大重启次数 !RESTART_COUNT!/%MAX_RESTARTS%，停止守护
    exit /b 1
)

echo [%date% %time%] 启动调度器 (第 !RESTART_COUNT! 次重启)
npx tsx src/jobs/scheduler.ts
set EXIT_CODE=%ERRORLEVEL%

echo [%date% %time%] 调度器退出，退出码: %EXIT_CODE%
set /a RESTART_COUNT+=1

REM 退避等待：第1次 10s，之后每次翻倍，最大 120s
if !RESTART_COUNT! equ 1 (
    timeout /t 10 /nobreak >nul
) else if !RESTART_COUNT! equ 2 (
    timeout /t 20 /nobreak >nul
) else if !RESTART_COUNT! equ 3 (
    timeout /t 40 /nobreak >nul
) else (
    timeout /t 60 /nobreak >nul
)

goto loop
