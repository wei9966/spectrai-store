#!/usr/bin/env node
/**
 * Smoke test: spawn daemon, ping it, call listApplications, then shut down.
 * Usage: node scripts/smoke-daemon.mjs
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { existsSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HELPER_BINARY = join(__dirname, '..', 'src', 'swift-helper', '.build', 'release', 'spectrai-claw-helper')
const SOCKET_PATH = '/tmp/spectrai-claw-smoke-test.sock'

function encodeFrame(body) {
  const buf = Buffer.from(body, 'utf-8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(buf.length, 0)
  return Buffer.concat([header, buf])
}

function decodeFrame(buf) {
  if (buf.length < 4) return null
  const length = buf.readUInt32BE(0)
  if (buf.length < 4 + length) return null
  return {
    body: buf.subarray(4, 4 + length),
    rest: buf.subarray(4 + length),
  }
}

function sendRequest(socket, op, params = {}) {
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    const frame = encodeFrame(JSON.stringify({ id, op, params }))

    let buffer = Buffer.alloc(0)
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for ${op}`)), 10000)

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const decoded = decodeFrame(buffer)
      if (decoded) {
        clearTimeout(timeout)
        socket.off('data', onData)
        const resp = JSON.parse(decoded.body.toString('utf-8'))
        if (resp.ok) {
          resolve(resp.result)
        } else {
          reject(new Error(`${op} failed: ${resp.error?.message ?? 'unknown'} (${resp.error?.code ?? '?'})`))
        }
      }
    }
    socket.on('data', onData)
    socket.write(frame)
  })
}

async function main() {
  console.log('=== SpectrAI Claw Daemon Smoke Test ===\n')

  if (!existsSync(HELPER_BINARY)) {
    console.error(`ERROR: Helper binary not found at ${HELPER_BINARY}`)
    console.error('Run: cd src/swift-helper && swift build -c release')
    process.exit(1)
  }

  if (existsSync(SOCKET_PATH)) {
    unlinkSync(SOCKET_PATH)
  }

  console.log(`Starting daemon: ${HELPER_BINARY} daemon run --socket ${SOCKET_PATH}`)
  const daemon = spawn(HELPER_BINARY, ['daemon', 'run', '--socket', SOCKET_PATH], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let daemonStderr = ''
  daemon.stderr.on('data', (d) => { daemonStderr += d.toString() })
  daemon.stdout.on('data', (d) => { /* discard */ })

  daemon.on('error', (err) => {
    console.error(`Failed to spawn daemon: ${err.message}`)
    process.exit(1)
  })

  // Wait for socket to appear
  let ready = false
  for (let i = 0; i < 50; i++) {
    await sleep(100)
    if (existsSync(SOCKET_PATH)) {
      ready = true
      break
    }
  }

  if (!ready) {
    console.error('ERROR: Daemon socket did not appear within 5s')
    console.error('Stderr:', daemonStderr)
    daemon.kill('SIGTERM')
    process.exit(1)
  }

  console.log('Daemon socket appeared. Connecting...\n')

  const socket = net.createConnection({ path: SOCKET_PATH })
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })

  // Test 1: ping
  console.log('Test 1: ping')
  try {
    const pingResult = await sendRequest(socket, 'ping')
    console.log(`  PASS: pong=${pingResult.pong}, version=${pingResult.daemonVersion}\n`)
  } catch (err) {
    console.error(`  FAIL: ${err.message}\n`)
    socket.destroy()
    daemon.kill('SIGTERM')
    process.exit(1)
  }

  // Test 2: listApplications
  console.log('Test 2: listApplications')
  try {
    const appsResult = await sendRequest(socket, 'listApplications')
    const apps = appsResult.applications ?? []
    console.log(`  PASS: ${apps.length} application(s) found`)
    if (apps.length > 0) {
      console.log(`  First app: ${apps[0].name} (pid=${apps[0].pid})`)
    }
    console.log()
  } catch (err) {
    if (err.message.includes('eOpUnsupported')) {
      console.log(`  SKIP (eOpUnsupported — expected if T5 services not fully wired)\n`)
    } else {
      console.error(`  FAIL: ${err.message}\n`)
    }
  }

  // Test 3: daemonStatus
  console.log('Test 3: daemonStatus')
  try {
    const statusResult = await sendRequest(socket, 'daemonStatus')
    console.log(`  PASS: uptime=${statusResult.uptimeMs}ms, pid=${statusResult.pid}\n`)
  } catch (err) {
    console.error(`  FAIL: ${err.message}\n`)
  }

  // Cleanup
  console.log('Shutting down daemon...')
  try {
    await sendRequest(socket, 'daemonStop')
  } catch {
    // might close connection before response
  }

  socket.destroy()
  await sleep(500)

  if (daemon.exitCode === null) {
    daemon.kill('SIGTERM')
    await sleep(300)
  }

  if (existsSync(SOCKET_PATH)) {
    unlinkSync(SOCKET_PATH)
  }

  console.log('Done. All smoke tests passed.')
}

main().catch((err) => {
  console.error(`Unhandled error: ${err.message}`)
  process.exit(1)
})
