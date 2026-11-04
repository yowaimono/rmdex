import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
test('shared desktop launcher loads via tsx package on Windows and other platforms', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'scripts', 'start-shared-desktop.ts'), '--help'], { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Usage:/)
})

for (const extension of ['cmd', 'bat']) {
  test(`shared desktop launcher runs a Windows .${extension} CLI shim`, { skip: process.platform !== 'win32' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rmdex-launcher-'))
    try {
      const shim = join(directory, `codex.${extension}`)
      await writeFile(shim, '@echo off\r\necho daemon-fixture:%*\r\nexit /b 23\r\n')
      const result = spawnSync(process.execPath, [
        '--import', 'tsx', join(root, 'scripts', 'start-shared-desktop.ts'),
        '--ensure-daemon', process.execPath,
      ], {
        cwd: root,
        env: { ...process.env, RMDEX_CODEX: shim },
        encoding: 'utf8', timeout: 15000, windowsHide: true,
      })
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stdout, /daemon-fixture:app-server daemon start/)
      assert.match(result.stderr, /Codex managed daemon failed to start \(exit 23\)/)
      assert.doesNotMatch(result.stderr, /spawn EINVAL/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}
