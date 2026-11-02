import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  contextFromMeta,
  currentToolCallContext,
  META_SESSION_ID,
  resolveCallPath,
  runWithToolCallContext,
  SessionStateStore,
} from '../call-context.js'
import { parseScreenshotMetaJson } from '../screenshot-meta.js'
import {
  classifyClickGuard,
  formatClickGuardRefusal,
  isSelfHostWindow,
  parseClickProbe,
  parseForegroundLine,
  parseWindowLine,
  type ClickProbe,
  type WindowIdentity,
} from '../window-identity.js'

// Maximized on a left monitor: negative origin, as seen on the affected machine.
const identity: WindowIdentity = { hwnd: 100, pid: 7, left: -2574, top: -14, right: -14, bottom: 1426, title: 'Login' }
const probe: ClickProbe = {
  exists: true, pid: 7, visible: true, iconic: false,
  left: -2574, top: -14, right: -14, bottom: 1426,
  foreground: 100, foregroundPid: 7, foregroundTitle: 'Login',
  hit: 100, hitTitle: 'Login',
}
const classify = (over: Partial<ClickProbe>, foregroundAtCapture = 100) =>
  classifyClickGuard({ rootHwnd: 100, identity, foregroundAtCapture, probe: { ...probe, ...over } })
const code = (r: ReturnType<typeof classify>) => (r.ok ? 'ok' : r.code)

describe('classifyClickGuard', () => {
  it('allows the captured window at negative coordinates', () => {
    assert.equal(code(classify({})), 'ok')
  })

  it('allows a menu of the foreground app (same pid, separate top-level window)', () => {
    assert.equal(code(classify({ foreground: 200, foregroundPid: 7 }, 200)), 'ok')
    // A sibling window of the same app taking over after the capture is still drift.
    assert.equal(code(classify({ foreground: 200, foregroundPid: 7 }, 100)), 'foreground_changed')
  })

  it('fails closed without window identity or probe', () => {
    assert.equal(code(classifyClickGuard({ rootHwnd: 0, identity: null, probe })), 'no_window_identity')
    assert.equal(code(classifyClickGuard({ rootHwnd: 100, identity, probe: null })), 'probe_failed')
  })

  it('treats a destroyed window and a reused handle as gone', () => {
    assert.equal(code(classify({ exists: false })), 'window_gone')
    assert.equal(code(classify({ pid: 8 })), 'window_gone')
  })

  it('reports hidden, moved and occluded states', () => {
    assert.equal(code(classify({ iconic: true })), 'window_hidden')
    assert.equal(code(classify({ visible: false })), 'window_hidden')
    assert.equal(code(classify({ left: -2570 })), 'window_moved')
    assert.equal(code(classify({ hit: 300, hitTitle: 'Weixin' })), 'target_occluded')
  })

  it('separates foreground drift from a window that was always behind', () => {
    const elsewhere = { foreground: 300, foregroundPid: 9, foregroundTitle: 'Weixin' }
    assert.equal(code(classify(elsewhere, 100)), 'foreground_changed')
    assert.equal(code(classify(elsewhere, 300)), 'not_foreground')
    assert.equal(code(classify({ foreground: 0, foregroundPid: 0 })), 'foreground_unavailable')
  })

  it('drift refusal tells the model to pause; refusals never ask for a blind retry', () => {
    const r = classify({ foreground: 300, foregroundPid: 9, foregroundTitle: 'Weixin' })
    assert.equal(r.ok, false)
    if (r.ok) return
    const text = formatClickGuardRefusal('Click', r)
    assert.match(text, /Pause/)
    assert.match(text, /No input was sent/)
    assert.match(text, /window_focus\(\{handle:100\}\)/)
  })
})

describe('window line parsing', () => {
  it('keeps negative rects and pipes in titles', () => {
    assert.deepEqual(parseWindowLine('__WIN__|100|7|-2574|-14|-14|1426|a|b'), { ...identity, title: 'a|b' })
    assert.equal(parseWindowLine('1|OK|Button|2|3'), null)
    assert.equal(parseWindowLine('__WIN__|0|7|0|0|1|1|x'), null)
  })

  it('reads foreground drift and the click probe', () => {
    assert.deepEqual(parseForegroundLine('__FG__|1|2'), { start: 1, end: 2 })
    assert.equal(parseForegroundLine('1|x|y'), null)
    assert.equal(parseClickProbe('noise\n__SPECTRAI_CLICK_PROBE__{"exists":true}\r\n')?.exists, true)
    assert.equal(parseClickProbe('noise'), null)
    assert.equal(parseClickProbe('__SPECTRAI_CLICK_PROBE__{oops'), null)
  })

  it('flags captures of the host app', () => {
    assert.equal(isSelfHostWindow('SpectrAI'), true)
    assert.equal(isSelfHostWindow('Weixin'), false)
  })
})

describe('screenshot meta round trip', () => {
  it('keeps what a restarted process needs to act safely', () => {
    const raw = JSON.stringify({
      captureX: -14, captureY: -14, captureW: 100, captureH: 100, imageW: 50, imageH: 50,
      elements: [{
        number: 2, name: 'Login', controlType: 'ControlType.Pane', screenX: -5, screenY: 3,
        processId: 7, automationId: 'a', className: 'c', patterns: [],
        rootHwnd: 100, window: identity, foregroundAtCapture: 100,
      }],
    })
    const el = parseScreenshotMetaJson(raw)?.elements?.[0]
    assert.equal(el?.rootHwnd, 100)
    assert.deepEqual(el?.window, identity)
    assert.equal(el?.foregroundAtCapture, 100)
    assert.equal(el?.processId, 7)
    assert.equal(el?.screenX, -5)
  })
})

describe('session isolation', () => {
  it('keeps concurrent sessions apart across awaits', async () => {
    const store = new SessionStateStore(() => ({ last: '' }))
    const run = (sessionId: string, delay: number) =>
      runWithToolCallContext({ sessionId }, async () => {
        store.current().last = sessionId
        await new Promise(r => setTimeout(r, delay))
        return store.current().last
      })
    assert.deepEqual(await Promise.all([run('a', 20), run('b', 1)]), ['a', 'b'])
    assert.equal(store.current().last, '')
  })

  it('evicts the least recently used session', () => {
    const store = new SessionStateStore(() => ({ last: '' }), 2)
    const set = (sessionId: string) => runWithToolCallContext({ sessionId }, () => { store.current().last = sessionId })
    const get = (sessionId: string) => runWithToolCallContext({ sessionId }, () => store.current().last)
    set('a'); set('b')
    assert.equal(get('a'), 'a')
    set('c')
    assert.equal(get('b'), '')
  })

  it('reads identity from _meta and resolves paths against the caller', () => {
    assert.equal(contextFromMeta({ [META_SESSION_ID]: 's1' }).sessionId, 's1')
    assert.deepEqual(contextFromMeta(undefined), { sessionId: undefined, cwd: undefined })
    assert.equal(currentToolCallContext().sessionId, undefined)
    const base = process.platform === 'win32' ? 'C:\\work' : '/work'
    const got = runWithToolCallContext({ cwd: base }, () => resolveCallPath('a.txt'))
    assert.ok(got.startsWith(base))
  })
})
