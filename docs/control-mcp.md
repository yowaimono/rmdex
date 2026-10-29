# rmdex control MCP

`server/control-mcp.ts` is a deliberately small, permission-aware MCP facade for
rmdex. It follows the same newline-delimited JSON-RPC/MCP shape as the Desktop
MCP server, but it exposes a stable public contract instead of depending on the
private `codex_app` plugin pipe.

## Why this exists

The bundled Desktop MCP is an app-management bridge. Its schemas are useful for
listing/reading/sending Desktop chats, but they do not expose per-turn approval
or sandbox controls. This server puts those controls at the rmdex app-server
boundary, where they are already implemented and validated.

```text
MCP client (Codex/Desktop/Claude/etc.)
              |
              | stdio JSON-RPC
              v
       rmdex-control-mcp
              |
              | loopback HTTP
              v
       rmdex local agent
              |
              | Codex app-server protocol
              v
             codex
```

## Start

Start the local agent first, then configure an MCP client with:

```json
{
  "mcpServers": {
    "rmdex": {
      "command": "cmd.exe",
      "args": ["/d", "/s", "/c", "call", "D:/WorkSpace/rmdex/scripts/launch-control-mcp.cmd"],
      "env": {
        "RMDEX_MCP_AGENT_URL": "http://127.0.0.1:18787"
      }
    }
  }
}
```

For Windows, an absolute `node.exe` plus `tsx` can be used if the client does
not inherit PATH. The MCP process is loopback-only by default. Do not set
`RMDEX_MCP_ALLOW_REMOTE=1` unless the agent URL is protected by an independent
authentication layer.

## Tools

- `codex_capabilities` — protocol and permission mapping.
- `codex_list_models` — model catalog and reasoning efforts.
- `codex_list_threads` / `codex_read_thread` — conversations, live state, approvals.
- `codex_start_thread` — start a conversation in an absolute cwd.
- `codex_send_message` — send with `ask`, `auto`, or `full` mode, model, and effort.
- `codex_stop_turn` — interrupt a turn.
- `codex_list_approvals` / `codex_respond_approval` — inspect and answer approvals.
- `codex_wait_turn` — poll until a turn stops.

Every write requires an `operationId` UUID. This preserves rmdex's existing
idempotency/journal protection and prevents a timed-out MCP call from being
silently replayed.

## Deliberate boundary

This adapter does not pretend to be the private Desktop host bridge. It cannot
make the Windows Desktop window attach to the same app-server. It does provide a
clean integration point for any MCP-capable client, while rmdex remains the
policy/approval owner. A future Desktop plugin can call this same MCP facade or
its underlying HTTP contract without changing permission semantics.
