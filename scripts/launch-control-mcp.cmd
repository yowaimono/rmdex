@echo off
setlocal
set "ROOT=%~dp0.."
if not defined RMDEX_MCP_AGENT_URL set "RMDEX_MCP_AGENT_URL=http://127.0.0.1:18787"
cd /d "%ROOT%"
if exist "%ROOT%\node_modules\.bin\tsx.cmd" (
  call "%ROOT%\node_modules\.bin\tsx.cmd" server\control-mcp.ts
  exit /b %errorlevel%
)
node --import tsx server\control-mcp.ts
