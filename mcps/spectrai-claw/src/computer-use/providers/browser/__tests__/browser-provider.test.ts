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

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const JPEG_1X1 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJoA/9k='

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
    assert.equal(report.actions.navigate, 'native')
    assert.equal(report.actions.screenshot, 'native')
  } finally {
    await fake.close()
  }
})

test('BrowserDomCdpProvider click: navigated link succeeds when old node is unreadable but URL changed', async () => {
  const fake = await startFakeCdpServer({ mode: 'link-navigation' })
  try {
    const provider = new BrowserDomCdpProvider({ browserURL: fake.url, defaultTimeoutMs: 1_500 })
    const result = await provider.executeAction({
      type: 'click',
      selector: { css: 'a.result-link', role: 'link' },
      element: fakeLinkElement(),
      timeoutMs: 50,
    })

    assert.equal(result.ok, true)
    assert.equal(result.verification?.status, 'passed')
    assert.equal(result.verification?.checks.some((check) => check.name === 'urlChanged' && check.ok), true)
    assert.equal(result.after?.url, 'https://fixture.local/guide')
    assert.equal(result.failure, undefined)
    assert.equal(result.fallback, undefined)
  } finally {
    await fake.close()
  }
})

test('BrowserDomCdpProvider click: same-page control still verifies via mutation', async () => {
  const fake = await startFakeCdpServer({ mode: 'same-page-toggle' })
  try {
    const provider = new BrowserDomCdpProvider({ browserURL: fake.url, defaultTimeoutMs: 1_500 })
    const result = await provider.executeAction({
      type: 'click',
      selector: { css: '#toggle' },
      timeoutMs: 50,
    })

    assert.equal(result.ok, true)
    assert.equal(result.verification?.status, 'passed')
    assert.deepEqual(result.verification?.checks.map((check) => check.name), ['mutation'])
    assert.equal(result.before?.url, result.after?.url)
  } finally {
    await fake.close()
  }
})

test('BrowserDomCdpProvider navigate: Page.navigate updates the page URL', async () => {
  const fake = await startFakeCdpServer()
  try {
    const provider = new BrowserDomCdpProvider({ browserURL: fake.url, defaultTimeoutMs: 1_500 })
    const result = await provider.executeAction({
      type: 'navigate',
      url: 'https://fixture.local/guide',
      timeoutMs: 1_500,
    })

    assert.equal(result.ok, true)
    assert.equal(result.action, 'navigate')
    assert.equal(result.method, 'cdp-dom')
    assert.equal(result.after?.url, 'https://fixture.local/guide')
    assert.equal(result.verification?.status, 'passed')
    assert.equal(result.verification?.checks.some((check) => check.name === 'urlIncludes' && check.ok), true)
  } finally {
    await fake.close()
  }
})

test('BrowserDomCdpProvider navigate: goto alias uses value as url', async () => {
  const fake = await startFakeCdpServer()
  try {
    const provider = new BrowserDomCdpProvider({ browserURL: fake.url, defaultTimeoutMs: 1_500 })
    const result = await provider.executeAction({
      type: 'goto',
      value: 'https://fixture.local/guide',
      timeoutMs: 1_500,
    } as never)

    assert.equal(result.ok, true)
    assert.equal(result.action, 'navigate')
    assert.equal(result.after?.url, 'https://fixture.local/guide')
  } finally {
    await fake.close()
  }
})

test('BrowserDomCdpProvider navigate: empty page targets fall back to /json/new', async () => {
  const fake = await startFakeCdpServer({ emptyTargets: true })
  try {
    const provider = new BrowserDomCdpProvider({ browserURL: fake.url, defaultTimeoutMs: 1_500 })
    const result = await provider.executeAction({
      type: 'navigate',
      url: 'https://fixture.local/guide',
      timeoutMs: 1_500,
    })

    assert.equal(result.ok, true)
    assert.equal(result.action, 'navigate')
    assert.equal(result.after?.url, 'https://fixture.local/guide')
    const targets = await provider.listTargets()
    assert.equal(targets.length, 1)
    assert.equal(targets[0]?.url, 'https://fixture.local/guide')
  } finally {
    await fake.close()
  }
})

test('BrowserDomCdpProvider capability report marks navigate as native', async () => {
  const fake = await startFakeCdpServer()
  try {
    const provider = new BrowserDomCdpProvider({ browserURL: fake.url, defaultTimeoutMs: 1_500 })
    const report = await provider.getCapabilityReport()
    assert.equal(report.actions.navigate, 'native')
  } finally {
    await fake.close()
  }
})

test('BrowserDomCdpProvider captureScreenshot: Page.captureScreenshot returns background page image', async () => {
  const fake = await startFakeCdpServer()
  try {
    const provider = new BrowserDomCdpProvider({ browserURL: fake.url, defaultTimeoutMs: 1_500 })
    const result = await provider.captureScreenshot()

    assert.equal(result.ok, true)
    assert.equal(result.provider, 'browser')
    assert.equal(result.method, 'cdp-page')
    assert.equal(result.mimeType, 'image/png')
    assert.equal(result.requiresForeground, false)
    assert.equal(result.url, 'https://fixture.local/form')
    assert.equal(result.title, 'Fixture Form')
    assert.equal(result.targetId, 'page_1')
    assert.equal(result.data, PNG_1X1)
    assert.equal(result.byteLength, Buffer.from(PNG_1X1, 'base64').byteLength)

    const jpeg = await provider.captureScreenshot({ format: 'jpeg', quality: 80, fullPage: true })
    assert.equal(jpeg.method, 'cdp-page')
    assert.equal(jpeg.mimeType, 'image/jpeg')
    assert.equal(jpeg.data, JPEG_1X1)
    assert.equal(jpeg.requiresForeground, false)
  } finally {
    await fake.close()
  }
})

interface FakeCdpServerOptions {
  mode?: 'form' | 'link-navigation' | 'same-page-toggle'
  emptyTargets?: boolean
}

async function startFakeCdpServer(options: FakeCdpServerOptions = {}): Promise<FakeCdpServer> {
  const mode = options.mode ?? 'form'
  const page = {
    id: 'page_1',
    url: 'https://fixture.local/form',
    title: 'Fixture Form',
    value: 'initial',
    mutationHash: 'initial',
    navigated: false,
  }
  const extraPages: Array<{ id: string; url: string; title: string }> = []
  let emptyTargets = options.emptyTargets === true
  const sockets = new Set<Socket>()
  const server = http.createServer((request, response) => {
    const address = server.address() as AddressInfo
    const rawUrl = request.url ?? '/'
    if (rawUrl === '/json/version') {
      writeJson(response, { Browser: 'FakeChrome/1.0', webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/browser/fake` })
      return
    }
    if (rawUrl.startsWith('/json/new')) {
      const targetUrl = decodeURIComponent(rawUrl.slice('/json/new'.length).replace(/^\?/, ''))
      const created = {
        id: `page_new_${extraPages.length + 1}`,
        url: targetUrl,
        title: targetUrl.includes('/guide') ? 'Guide' : 'New Tab',
      }
      extraPages.push(created)
      page.url = created.url
      page.title = created.title
      page.mutationHash = created.url
      writeJson(response, {
        id: created.id,
        type: 'page',
        url: created.url,
        title: created.title,
        webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/page/${created.id}`,
      })
      return
    }
    if (rawUrl === '/json' || rawUrl === '/json/list') {
      const pages = [
        ...(emptyTargets
          ? []
          : [
              {
                id: page.id,
                type: 'page',
                url: page.url,
                title: page.title,
                webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/page/${page.id}`,
              },
            ]),
        ...extraPages.map((item) => ({
          id: item.id,
          type: 'page',
          url: item.url,
          title: item.title,
          webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/page/${item.id}`,
        })),
      ]
      writeJson(response, pages)
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
        const command = JSON.parse(frame.payload.toString('utf8')) as {
          id: number
          method: string
          params?: { expression?: string; url?: string; format?: string; quality?: number; captureBeyondViewport?: boolean }
        }
        socket.write(encodeServerFrame(JSON.stringify(fakeCdpResult(command, mode, page))))
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

function fakeCdpResult(
  command: { id: number; method: string; params?: { expression?: string; url?: string; format?: string; quality?: number; captureBeyondViewport?: boolean } },
  mode: NonNullable<FakeCdpServerOptions['mode']>,
  page: { url: string; title: string; value: string; mutationHash: string; navigated: boolean },
): Record<string, unknown> {
  if (command.method === 'Page.enable') {
    return { id: command.id, result: {} }
  }
  if (command.method === 'Page.navigate') {
    const url = command.params?.url ?? page.url
    page.url = url
    page.title = url.includes('/guide') ? 'Guide' : page.title
    page.mutationHash = url
    page.navigated = true
    return { id: command.id, result: { frameId: 'f1' } }
  }
  if (command.method === 'Page.captureScreenshot') {
    const format = command.params?.format === 'jpeg' ? 'jpeg' : 'png'
    return { id: command.id, result: { data: format === 'jpeg' ? JPEG_1X1 : PNG_1X1 } }
  }
  if (command.method === 'Runtime.evaluate') {
    const expression = command.params?.expression ?? ''
    if (expression === 'document.readyState') {
      return { id: command.id, result: { result: { type: 'string', value: 'complete' } } }
    }
    return { id: command.id, result: fakeRuntimeEvaluate(expression, mode, page) }
  }
  return { id: command.id, result: {} }
}

function fakeRuntimeEvaluate(
  expression: string,
  mode: NonNullable<FakeCdpServerOptions['mode']>,
  page: { url: string; title: string; value: string; mutationHash: string; navigated: boolean },
): Record<string, unknown> {
  if (expression === '({url: location.href, title: document.title})') {
    return { result: { type: 'object', value: { url: page.url, title: page.title } } }
  }

  if (expression.includes('const __spectraiTask = "find"')) {
    return {
      result: {
        type: 'object',
        value: {
          element: mode === 'link-navigation' ? fakeLinkElement() : fakeElement(page.value),
          warnings: [],
        },
      },
    }
  }

  if (expression.includes('const __spectraiTask = "action"')) {
    if (mode === 'link-navigation') {
      // Simulate async navigation: action returns stale page / missing old node after click.
      const before = fakeState('link', {
        url: 'https://fixture.local/search',
        title: 'Search Results',
        mutationHash: 'search-results',
      })
      page.url = 'https://fixture.local/guide'
      page.title = 'Guide'
      page.mutationHash = 'guide'
      page.navigated = true
      return {
        result: {
          type: 'object',
          value: {
            ok: true,
            method: 'dom',
            before,
            // Old <a> already gone; stale after lacks usable element mutation evidence.
            after: undefined,
            element: null,
            warnings: [],
          },
        },
      }
    }

    if (mode === 'same-page-toggle') {
      const before = fakeState('off', { mutationHash: 'off' })
      page.mutationHash = 'on'
      page.value = 'on'
      return {
        result: {
          type: 'object',
          value: {
            ok: true,
            method: 'dom',
            before,
            after: fakeState('on', { mutationHash: 'on' }),
            element: fakeElement('on'),
            warnings: [],
          },
        },
      }
    }

    page.value = 'spectrai browser provider'
    page.mutationHash = 'spectrai browser provider'
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
    if (mode === 'link-navigation' && page.navigated && expression.includes('"selector"')) {
      // Old selector unreadable after navigation — page-level re-read still works.
      return {
        result: {
          type: 'object',
          value: null,
        },
      }
    }
    return {
      result: {
        type: 'object',
        value: fakeState(page.value, {
          url: page.url,
          title: page.title,
          mutationHash: page.mutationHash,
          focused: mode !== 'link-navigation',
        }),
      },
    }
  }

  if (expression.includes('const __spectraiTask = "snapshot"')) {
    return {
      result: {
        type: 'object',
        value: {
          url: page.url,
          title: page.title,
          timestamp: '2026-05-25T00:00:00.000Z',
          elements: [mode === 'link-navigation' ? fakeLinkElement() : fakeElement(page.value)],
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

function fakeLinkElement() {
  return {
    id: 'browser_fixture_link',
    provider: 'browser' as const,
    role: 'link',
    label: 'Guide',
    text: 'Guide',
    tagName: 'a',
    attributes: { href: 'https://fixture.local/guide', class: 'result-link', 'data-spectrai-cuid': 'browser_fixture_link' },
    bounds: { x: 12, y: 40, width: 180, height: 24 },
    actionable: true,
    enabled: true,
    visible: true,
    focused: false,
    metadata: {
      targetId: '',
      framePath: [] as string[],
      cssPath: 'a.result-link',
      xpath: '//a[@class="result-link"]',
      selector: { css: 'a.result-link', role: 'link' },
      spectraiId: 'browser_fixture_link',
      tagName: 'a',
      editable: false,
      clickable: true,
      source: 'dom' as const,
    },
  }
}

function fakeState(
  value: string,
  overrides: Partial<{ url: string; title: string; mutationHash: string; focused: boolean }> = {},
) {
  return {
    url: overrides.url ?? 'https://fixture.local/form',
    title: overrides.title ?? 'Fixture Form',
    text: '',
    value,
    focused: overrides.focused ?? true,
    enabled: true,
    visible: true,
    mutationHash: overrides.mutationHash ?? value,
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
