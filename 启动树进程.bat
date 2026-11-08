@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title Numen 树进程
cd /d "%~dp0"

echo ============================================================
echo   Numen 树进程  (numen-tree)
echo ============================================================
echo.

if not exist "src\daemon.mjs" (
    echo [错误] 找不到 src\daemon.mjs
    echo        这个 bat 必须放在 numen-tree 目录里。
    echo.
    pause
    exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 找不到 node。请先安装 Node.js 并加入 PATH。
    echo.
    pause
    exit /b 1
)

for /f "delims=" %%v in ('node --version 2^>nul') do set "NODEVER=%%v"
echo Node  : !NODEVER!
echo 目录  : %CD%
echo.

netstat -ano | findstr ":8765" | findstr "LISTENING" >nul
if errorlevel 1 (
    echo [警告] 8765 没在监听 —— Minecraft 没开，或 numen 的 MCP 服务没开。
    echo        树会先启动，等游戏就绪后自动接管。
    echo.
)

rem ---- 8767 被占用 = 已经有一个树进程在跑 ----
netstat -ano | findstr ":8767" | findstr "LISTENING" >nul
if not errorlevel 1 (
    set "OLDPID="
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8767" ^| findstr "LISTENING"') do set "OLDPID=%%p"
    echo [提示] 8767 已被占用 —— 已经有一个树进程在跑（PID: !OLDPID!）
    echo        两个实例会抢同一个同伴，必须先关掉旧的。
    echo.
    choice /C YN /T 5 /D Y /M "结束旧进程并启动新的吗（5 秒后自动选 Y）"
    if errorlevel 2 (
        echo 已取消。
        echo.
        pause
        exit /b 1
    )
    taskkill /PID !OLDPID! /F >nul 2>nul
    echo 已结束旧进程。
    timeout /t 2 >nul
)

echo 正在启动树进程……（Ctrl+C 或直接关窗口即可停止）
echo ------------------------------------------------------------
node src\daemon.mjs
set "CODE=!ERRORLEVEL!"
echo ------------------------------------------------------------
echo.
echo 树进程已退出，退出码 !CODE!
if not "!CODE!"=="0" (
    echo 常见原因：端口被占 / 游戏没开 / 代码有错。
)
echo 详细日志：logs\trace-*.jsonl
echo.
pause