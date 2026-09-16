@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

set CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
set ACCOUNT=%1

if "%ACCOUNT%"=="" (
    echo 用法: start-weibo-browser.bat [账号序号]
    echo 示例: start-weibo-browser.bat 1    启动账号 1（端口 9222）
    echo        start-weibo-browser.bat 2    启动账号 2（端口 9223）
    echo        start-weibo-browser.bat 3    启动账号 3（端口 9224）
    echo.
    set /p ACCOUNT="请输入账号序号: "
)

set /a CDP_PORT=9221 + %ACCOUNT%
set PROFILE_DIR=%~dp0chrome-weibo-profile-%ACCOUNT%

echo ============================================
echo   微博指纹浏览器 - 账号 %ACCOUNT%
echo   CDP 端口: %CDP_PORT%
echo   Profile: %PROFILE_DIR%
echo ============================================

if not exist "%CHROME_PATH%" (
    echo [错误] 未找到 Chrome，请检查路径: %CHROME_PATH%
    pause
    exit /b 1
)

echo 正在启动 Chrome...
start "" "%CHROME_PATH%" ^
    --remote-debugging-port=%CDP_PORT% ^
    --user-data-dir="%PROFILE_DIR%" ^
    --no-first-run ^
    --no-default-browser-check ^
    https://weibo.com

echo.
echo Chrome 已启动（账号 %ACCOUNT%，端口 %CDP_PORT%）。
echo 在浏览器中完成微博登录后，在平台选择对应端口导入。
echo.
if "%1"=="" pause >nul
exit /b 0
