@echo off
setlocal
rem A private Node in .tools wins, so a machine can keep its own version. Otherwise the one on PATH, 22.19 or newer.
set "NODE=%~dp0..\.tools\node\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" "%~dp0..\src\cli.ts" %*
