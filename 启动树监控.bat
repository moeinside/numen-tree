@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title Numen 树监控 treeview
cd /d "%~dp0"

set "MOCK="
if /i "%~1"=="--mock" set "MOCK=--mock"

echo ============================================================
echo   Numen 树监控 treeview  —— 独立只读工具
echo   （不改树、不控制同伴；树没开时只显示静态结构）
echo ============================================================
echo.

if not exist "tools\treeview\server.mjs" (
    echo [错误] 找不到 tools\treeview\server.mjs
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

rem ---- 已经在跑：直接开页面 ----
netstat -ano | findstr ":8780" | findstr "LISTENING" >nul
if not errorlevel 1 (
    echo [提示] treeview 已经在运行（8780），直接打开页面。
    start "" http://127.0.0.1:8780
    exit /b 0
)

rem ---- 树没在跑：提示离线 ----
netstat -ano | findstr ":8766" | findstr "LISTENING" >nul
if errorlevel 1 (
    echo [警告] 8766 没在监听——树进程没开。
    echo        现在打开页面只能看静态结构；先运行 启动树进程.bat，再刷新页面即可实时高亮。
    echo.
)

echo 正在启动 treeview...（会新开一个窗口，关掉它即停止）
echo   地址: http://127.0.0.1:8780
echo   模式: %MOCK%
echo.
start "treeview" cmd /k node tools\treeview\server.mjs %MOCK%
timeout /t 2 >nul
start "" http://127.0.0.1:8780
exit /b 0
