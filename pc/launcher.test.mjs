import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
test('shared desktop launcher loads via tsx package on Windows and other platforms', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'scripts', 'start-shared-desktop.ts'), '--help'], { cwd: root, encoding: 'utf8', timeout: 15000, windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Usage:/)
})
