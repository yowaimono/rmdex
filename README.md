# rmdex

Codex thread client with a loopback-only local agent and an authenticated HTTPS/WSS relay. The local agent initiates outbound WSS; never expose the loopback control API to the internet.

Requirements: Node.js and a `codex` executable on PATH, signed in with the same
local Codex profile as the desktop app. Set `RMDEX_CODEX` to the executable's
absolute path if it is not on PATH.

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

## Remote relay

Build the relay image with `docker build -t rmdex-relay:local .`. Production configuration must provide `PUBLIC_ORIGIN=https://code.kyeai.xyz`, `RMDEX_ADMIN_HASH` (SHA-256 hex of an admin password of at least 24 characters), and a persistent `/data` volume. Put the relay behind HTTPS/WSS; never publish port 8787 directly. The computer agent requires `RMDEX_RELAY_URL=wss://code.kyeai.xyz/agent` and its one-time `RMDEX_DEVICE_TOKEN`. Pairing codes expire after three minutes and must be explicitly approved in the desktop device panel before the phone receives a client credential.
