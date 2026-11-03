import assert from 'node:assert/strict'
import { test } from 'node:test'
import { synthesize } from './skills/rmdex-employee/voice.mjs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { readEmployeeVoice } from './voice-store.ts'

test('voice helper reuses an existing message and rejects a changed payload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rmdex-voice-helper-'))
  const id = '53f016d0-aed5-4bf1-a97a-1d1b02e1e733'
  try {
    const helper = join(dir, 'voice.mjs'), bootstrap = join(dir, 'mock.mjs'), textPath = join(dir, 'text.txt'), log = join(dir, 'calls.log')
    await copyFile(new URL('./skills/rmdex-employee/voice.mjs', import.meta.url), helper)
    await mkdir(join(dir, 'voice'))
    await writeFile(join(dir, 'communication.json'), JSON.stringify({ origin: 'https://relay.example', token: 'test-token' }))
    const wav = Buffer.alloc(44); wav.write('RIFF'); wav.write('WAVE', 8)
    await writeFile(join(dir, 'voice', 'sample.wav'), wav)
    await writeFile(textPath, '你好')
    await writeFile(bootstrap, `import { appendFile } from 'node:fs/promises'; globalThis.fetch = async (url, options) => { if (String(url).includes('voice-context')) return new Response(JSON.stringify({userId:'user',employeeId:'employee',threadId:'thread'})); await appendFile(${JSON.stringify(log)}, 'request\\n'); return new Response(JSON.stringify({choices:[{message:{audio:{data:${JSON.stringify(wav.toString('base64'))}}}}]})); };`)
    const run = () => new Promise(resolve => {
      const child = spawn(process.execPath, ['--import', pathToFileURL(bootstrap).href, helper, 'send', '--file', textPath, '--id', id], { env: { ...process.env, MIMO_API_KEY: 'test-key' }, windowsHide: true })
      let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk }); child.on('close', code => resolve({ code, stdout, stderr }))
    })
    const first = await run(), second = await run()
    assert.equal(first.code, 0, first.stderr)
    assert.equal(second.code, 0, second.stderr)
    assert.equal(first.stdout, second.stdout)
    assert.match(first.stdout, /<rmdex_voice/)
    assert.equal((await readFile(log, 'utf8')).trim(), 'request')
    assert.equal((await readFile(join(dir, 'voice', `${id}.json`), 'utf8')).includes('你好'), false)
    await writeFile(textPath, '改变内容')
    assert.match((await run()).stderr, /同一消息 ID/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('stored voice is readable only with matching employee and thread', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rmdex-voice-'))
  const id = '53f016d0-aed5-4bf1-a97a-1d1b02e1e733'
  try {
    const folder = join(home, 'rmdex', 'employees', 'user', 'employee', 'voice')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, `${id}.json`), JSON.stringify({ threadId: 'thread-one' }))
    await writeFile(join(folder, `${id}.wav`), 'audio')
    assert.equal((await readEmployeeVoice(home, 'user', 'employee', 'thread-one', id)).toString(), 'audio')
    assert.equal(await readEmployeeVoice(home, 'user', 'employee', 'thread-two', id), null)
    assert.equal(await readEmployeeVoice(home, 'other', 'employee', 'thread-one', id), null)
    assert.equal(await readEmployeeVoice(home, '../other', 'employee', 'thread-one', id), null)
    await writeFile(join(folder, `${id}.json`), '{invalid')
    assert.equal(await readEmployeeVoice(home, 'user', 'employee', 'thread-one', id), null)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('MiMo voice clone sends the reference and rejects invalid audio', async () => {
  const originalFetch = globalThis.fetch, previousKey = process.env.MIMO_API_KEY
  process.env.MIMO_API_KEY = 'test-key'
  const wav = Buffer.alloc(44)
  wav.write('RIFF', 0); wav.write('WAVE', 8)
  let calls = 0
  globalThis.fetch = async (url, init) => {
    calls++
    assert.equal(url, 'https://api.xiaomimimo.com/v1/chat/completions')
    assert.equal(init.redirect, 'error')
    const body = JSON.parse(init.body)
    assert.equal(body.model, 'mimo-v2.5-tts-voiceclone')
    assert.equal(body.messages[1].content, '你好')
    assert.equal(body.audio.voice, 'data:audio/wav;base64,c2FtcGxl')
    return new Response(JSON.stringify({ choices: [{ message: { audio: { data: (calls === 1 ? wav : Buffer.from('not wav')).toString('base64') } } }] }), { status: 200 })
  }
  try {
    assert.deepEqual(await synthesize('mimo-v2.5-tts-voiceclone', '你好', 'data:audio/wav;base64,c2FtcGxl'), wav)
    await assert.rejects(synthesize('mimo-v2.5-tts-voiceclone', '你好', 'data:audio/wav;base64,c2FtcGxl'), /WAV/)
  } finally {
    globalThis.fetch = originalFetch
    if (previousKey === undefined) delete process.env.MIMO_API_KEY
    else process.env.MIMO_API_KEY = previousKey
  }
})
