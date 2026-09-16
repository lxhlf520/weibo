@echo off
chcp 65001 >nul
echo ============================================
echo   批量启动微博浏览器（账号 1-5）
echo ============================================
echo.

for /L %%i in (1,1,5) do (
    echo 正在启动账号 %%i...
    start "weibo-%%i" cmd /c "%~dp0start-weibo-browser.bat" %%i
    timeout /t 3 /nobreak >nul
)

echo.
echo 全部账号已启动。在各自浏览器中完成登录后，回到平台导入。
echo.
pause
