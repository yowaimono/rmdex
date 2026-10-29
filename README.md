# rmdex

Codex thread client with a loopback-only local agent and an authenticated HTTPS/WSS relay. The local agent initiates outbound WSS; never expose the loopback control API to the internet.

## Permission-controlled mode (default)

The remote-agent launcher defaults to the standalone Codex app-server path. This
is intentional: it is the path that accepts per-turn `approvalPolicy`,
`approvalsReviewer`, and `sandboxPolicy` settings, so the web/mobile composer
can offer **请求审批**, **自动审查**, and **完全访问**, and pending approval
requests can be accepted or declined from the client.

Start the computer agent with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-remote-agent.ps1
```

An existing device token and relay registration are still required. Set
`RMDEX_CODEX` to the absolute `codex` executable path when it is not on PATH.

## Desktop-compatible app-server mode (Windows)

Set `RMDEX_CODEX_MODE=desktop` when you want the rmdex interface to use the
local Codex profile as a Desktop-compatible app-server client. It no longer uses
the private Desktop `codex_app` MCP bridge. Sessions are read through
`thread/list` and `thread/read`, while sends, stops, and approval decisions use
the app-server protocol with the same permission controls as the default mode.
This is the recommended replacement for the old Desktop MCP integration.

The old private Desktop MCP bridge remains available only as an explicit
rollback path: set `RMDEX_CODEX_MODE=desktop-legacy` and register the Desktop
context with `npm run desktop:register`. It does not support per-turn approval
changes and should not be used for the normal setup.

History loads ten turns at a time with an older-history button. Lists contain
local Codex chats returned by the connected app-server. New chats use the
absolute working directory selected in the composer. Approval requests are
surfaced in the conversation and can be accepted or declined from rmdex.

Models and reasoning efforts come from the connected host's model list,
refreshed at most every 30 seconds. No model names are hardcoded. Permission
mode is sent with every turn: `ask` maps to `approvalPolicy=on-request` plus the
user reviewer, `auto` maps to the automatic reviewer, and `full` maps to
`approvalPolicy=never` plus `dangerFullAccess`.
Writes have browser operation IDs and a local durable journal so a timed-out
or interrupted operation is not automatically replayed. An uncertain result
requires checking the target conversation before submitting another operation.
Requirements: Node.js and a `codex` executable on PATH, signed in with the same
local Codex profile as the desktop app. Set `RMDEX_CODEX` to the executable's
absolute path if it is not on PATH.

The default app-server mode starts its own local Codex app-server. Shared mode connects to the managed app-server daemon through the Codex proxy using WebSocket. The default socket is `%CODEX_HOME%/app-server-control/app-server-control.sock`; override it with `RMDEX_CODEX_SOCKET` when Codex reports a different path.

```sh
npm install
npm run agent
```

In a second terminal run `npm run dev`, then open the local URL printed by Vite.
The agent binds to `127.0.0.1:18787`; write requests are restricted to the
local Vite origin at `http://127.0.0.1:5173` or `http://localhost:5173`.
The experimental Codex app-server protocol and historical thread visibility
may vary between Codex versions. Active Desktop task synchronization is not
guaranteed.

### Shared Desktop connection

For manual startup, exit Codex Desktop completely first, then double-click the desktop shortcut `rmdex Shared Desktop.lnk`, or run `npm run desktop:shared:manual`. This mode fails fast with the Desktop app-server PID if the old Desktop process is still alive.

On Windows, Desktop normally starts its own app-server. The shared launcher
provides a loopback-only, randomly keyed WebSocket bridge to the managed
Codex daemon, then starts Desktop with `CODEX_APP_SERVER_WS_URL` pointing at
that bridge. The launcher waits for existing Desktop processes to exit instead
of terminating them. Keep the launcher running while Desktop uses it; stopping
it disconnects Desktop.

```powershell
npm run desktop:shared
```

The command starts the managed daemon and a shared rmdex agent, waits for the
current Desktop windows to close, and launches a new Desktop client against the
same app-server. New threads created through rmdex should then be visible in
Desktop, and Desktop-created threads should be visible through rmdex. The
bridge URL is loopback-only and must never be published. The isolated
server/bridge synchronization test is:

```sh
node --import tsx --test server/shared.integration.test.mjs
```

## Permission-aware MCP facade

rmdex also ships a small public MCP server at `server/control-mcp.ts`. It is
intentionally separate from the private Desktop `codex_app` MCP bridge: it
keeps rmdex as the policy owner and exposes explicit per-turn permission modes
through a stable stdio JSON-RPC interface.

Start the local agent first, then configure any MCP-capable client with:

```json
{
  "mcpServers": {
    "rmdex": {
      "command": "cmd.exe",
      "args": ["/d", "/s", "/c", "call", "D:/WorkSpace/rmdex/scripts/launch-control-mcp.cmd"],
      "env": { "RMDEX_MCP_AGENT_URL": "http://127.0.0.1:18787" }
    }
  }
}
```

The facade provides model/thread discovery, new thread, send, stop, wait,
approval listing and approval decisions. `codex_send_message` accepts:

- `ask`: `approvalPolicy=on-request`, user reviewer, `workspaceWrite` sandbox;
- `auto`: `approvalPolicy=on-request`, automatic reviewer, `workspaceWrite` sandbox;
- `full`: `approvalPolicy=never`, `dangerFullAccess` sandbox.

All write calls require a UUID `operationId`. The MCP process is loopback-only
by default; do not enable `RMDEX_MCP_ALLOW_REMOTE=1` without putting an
independent authenticated layer in front of the agent.

When the shared Desktop launcher is used, this control interface and the
Windows Desktop client operate on the same managed app-server, so a thread
created through rmdex can be opened by Desktop and vice versa. Without the
shared launcher, the default standalone agent remains intentionally isolated.
See [docs/control-mcp.md](docs/control-mcp.md) for the complete tool contract.
## Remote relay

Build the relay image with `docker build -t rmdex-relay:local .`. Production configuration must provide `PUBLIC_ORIGIN=https://code.kyeai.xyz`, `RMDEX_ADMIN_HASH` (SHA-256 hex of an admin password of at least 24 characters), and a persistent `/data` volume. Put the relay behind HTTPS/WSS; never publish port 8787 directly. The computer agent requires `RMDEX_RELAY_URL=wss://code.kyeai.xyz/agent` and its one-time `RMDEX_DEVICE_TOKEN`. Pairing codes expire after three minutes and must be explicitly approved in the desktop device panel before the phone receives a client credential.


## Android app

The Android app uses Capacitor and packages the same Vue interface; the web build remains supported. Native builds send API requests to `https://code.kyeai.xyz` using Capacitor's native HTTP bridge, and pairing links can be opened by the installed app.

Requirements: Node.js 22+, Android Studio 2025.2.1+, and Android SDK Platform 36. Install/accept the Android SDK licenses in Android Studio before building.

```sh
npm install
npm run android:sync
cd android
./gradlew assembleDebug
```

On Windows, use `gradlew.bat assembleDebug`. The debug APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. Use `npx cap open android` to open the native project in Android Studio.
