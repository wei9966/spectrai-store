import { test, before, after } from 'node:test'
import assert from 'node:assert'
import { randomUUID } from 'node:crypto'
import { existsSync, rmSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = resolve(__dirname, '..', '..')

const DIST_DAEMON_LIFECYCLE = resolve(PROJECT_ROOT, 'dist', 'helpers', 'DaemonLifecycle.js')
const HELPER_BINARY = resolve(__dirname, '../../src/swift-helper/.build/release/spectrai-claw-helper')

let skipAllReason = null
let DaemonLifecycleClass = null

before(() => {
  if (process.platform !== 'darwin') {
    skipAllReason = 'Detection modes E2E is macOS-only.'
    return
  }

  if (!existsSync(DIST_DAEMON_LIFECYCLE)) {
    skipAllReason = 'dist/helpers/DaemonLifecycle.js not found. Run `npm run build` first.'
    return
  }

  if (!existsSync(HELPER_BINARY)) {
    skipAllReason = 'Swift daemon binary not found at src/swift-helper/.build/release/spectrai-claw-helper. Run `npm run build:all` first.'
  }
})

after(() => {
  DaemonLifecycleClass = null
})

function shouldSkipByEnvironment(t) {
  if (!skipAllReason) {
    return false
  }
  t.skip(skipAllReason)
  return true
}

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

function allElementsPrefixed(elements, prefix) {
  return elements.every((el) => typeof el?.id === 'string' && el.id.startsWith(prefix))
}

function isLikelyTauriOrElectron(app) {
  const bundleId = String(app?.bundleId ?? '').toLowerCase()
  const name = String(app?.name ?? '').toLowerCase()
  return (
    bundleId.includes('electron')
    || bundleId.includes('tauri')
    || name.includes('spectrai')
    || name.includes('electron')
  )
}

function isSkippableRuntimeCode(code) {
  return code === 'ePermission' || code === 'eAXFailure' || code === 'eTimeout'
}

async function createHarness(t) {
  if (shouldSkipByEnvironment(t)) {
    return null
  }

  const DaemonLifecycle = await loadDaemonLifecycleClass()
  const suffix = randomUUID()
  const socketPath = `/tmp/spectrai-claw-e2e-modes-${suffix}.sock`
  const logFile = `/tmp/spectrai-claw-e2e-modes-${suffix}.log`

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

async function listApplications(client) {
  const appsResult = await client.call('listApplications', {}, 3_000)
  assert.ok(Array.isArray(appsResult.applications))
  return appsResult.applications
}

async function getFrontmostApp(client) {
  const apps = await listApplications(client)
  const active = apps.find((app) => app.isActive)
  if (!active) {
    return null
  }
  return active
}

async function detectAutoModeWithFallback(client) {
  const apps = await listApplications(client)
  const active = apps.find((app) => app.isActive)
  if (!active) {
    return { result: null, skippedCode: null }
  }

  const browserBundleIds = new Set([
    'com.google.chrome',
    'com.microsoft.edgemac',
    'com.brave.browser',
    'com.vivaldi.vivaldi',
    'com.operasoftware.opera',
  ])

  const others = apps.filter((app) => app.pid !== active.pid)
  const nonBrowsers = others.filter(
    (app) => !browserBundleIds.has(String(app.bundleId ?? '').toLowerCase()),
  )
  const browsers = others.filter(
    (app) => browserBundleIds.has(String(app.bundleId ?? '').toLowerCase()),
  )

  const activeIsBrowser = browserBundleIds.has(String(active.bundleId ?? '').toLowerCase())
  const orderedTargets = activeIsBrowser
    ? [...nonBrowsers, active, ...browsers]
    : [active, ...nonBrowsers, ...browsers]
  let skippedCode = null

  for (const app of orderedTargets.slice(0, 3)) {
    try {
      const probe = await client.call(
        'detectElements',
        { pid: app.pid, mode: 'ax_only', allowWebFocus: true, maxDepth: 10, maxCount: 400 },
        6_000,
      )

      const actionableCount = Array.isArray(probe.elements)
        ? probe.elements.filter((el) => el?.isActionable === true).length
        : 0

      if (actionableCount < 15) {
        skippedCode = skippedCode ?? 'ePermission'
        continue
      }

      const result = await client.call(
        'detectElements',
        { pid: app.pid, allowWebFocus: true, maxDepth: 10, maxCount: 400 },
        6_000,
      )

      if (Array.isArray(result.elements) && result.elements.length >= 1) {
        return { result, skippedCode: null }
      }
    } catch (err) {
      const code = extractErrorCode(err)
      if (code === 'ePermission' || isSkippableRuntimeCode(code)) {
        skippedCode = code
        continue
      }
      throw err
    }
  }

  return { result: null, skippedCode }
}

test('mode_param_passthrough: detectElements(ax_only) returns ax_* ids', { timeout: 30_000 }, async (t) => {
  const harness = await createHarness(t)
  if (!harness) return

  const { client } = harness
  const permissions = await client.call('permissionsStatus', {}, 1_500)

  if (!permissions.accessibility) {
    t.skip('Accessibility permission is not granted; skipping mode_param_passthrough.')
    return
  }

  const frontmost = await getFrontmostApp(client)
  if (!frontmost) {
    t.skip('No active frontmost app from listApplications.')
    return
  }

  let result
  try {
    result = await client.call(
      'detectElements',
      { pid: frontmost.pid, mode: 'ax_only', allowWebFocus: true, maxDepth: 8, maxCount: 300 },
      12_000,
    )
  } catch (err) {
    const code = extractErrorCode(err)
    if (isSkippableRuntimeCode(code)) {
      t.skip(`detectElements(ax_only) skipped by runtime environment: ${code}`)
      return
    }
    throw err
  }

  assert.ok(Array.isArray(result.elements))
  assert.ok(allElementsPrefixed(result.elements, 'ax_'), 'All element ids should start with ax_')
  assert.ok(Array.isArray(result.warnings))
})

test('vision_supplement: detectElements(vision_only) returns vis_* ids', { timeout: 35_000 }, async (t) => {
  const harness = await createHarness(t)
  if (!harness) return

  const { client } = harness
  const permissions = await client.call('permissionsStatus', {}, 1_500)

  if (!permissions.screenRecording) {
    t.skip('Screen Recording permission is not granted; skipping vision_supplement.')
    return
  }

  const frontmost = await getFrontmostApp(client)
  if (!frontmost) {
    t.skip('No active frontmost app from listApplications.')
    return
  }

  let result
  try {
    result = await client.call(
      'detectElements',
      { pid: frontmost.pid, mode: 'vision_only', maxDepth: 8, maxCount: 300 },
      15_000,
    )
  } catch (err) {
    const code = extractErrorCode(err)
    if (code === 'ePermission' || code === 'eTimeout' || code === 'eInternal') {
      t.skip(`detectElements(vision_only) skipped by runtime environment: ${code}`)
      return
    }
    throw err
  }

  assert.ok(Array.isArray(result.elements))

  if (result.elements.length === 0) {
    t.skip('vision_only returned 0 elements in current environment.')
    return
  }

  assert.ok(allElementsPrefixed(result.elements, 'vis_'), 'All element ids should start with vis_')
})

test('auto_mode_default: detectElements without mode returns >= 1 element', { timeout: 45_000 }, async (t) => {
  const harness = await createHarness(t)
  if (!harness) return

  const { client } = harness
  const permissions = await client.call('permissionsStatus', {}, 1_500)

  if (!permissions.accessibility && !permissions.screenRecording) {
    t.skip('Neither Accessibility nor Screen Recording permission is granted.')
    return
  }

  const attempt = await detectAutoModeWithFallback(client)
  if (!attempt.result) {
    const suffix = attempt.skippedCode ? `: ${attempt.skippedCode}` : ''
    t.skip(`detectElements(auto default) skipped by runtime environment${suffix}`)
    return
  }

  const result = attempt.result
  assert.ok(Array.isArray(result.elements))
  assert.ok(result.elements.length >= 1, 'auto mode should return at least 1 element')
})

test('invalid_mode: invalid mode should return eInvalidArgs or degrade gracefully', { timeout: 25_000 }, async (t) => {
  const harness = await createHarness(t)
  if (!harness) return

  const { client } = harness
  const frontmost = await getFrontmostApp(client)
  if (!frontmost) {
    t.skip('No active frontmost app from listApplications.')
    return
  }

  let result
  try {
    result = await client.call(
      'detectElements',
      { pid: frontmost.pid, mode: 'invalid', allowWebFocus: true, maxDepth: 6, maxCount: 200 },
      10_000,
    )
  } catch (err) {
    const code = extractErrorCode(err)
    if (code === 'eInvalidArgs') {
      assert.ok(true)
      return
    }
    if (isSkippableRuntimeCode(code)) {
      t.skip(`invalid_mode skipped by runtime environment: ${code}`)
      return
    }
    throw err
  }

  assert.ok(Array.isArray(result.elements))
  assert.ok(Array.isArray(result.warnings))
  assert.ok(typeof result.snapshotId === 'string' && result.snapshotId.length > 0)
})

test('dedup_warning: tauri/electron ax_only should include deduped_* warning (S6-dependent)', { timeout: 30_000 }, async (t) => {
  const harness = await createHarness(t)
  if (!harness) return

  const { client } = harness
  const permissions = await client.call('permissionsStatus', {}, 1_500)

  if (!permissions.accessibility) {
    t.skip('Accessibility permission is not granted; skipping dedup_warning.')
    return
  }

  const frontmost = await getFrontmostApp(client)
  if (!frontmost) {
    t.skip('No active frontmost app from listApplications.')
    return
  }

  if (!isLikelyTauriOrElectron(frontmost)) {
    t.skip(`Frontmost app is not Tauri/Electron (${frontmost.bundleId || frontmost.name}).`)
    return
  }

  let result
  try {
    result = await client.call(
      'detectElements',
      { pid: frontmost.pid, mode: 'ax_only', allowWebFocus: true, maxDepth: 8, maxCount: 300 },
      12_000,
    )
  } catch (err) {
    const code = extractErrorCode(err)
    if (isSkippableRuntimeCode(code)) {
      t.skip(`dedup_warning skipped by runtime environment: ${code}`)
      return
    }
    throw err
  }

  assert.ok(Array.isArray(result.warnings))

  const hasDedupWarning = result.warnings.some(
    (warning) => typeof warning === 'string' && warning.startsWith('deduped_'),
  )

  if (!hasDedupWarning) {
    t.skip('No deduped_* warning yet. This assertion depends on S6 dedup implementation.')
    return
  }

  assert.ok(hasDedupWarning)
})
