import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
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

async function waitFor(predicate, timeoutMs, intervalMs = 80) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (predicate()) {
      return true
    }
    await sleep(intervalMs)
  }
  return false
}

function shouldSkipByEnvironment(t) {
  if (process.platform !== 'darwin') {
    t.skip('E2E daemon tests are macOS-only.')
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
  const suffix = randomUUID()
  const socketPath = `/tmp/spectrai-claw-e2e-${suffix}.sock`
  const logFile = `/tmp/spectrai-claw-e2e-${suffix}.log`

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
  return { lifecycle, client, socketPath }
}

function encodeFrameFromObject(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

function decodeFrame(buffer) {
  if (buffer.length < 4) {
    return null
  }

  const length = buffer.readUInt32BE(0)
  if (buffer.length < 4 + length) {
    return null
  }

  return {
    body: buffer.subarray(4, 4 + length),
    rest: buffer.subarray(4 + length),
  }
}

async function connectUnixSocket(socketPath, timeoutMs = 5_000) {
  const socket = net.createConnection({ path: socketPath })

  await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      cleanup()
      socket.destroy()
      rejectPromise(new Error(`Timed out connecting to socket: ${socketPath}`))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timeout)
      socket.off('connect', onConnect)
      socket.off('error', onError)
    }

    const onConnect = () => {
      cleanup()
      resolvePromise()
    }

    const onError = (err) => {
      cleanup()
      rejectPromise(err)
    }

    socket.once('connect', onConnect)
    socket.once('error', onError)
  })

  return socket
}

async function collectResponses(socket, expectedCount, timeoutMs = 5_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const responses = []
    let readBuffer = Buffer.alloc(0)

    const timeout = setTimeout(() => {
      cleanup()
      rejectPromise(new Error(`Timed out waiting for ${expectedCount} response(s)`))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timeout)
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }

    const onData = (chunk) => {
      readBuffer = Buffer.concat([readBuffer, chunk])

      while (true) {
        const decoded = decodeFrame(readBuffer)
        if (!decoded) {
          break
        }

        readBuffer = Buffer.from(decoded.rest)
        responses.push(JSON.parse(decoded.body.toString('utf-8')))

        if (responses.length >= expectedCount) {
          cleanup()
          resolvePromise(responses)
          return
        }
      }
    }

    const onError = (err) => {
      cleanup()
      rejectPromise(err)
    }

    const onClose = () => {
      if (responses.length >= expectedCount) {
        cleanup()
        resolvePromise(responses)
        return
      }
      cleanup()
      rejectPromise(new Error('Socket closed before enough responses arrived'))
    }

    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

test('daemon lifecycle: ensure() + daemonStatus + stop() cleanup', { timeout: 25_000 }, async (t) => {
  const harness = await createHarness(t)
  if (!harness) return

  const { lifecycle, client, socketPath } = harness

  const ping = await client.call('ping', {}, 1_200)
  assert.equal(ping.pong, true)

  const status = await client.call('daemonStatus', {}, 1_500)
  assert.ok(Number.isInteger(status.pid))
  assert.ok(status.uptimeMs >= 0)
  assert.equal(typeof status.protocolVersion, 'string')

  await lifecycle.stop()

  await assert.rejects(
    client.call('ping', {}, 800),
    /Failed to connect daemon socket|Connection closed|Connection lost|Connection is not available|timed out/i,
  )

  const socketRemoved = await waitFor(() => !existsSync(socketPath), 2_000)
  assert.equal(socketRemoved, true)
})

test('listApplications: returns non-empty normalized application list', { timeout: 20_000 }, async (t) => {
  const harness = await createHarness(t)
  if (!harness) return

  const { client } = harness
  const res = await client.call('listApplications', {}, 3_000)

  assert.ok(Array.isArray(res.applications))
  assert.ok(res.applications.length >= 1)

  const normalized = res.applications.map((app) => ({
    pid: app.pid,
    bundle_id: app.bundleId,
    name: app.name,
    is_active: app.isActive,
  }))

  for (const app of normalized) {
    assert.equal(typeof app.pid, 'number')
    assert.equal(typeof app.bundle_id, 'string')
    assert.equal(typeof app.name, 'string')
    assert.equal(typeof app.is_active, 'boolean')
  }
})

test('ping roundtrip: 5 concurrent ping requests have matching ids', { timeout: 20_000 }, async (t) => {
  const harness = await createHarness(t)
  if (!harness) return

  const { socketPath } = harness
  const socket = await connectUnixSocket(socketPath)
  t.after(() => socket.destroy())

  const requestIds = Array.from({ length: 5 }, () => `e2e-ping-${randomUUID()}`)

  for (const id of requestIds) {
    socket.write(
      encodeFrameFromObject({
        id,
        op: 'ping',
        params: {},
      }),
    )
  }

  const responses = await collectResponses(socket, requestIds.length, 5_000)
  assert.equal(responses.length, requestIds.length)

  const responseIdSet = new Set(responses.map((resp) => resp.id))
  assert.deepEqual(responseIdSet, new Set(requestIds))

  for (const response of responses) {
    assert.equal(response.ok, true)
    assert.equal(response.result?.pong, true)
  }
})

test('captureScreen: returns png path + positive width/height', { timeout: 25_000 }, async (t) => {
  const harness = await createHarness(t)
  if (!harness) return

  const { client } = harness
  const permissions = await client.call('permissionsStatus', {}, 1_500)

  if (!permissions.screenRecording) {
    t.skip('Screen Recording permission is not granted; skipping captureScreen E2E.')
    return
  }

  let result
  try {
    result = await client.call('captureScreen', {}, 10_000)
  } catch (err) {
    const code = extractErrorCode(err)
    if (code === 'ePermission' || code === 'eTimeout') {
      t.skip(`captureScreen skipped due to runtime environment (${code}).`)
      return
    }
    throw err
  }

  assert.equal(typeof result.path, 'string')
  assert.ok(result.path.toLowerCase().endsWith('.png'))
  assert.ok(existsSync(result.path))
  assert.ok(result.width > 0)
  assert.ok(result.height > 0)
})

test('error path: listWindows with missing pid returns empty list or friendly error', { timeout: 20_000 }, async (t) => {
  const harness = await createHarness(t)
  if (!harness) return

  const { client } = harness
  const missingPid = 2_147_483_647

  try {
    const result = await client.call('listWindows', { pid: missingPid }, 3_000)
    assert.ok(Array.isArray(result.windows))
    assert.equal(result.windows.length, 0)
  } catch (err) {
    const code = extractErrorCode(err)
    assert.ok(code === 'eNotFound' || code === 'eInvalidArgs' || code === 'eInternal')
    assert.ok(err instanceof Error)
    assert.ok(err.message.length > 0)
  }
})
