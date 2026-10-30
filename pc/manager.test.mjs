import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { isCodexDesktopProcess } from './manager.ts'

test('managed Codex daemon processes are not treated as Desktop processes', () => {
  assert.equal(isCodexDesktopProcess('codex.exe app-server --listen unix:// --analytics-default-enabled --managed-daemon'), false)
  assert.equal(isCodexDesktopProcess('codex.exe app-server daemon pid-update-loop'), false)
})

test('Codex Desktop app-server processes are treated as Desktop processes', () => {
  assert.equal(isCodexDesktopProcess('codex.exe app-server proxy --sock C:\\Users\\Chinese\\.codex\\app-server-control\\app-server-control.sock'), true)
  assert.equal(isCodexDesktopProcess('codex.exe -c features.code_mode_host=true app-server --analytics-default-enabled'), true)
  assert.equal(isCodexDesktopProcess('codex.exe -c plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true'), true)
})
