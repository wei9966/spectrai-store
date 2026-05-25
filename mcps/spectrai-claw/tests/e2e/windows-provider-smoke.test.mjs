import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = resolve(__dirname, '..', '..')
const DIST_PROVIDER = resolve(PROJECT_ROOT, 'dist', 'computer-use', 'providers', 'windows', 'index.js')
const SMOKE_SCRIPT = resolve(PROJECT_ROOT, 'scripts', 'windows-provider-smoke.mjs')

function shouldSkipByEnvironment(t) {
  if (process.platform !== 'win32') {
    t.skip('Windows provider smoke is win32-only.')
    return true
  }
  if (!existsSync(DIST_PROVIDER)) {
    t.skip('dist/computer-use/providers/windows/index.js not found. Run `npm run build` first.')
    return true
  }
  if (!existsSync(SMOKE_SCRIPT)) {
    t.skip('scripts/windows-provider-smoke.mjs not found.')
    return true
  }
  return false
}

function runSmokeScript() {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [SMOKE_SCRIPT], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      rejectPromise(new Error(`windows-provider-smoke timed out. stdout=${stdout} stderr=${stderr}`))
    }, 90_000)

    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      rejectPromise(err)
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolvePromise({ code, stdout, stderr })
    })
  })
}

test('windows provider composition smoke: WinForms UIA/Win32 mutate actions', { timeout: 100_000 }, async (t) => {
  if (shouldSkipByEnvironment(t)) return

  const result = await runSmokeScript()
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)

  assert.equal(result.code, 0, `smoke script failed with code ${result.code}`)
  assert.match(result.stdout, /WINDOWS_PROVIDER_SMOKE_PASSED/)
  assert.match(result.stdout, /windows provider smoke artifact:/)
})
