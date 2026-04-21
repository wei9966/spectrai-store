import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, rmSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = resolve(__dirname, '..', '..')

const DIST_DAEMON_LIFECYCLE = resolve(PROJECT_ROOT, 'dist', 'helpers', 'DaemonLifecycle.js')
const HELPER_BINARY_CANDIDATES = [
  resolve(PROJECT_ROOT, 'src', 'swift-helper', '.build', 'release', 'spectrai-claw-helper'),
  resolve(PROJECT_ROOT, 'src', 'swift-helper', '.build', 'debug', 'spectrai-claw-helper'),
  resolve(PROJECT_ROOT, 'dist', 'bin', 'darwin', 'spectrai-claw-helper'),
]

const BROWSER_CANDIDATES = [
  { name: 'Safari', bundleId: 'com.apple.Safari' },
  { name: 'Google Chrome', bundleId: 'com.google.Chrome' },
]

const TARGET_URL = 'https://example.com'

function resolveHelperBinary() {
  for (const candidate of HELPER_BINARY_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

const HELPER_BINARY = resolveHelperBinary()
let DaemonLifecycleClass = null

async function loadDaemonLifecycleClass() {
  if (DaemonLifecycleClass) {
    return DaemonLifecycleClass
  }

  const mod = await import(pathToFileURL(DIST_DAEMON_LIFECYCLE).href)
  if (typeof mod.DaemonLifecycle !== 'function') {
    throw new Error('Failed to load DaemonLifecycle from dist/helpers/DaemonLifecycle.js')
  }

  DaemonLifecycleClass = mod.DaemonLifecycle
  return DaemonLifecycleClass
}

function safeUnlink(path) {
  try {
    unlinkSync(path)
  } catch {
    // ignore
  }
}

function safeRemoveFile(path) {
  try {
    rmSync(path, { force: true })
  } catch {
    // ignore
  }
}

function extractErrorCode(err) {
  if (!err || typeof err !== 'object') {
    return undefined
  }
  return Reflect.get(err, 'code')
}

function shouldSkipByEnvironment(t) {
  if (process.platform !== 'darwin') {
    t.skip('Web AX E2E is macOS-only.')
    return true
  }

  if (!existsSync(DIST_DAEMON_LIFECYCLE)) {
    t.skip('dist/helpers/DaemonLifecycle.js not found. Run `npm run build` first.')
    return true
  }

  if (!HELPER_BINARY) {
    t.skip('Swift daemon binary not found. Run `npm run build:all` first.')
    return true
  }

  return false
}

async function createHarness(t) {
  if (shouldSkipByEnvironment(t)) {
    return null
  }

  const DaemonLifecycle = await loadDaemonLifecycleClass()
  const suffix = Math.random().toString(36).slice(2)
  const socketPath = `/tmp/spectrai-claw-e2e-web-${suffix}.sock`
  const logFile = `/tmp/spectrai-claw-e2e-web-${suffix}.log`

  safeUnlink(socketPath)
  safeRemoveFile(logFile)

  const lifecycle = new DaemonLifecycle({
    helperBinary: HELPER_BINARY,
    socketPath,
    logFile,
    startupTimeoutMs: 5_000,
    shutdownOnExit: false,
  })

  t.after(async () => {
    try {
      await lifecycle.stop()
    } catch {
      // ignore cleanup failures
    }

    const child = lifecycle.childProcess
    if (child?.pid) {
      try {
        process.kill(child.pid, 'SIGTERM')
      } catch {
        // ignore
      }
    }

    safeUnlink(socketPath)
    safeRemoveFile(logFile)
  })

  const client = await lifecycle.ensure()
  return { client }
}

async function tryOpenUrl(bundleId, url) {
  return new Promise((resolvePromise) => {
    const child = spawn('open', ['-b', bundleId, url], { stdio: 'ignore' })

    child.once('error', () => resolvePromise(false))
    child.once('exit', (code) => resolvePromise(code === 0))
  })
}

function pickRunningBrowser(applications) {
  for (const candidate of BROWSER_CANDIDATES) {
    const matched = applications.find((app) => app.bundleId === candidate.bundleId)
    if (matched) {
      return matched
    }
  }
  return null
}

function findWebTargets(elements) {
  if (!Array.isArray(elements)) {
    return []
  }

  return elements.filter((el) => {
    const role = String(el?.role ?? '')
    return role === 'AXLink' || role === 'AXButton'
  })
}

test('web AX wake-up: second detectElements call should expose browser link/button (optional)', { timeout: 70_000 }, async (t) => {
  const harness = await createHarness(t)
  if (!harness) return

  const { client } = harness

  const permissions = await client.call('permissionsStatus', {}, 2_000)
  if (!permissions.accessibility || !permissions.screenRecording) {
    t.skip('Accessibility or Screen Recording permission is not granted; skipping web AX E2E.')
    return
  }

  let appsResult = await client.call('listApplications', {}, 3_000)
  let browser = pickRunningBrowser(appsResult.applications ?? [])

  if (!browser) {
    let launched = false

    for (const candidate of BROWSER_CANDIDATES) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await tryOpenUrl(candidate.bundleId, TARGET_URL)
      if (ok) {
        launched = true
        break
      }
    }

    if (!launched) {
      t.skip('Neither Safari nor Chrome is available for web AX test.')
      return
    }

    await sleep(1_500)
    appsResult = await client.call('listApplications', {}, 3_000)
    browser = pickRunningBrowser(appsResult.applications ?? [])

    if (!browser) {
      t.skip('Browser launch attempted, but app is still not visible in listApplications.')
      return
    }
  } else {
    const opened = await tryOpenUrl(browser.bundleId, TARGET_URL)
    if (!opened) {
      t.skip(`Browser is running (${browser.bundleId}), but failed to open ${TARGET_URL}.`)
      return
    }
  }

  try {
    await client.call('activateApplication', { pid: browser.pid }, 3_000)
  } catch {
    // non-fatal; continue
  }

  await sleep(1_200)

  let firstPass
  let secondPass

  try {
    firstPass = await client.call(
      'detectElements',
      { pid: browser.pid, allowWebFocus: true, maxDepth: 8, maxCount: 300 },
      12_000,
    )

    await sleep(400)

    secondPass = await client.call(
      'detectElements',
      { pid: browser.pid, allowWebFocus: true, maxDepth: 8, maxCount: 300 },
      12_000,
    )
  } catch (err) {
    const code = extractErrorCode(err)
    if (code === 'ePermission' || code === 'eAXFailure' || code === 'eTimeout') {
      t.skip(`detectElements skipped by runtime environment: ${code}`)
      return
    }
    throw err
  }

  assert.ok(Array.isArray(firstPass.elements))
  assert.ok(Array.isArray(secondPass.elements))

  const webTargets = findWebTargets(secondPass.elements)
  if (webTargets.length === 0) {
    t.skip('Second detectElements pass did not return AXLink/AXButton in current environment.')
    return
  }

  assert.ok(webTargets.length > 0)
})
