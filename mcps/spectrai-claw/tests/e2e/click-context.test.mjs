/**
 * Real-window regression for screenshot → number → click.
 * Needs an interactive Windows desktop: it pops two small test windows, takes the foreground
 * briefly and may move the mouse. Run explicitly: npm run test:click-context
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const here = dirname(fileURLToPath(import.meta.url))
const skip = process.platform !== 'win32' && 'Windows only'
const marker = join(mkdtempSync(join(tmpdir(), 'claw-click-')), 'marker.txt')

let client
let fixture
let login, other, fixturePid, mainHandle
let originalForeground = 0

const ps = (script) =>
  spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).stdout.trim()
const USER32 = `Add-Type 'using System;using System.Runtime.InteropServices;public class U{[DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int w,int t,uint f);[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();}';`

async function call(sessionId, name, args = {}) {
  const r = await client.callTool({ name, arguments: args, _meta: { 'spectrai/sessionId': sessionId } })
  return { isError: r.isError === true, text: r.content.filter(c => c.type === 'text').map(c => c.text).join('\n') }
}
const shot = async (session, handle) => {
  const r = await call(session, 'screenshot', { followHandle: handle, includeImage: false })
  assert.equal(r.isError, false, r.text)
  return r.text
}
// Nameless WinForms panel: UIA reports a pattern-less Pane labelled with its numeric AutomationId.
const NAMELESS_PANE = String.raw`\d+`
function numberOf(text, name) {
  const m = text.match(new RegExp(`\\[(\\d+)\\] "${name}"`))
  assert.ok(m, `element ${name} not annotated:\n${text}`)
  return Number(m[1])
}
const pathOf = (text) => text.match(/Screenshot saved: (.+)/)[1].trim()
const focus = async (handle) => assert.equal((await call('t', 'window_focus', { handle })).isError, false)
const markers = () => (existsSync(marker) ? readFileSync(marker, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean) : [])
async function waitMarker(expected) {
  for (let i = 0; i < 30 && !markers().includes(expected); i++) await new Promise(r => setTimeout(r, 100))
  assert.ok(markers().includes(expected), `marker ${expected} missing, got ${markers()}`)
}

before(async () => {
  if (skip) return
  originalForeground = Number(ps(`${USER32}[U]::GetForegroundWindow().ToInt64()`))
  fixture = spawn('powershell', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'click-context-fixture.ps1'), '-Marker', marker], { stdio: ['ignore', 'pipe', 'inherit'] })
  const ready = await new Promise((res, rej) => {
    let buf = ''
    fixture.stdout.on('data', d => { buf += d; const m = buf.match(/READY\|(\d+)\|(\d+)\|(\d+)\|(\d+)/); if (m) res(m) })
    fixture.on('exit', c => rej(new Error(`fixture exited ${c}`)))
    setTimeout(() => rej(new Error('fixture timeout')), 20000)
  })
  ;[login, other, fixturePid, mainHandle] = ready.slice(1).map(Number)
  client = new Client({ name: 'click-context-test', version: '1' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(here, '..', '..', 'dist', 'index.js')] }))
})

after(async () => {
  if (skip) return
  await client?.close().catch(() => {})
  try { fixture?.kill() } catch { /* already gone */ }
  if (originalForeground) ps(`Add-Type 'using System;using System.Runtime.InteropServices;public class V{[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);}';[V]::SetForegroundWindow([IntPtr]::new(${originalForeground}))|Out-Null`)
})

test('fixture reproduces the field condition: owned dialog, MainWindowHandle=0', { skip }, () => {
  assert.equal(mainHandle, 0)
})

test('owned dialog: followProcessId finds it and screenshot → click works', { skip }, async () => {
  await focus(login)
  const r = await call('a', 'screenshot', { followProcessId: fixturePid, includeImage: false })
  assert.match(r.text, /Elements belong to: "ClawFixture(Login|Other)"/)
  const text = await shot('a', login)
  assert.match(text, new RegExp(`"ClawFixtureLogin" hwnd=${login}`))
  const c = await call('a', 'click_element', { number: numberOf(text, 'ClawFixtureLoginButton') })
  assert.equal(c.isError, false, c.text)
  await waitMarker('button:ClawFixtureLogin')
})

test('Pane without patterns or usable UIA hwnd: click reaches it via HID', { skip }, async () => {
  await focus(login)
  const text = await shot('a', login)
  const c = await call('a', 'click_element', { number: numberOf(text, NAMELESS_PANE) })
  assert.equal(c.isError, false, c.text)
  await waitMarker('pane:ClawFixtureLogin')
})

test('concurrent sessions: numbers stay bound to the caller’s own screenshot', { skip }, async () => {
  const fresh = await call('never-captured', 'click_element', { number: 1 })
  assert.equal(fresh.isError, true)
  assert.match(fresh.text, /No annotated screenshot in this session/)

  await focus(login)
  const textA = await shot('a', login)
  const textB = await shot('b', other) // later capture in another session must not overwrite A
  assert.ok(textB.includes(`hwnd=${other}`))
  const before = markers().length
  const c = await call('a', 'click_element', { number: numberOf(textA, 'ClawFixtureLoginButton') })
  assert.equal(c.isError, false, c.text)
  await new Promise(r => setTimeout(r, 300))
  assert.deepEqual(markers().slice(before), ['button:ClawFixtureLogin'])
})

test('explicit screenshotPath binds to that image; a bad path never falls back to another', { skip }, async () => {
  await focus(login)
  const text = await shot('a', login)
  const miss = await call('a', 'click_element', { number: 1, screenshotPath: join(tmpdir(), 'claw-no-such-shot.png') })
  assert.equal(miss.isError, true)
  assert.match(miss.text, /No annotated elements found/)
  await shot('a', other) // pointer moves on, but the explicit path still resolves
  const c = await call('a', 'click_element', { number: numberOf(text, NAMELESS_PANE), screenshotPath: pathOf(text) })
  assert.equal(c.isError, false, c.text)
})

test('foreground drift: refuses, sends nothing, does not take focus back', { skip }, async () => {
  await focus(login)
  const text = await shot('a', login)
  await focus(other)
  const before = markers().length
  const c = await call('a', 'click_element', { number: numberOf(text, 'ClawFixtureLoginButton') })
  assert.equal(c.isError, true)
  assert.match(c.text, /Click aborted: foreground_changed/)
  assert.equal(markers().length, before)
  assert.equal(Number(ps(`${USER32}[U]::GetForegroundWindow().ToInt64()`)), other)
  // The named recovery works without a new screenshot.
  await focus(login)
  const retry = await call('a', 'click_element', { number: numberOf(text, 'ClawFixtureLoginButton') })
  assert.equal(retry.isError, false, retry.text)
})

test('keyboard_type refuses before sending input to a window that lost the foreground', { skip }, async () => {
  await focus(login)
  const text = await shot('a', login)
  await focus(other)
  const c = await call('a', 'keyboard_type', { text: 'x', number: numberOf(text, NAMELESS_PANE) })
  assert.equal(c.isError, true)
  assert.match(c.text, /Type aborted: foreground_changed/)
})

test('window moved (including to a negative origin): refuses stale coordinates', { skip }, async () => {
  await focus(login)
  const text = await shot('a', login)
  ps(`${USER32}[U]::SetWindowPos([IntPtr]::new(${login}),[IntPtr]::Zero,-40,120,0,0,0x15)|Out-Null`) // NOSIZE|NOZORDER|NOACTIVATE
  const c = await call('a', 'click_element', { number: numberOf(text, 'ClawFixtureLoginButton') })
  assert.equal(c.isError, true)
  assert.match(c.text, /Click aborted: window_moved/)
  // Negative-origin window still round-trips through a fresh capture.
  const again = await shot('a', login)
  assert.match(again, /origin=\(-\d+,/) // exact value depends on display scaling
  const ok = await call('a', 'click_element', { number: numberOf(again, 'ClawFixtureLoginButton') })
  assert.equal(ok.isError, false, ok.text)
})

test('window destroyed: reports window_gone, not a focus failure', { skip }, async () => {
  await focus(login)
  const text = await shot('a', login)
  fixture.kill()
  await new Promise(r => setTimeout(r, 500))
  const c = await call('a', 'click_element', { number: numberOf(text, 'ClawFixtureLoginButton') })
  assert.equal(c.isError, true)
  assert.match(c.text, /Click aborted: window_gone/)
  assert.doesNotMatch(c.text, /focus_failed/)
})
