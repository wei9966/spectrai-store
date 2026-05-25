import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

import { BrowserDomCdpProvider } from '../provider.js'

interface FakeCdpServer {
  url: string
  close: () => Promise<void>
}

test('BrowserDomCdpProvider smoke: find selector and setValue verifies DOM value', async () => {
  const fake = await startFakeCdpServer()
  try {
    const provider = new BrowserDomCdpProvider({ browserURL: fake.url, defaultTimeoutMs: 1_500 })

    const targets = await provider.listTargets()
    assert.equal(targets.length, 1)
    assert.equal(targets[0]?.title, 'Fixture Form')

    const element = await provider.findElement({ css: '#q', urlIncludes: 'fixture.local' })
    assert.ok(element)
    assert.equal(element?.provider, 'browser')
    assert.equal(element?.metadata.source, 'dom')
    assert.equal(element?.metadata.targetId, 'page_1')

    const result = await provider.setValue({ css: '#q' }, 'spectrai browser provider')
    assert.equal(result.ok, true)
    assert.equal(result.method, 'dom')
    assert.equal(result.verification?.status, 'passed')
    assert.deepEqual(result.verification?.checks.map((check) => check.name), ['value'])
  } finally {
    await fake.close()
  }
})

test('BrowserDomCdpProvider smoke: capability report marks debug endpoint available', async () => {
  const fake = await startFakeCdpServer()
  try {
    const provider = new BrowserDomCdpProvider({ browserURL: fake.url, defaultTimeoutMs: 1_500 })
    const report = await provider.getCapabilityReport()

    assert.equal(report.provider, 'browser-dom-cdp')
    assert.equal(report.status, 'available')
    assert.equal(report.backgroundRead, true)
    assert.equal(report.backgroundInvoke, true)
    assert.equal(report.backgroundType, true)
    assert.equal(report.requiresForeground, false)
    assert.equal(report.visionFallbackNeeded, false)
    assert.ok(report.selectorSupport.includes('css'))
    assert.equal(report.actions.upload, 'fallback')
  } finally {
    await fake.close()
  }
})

async function startFakeCdpServer(): Promise<FakeCdpServer> {
  const sockets = new Set<Socket>()
  const server = http.createServer((request, response) => {
    const address = server.address() as AddressInfo
    if (request.url === '/json/version') {
      writeJson(response, { Browser: 'FakeChrome/1.0', webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/browser/fake` })
      return
    }
    if (request.url === '/json') {
      writeJson(response, [
        {
          id: 'page_1',
          type: 'page',
          url: 'https://fixture.local/form',
          title: 'Fixture Form',
          webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/page/page_1`,
        },
      ])
      return
    }
    response.writeHead(404)
    response.end('not found')
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  server.on('upgrade', (request, socket) => {
    const key = String(request.headers['sec-websocket-key'] ?? '')
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'))

    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (true) {
        const frame = decodeClientFrame(buffer)
        if (!frame) break
        buffer = frame.rest
        const command = JSON.parse(frame.payload.toString('utf8')) as { id: number; method: string; params?: { expression?: string } }
        socket.write(encodeServerFrame(JSON.stringify({ id: command.id, result: fakeRuntimeEvaluate(command.params?.expression ?? '') })))
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}

function fakeRuntimeEvaluate(expression: string): Record<string, unknown> {
  if (expression.includes('const __spectraiTask = "find"')) {
    return {
      result: {
        type: 'object',
        value: {
          element: fakeElement('initial'),
          warnings: [],
        },
      },
    }
  }

  if (expression.includes('const __spectraiTask = "action"')) {
    return {
      result: {
        type: 'object',
        value: {
          ok: true,
          method: 'dom',
          before: fakeState('initial'),
          after: fakeState('spectrai browser provider'),
          element: fakeElement('spectrai browser provider'),
          warnings: [],
        },
      },
    }
  }

  if (expression.includes('const __spectraiTask = "state"')) {
    return {
      result: {
        type: 'object',
        value: fakeState('spectrai browser provider'),
      },
    }
  }

  if (expression.includes('const __spectraiTask = "snapshot"')) {
    return {
      result: {
        type: 'object',
        value: {
          url: 'https://fixture.local/form',
          title: 'Fixture Form',
          timestamp: '2026-05-25T00:00:00.000Z',
          elements: [fakeElement('initial')],
          frames: [],
          warnings: [],
        },
      },
    }
  }

  return { result: { type: 'object', value: {} } }
}

function fakeElement(value: string) {
  return {
    id: 'browser_fixture_q',
    provider: 'browser',
    role: 'textbox',
    label: 'Search',
    text: '',
    value,
    tagName: 'input',
    attributes: { id: 'q', name: 'q', type: 'text', 'data-spectrai-cuid': 'browser_fixture_q' },
    bounds: { x: 10, y: 20, width: 240, height: 32 },
    actionable: true,
    enabled: true,
    visible: true,
    focused: false,
    metadata: {
      targetId: '',
      framePath: [],
      cssPath: 'input#q',
      xpath: '//*[@id="q"]',
      selector: { elementId: 'browser_fixture_q' },
      spectraiId: 'browser_fixture_q',
      tagName: 'input',
      inputType: 'text',
      editable: true,
      clickable: false,
      source: 'dom',
    },
  }
}

function fakeState(value: string) {
  return {
    url: 'https://fixture.local/form',
    title: 'Fixture Form',
    text: '',
    value,
    focused: true,
    enabled: true,
    visible: true,
    mutationHash: value,
  }
}

function writeJson(response: http.ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function encodeServerFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
  }
  const header = Buffer.alloc(4)
  header[0] = 0x81
  header[1] = 126
  header.writeUInt16BE(payload.length, 2)
  return Buffer.concat([header, payload])
}

function decodeClientFrame(buffer: Buffer): { payload: Buffer; rest: Buffer } | null {
  if (buffer.length < 2) return null
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < offset + 2) return null
    length = buffer.readUInt16BE(offset)
    offset += 2
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null
    length = Number(buffer.readBigUInt64BE(offset))
    offset += 8
  }
  if (buffer.length < offset + 4 + length) return null
  const mask = buffer.subarray(offset, offset + 4)
  offset += 4
  const payload = Buffer.from(buffer.subarray(offset, offset + length))
  for (let i = 0; i < payload.length; i += 1) {
    payload[i] = payload[i] ^ mask[i % 4]
  }
  return { payload, rest: Buffer.from(buffer.subarray(offset + length)) }
}
