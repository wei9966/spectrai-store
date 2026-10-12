// Regression anchor: UIA-driven invoke CHANGES the foreground window.
//
// Why this file exists
// --------------------
// The Windows provider reports `backgroundInvoke: true` / `requiresForeground: false`
// for elements it can drive through UIA semantic patterns
// (src/computer-use/providers/windows/provider.ts `actionMatrix()`,
//  src/computer-use/providers/windows/uia-mapper.ts `backgroundInvoke: canInvoke || canWin32Invoke`).
//
// That capability flag only answers "can this be initiated without first activating
// the window". It does NOT mean "the user will not be disturbed", because in practice
// a UIA invoke brings the target window to the foreground.
//
// Measured independently (see the E6/E7 experiments) on Chromium, UWP Calculator and
// on this repo's own WinForms fixture: invoke returns ok=true, method=uiaInvoke, and the
// foreground moves from whatever the user was using to the target window.
//
// What this test asserts
// ----------------------
// It pins BOTH halves so that if either side moves, the test fails and forces a decision:
//   (1) the capability report still claims backgroundInvoke / requiresForeground=false
//   (2) the real execution still takes the foreground
// When someone removes the side effect (virtual display, non-activating dispatch), (2)
// flips and this test tells them to update `actionMatrix()` and promote the `todo` test below.
//
// Implementation notes (both cost real debugging time - keep them)
// ---------------------------------------------------------------
// * Fixture scripts are written to a temp .ps1 and run with `-File`. Piping the same
//   script through stdin (`-Command -`) SILENTLY exits without executing anything:
//   reproduced directly - identical bytes work with -File and produce no output at all
//   via stdin. Keeping the file on disk also makes failures debuggable.
// * `provider.dispose()` is required in teardown: the provider holds a long-lived helper
//   shell, and without dispose() the node test process never exits.
// * Build the fixture-ready promise, THEN end/close, and only afterwards await. Awaiting
//   first deadlocks.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { existsSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = resolve(__dirname, '..')
const DIST_PROVIDER = resolve(PROJECT_ROOT, 'dist', 'computer-use', 'providers', 'windows', 'index.js')

const psQuote = (v) => "'" + String(v).replace(/'/g, "''") + "'"

// A target whose button is reachable through UIA semantic dispatch, laid out away from
// the front window so it is not occluded.
function createTargetFixture(title) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = ${psQuote(title)}
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(560, 120)
$form.Size = New-Object System.Drawing.Size(500, 300)
$button = New-Object System.Windows.Forms.Button
$button.Name = 'FgSideEffectButton'
$button.AccessibleName = 'Fg Side Effect Button'
$button.Text = 'Fg Side Effect'
$button.Location = New-Object System.Drawing.Point(24, 24)
$button.Size = New-Object System.Drawing.Size(180, 32)
$button.Add_Click({ $form.Text = 'Clicked:FgSideEffect' })
$form.Controls.Add($button)
$form.Add_Shown({ [Console]::Out.WriteLine('SPECTRAI_FIXTURE_READY:' + $PID); [Console]::Out.Flush() })
[void][System.Windows.Forms.Application]::Run($form)
`
}

// This one takes the foreground so the target does not have it. Activate() alone is not
// enough (Windows only honours SetForegroundWindow from the process that owns the
// foreground), so it borrows the input queue - the same workaround that made the
// research experiments' park step reliable.
function createFrontFixture(title) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId(); [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);' -Name Fix -Namespace ClawFgFix
$form = New-Object System.Windows.Forms.Form
$form.Text = ${psQuote(title)}
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(80, 80)
$form.Size = New-Object System.Drawing.Size(420, 180)
$textBox = New-Object System.Windows.Forms.TextBox
$textBox.Name = 'FgSideEffectFrontInput'
$textBox.Text = 'initial'
$textBox.Location = New-Object System.Drawing.Point(24, 28)
$textBox.Size = New-Object System.Drawing.Size(320, 28)
$form.Controls.Add($textBox)
$form.Add_Shown({
  for ($i = 0; $i -lt 5; $i++) {
    $form.Activate()
    $fg = [ClawFgFix.Fix]::GetForegroundWindow()
    $tid = 0
    [void][ClawFgFix.Fix]::GetWindowThreadProcessId($fg, [ref]$tid)
    $my = [ClawFgFix.Fix]::GetCurrentThreadId()
    if ([ClawFgFix.Fix]::AttachThreadInput($my, $tid, $true)) {
      [void][ClawFgFix.Fix]::SetForegroundWindow($form.Handle)
      [void][ClawFgFix.Fix]::BringWindowToTop($form.Handle)
      [void][ClawFgFix.Fix]::AttachThreadInput($my, $tid, $false)
    }
    if ([ClawFgFix.Fix]::GetForegroundWindow() -eq $form.Handle) { break }
    Start-Sleep -Milliseconds 250
  }
  [void]$textBox.Focus()
  [Console]::Out.WriteLine('SPECTRAI_FIXTURE_READY:' + $PID)
  [Console]::Out.Flush()
})
[void][System.Windows.Forms.Application]::Run($form)
`
}

// Read the foreground window as "<hwnd>|<pid>|<title>".
const FG_SOURCE =
  "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); " +
  "[DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n); " +
  "[DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);' -Name Fg -Namespace ClawFgProbe; " +
  '$h = [ClawFgProbe.Fg]::GetForegroundWindow(); ' +
  '$sb = New-Object System.Text.StringBuilder 512; ' +
  '[void][ClawFgProbe.Fg]::GetWindowText($h, $sb, 512); ' +
  '$owner = 0; ' +
  '[void][ClawFgProbe.Fg]::GetWindowThreadProcessId($h, [ref]$owner); ' +
  'Write-Output ($h.ToInt64().ToString() + "|" + $owner + "|" + $sb.ToString())'

const tempScripts = []

async function startFixture(title, script, timeoutMs = 20_000) {
  const scriptPath = join(tmpdir(), `claw-fg-fixture-${randomUUID()}.ps1`)
  writeFileSync(scriptPath, script, 'utf-8')
  tempScripts.push(scriptPath)

  const child = spawn('powershell.exe',
    ['-NoProfile', '-NoLogo', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false })

  let stdout = ''
  let stderr = ''
  let settled = false
  const ready = new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      rejectPromise(new Error(`fixture "${title}" timed out. stdout=${stdout} stderr=${stderr}`))
    }, timeoutMs)
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      const match = stdout.match(/SPECTRAI_FIXTURE_READY:(\d+)/)
      if (match && !settled) {
        settled = true
        clearTimeout(timer)
        resolvePromise(Number(match[1]))
      }
    })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(err)
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(new Error(`fixture "${title}" exited early with ${code}. stdout=${stdout} stderr=${stderr}`))
    })
  })

  const pid = await ready
  await sleep(1_200)
  return { child, pid, title, scriptPath }
}

function readForeground() {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile('powershell.exe', ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', FG_SOURCE],
      { timeout: 20_000 }, (err, stdout) => {
        if (err) return rejectPromise(err)
        const [hwnd, pid, title] = stdout.trim().split('|')
        resolvePromise({ hwnd: Number(hwnd), pid: Number(pid), title })
      })
  })
}

function cleanupTempScripts() {
  while (tempScripts.length) {
    const p = tempScripts.pop()
    try { rmSync(p, { force: true }) } catch { /* ignore */ }
  }
}

function skipUnlessRunnable(t) {
  if (process.platform !== 'win32') {
    t.skip('Windows-provider foreground side-effect check is win32-only.')
    return true
  }
  if (!existsSync(DIST_PROVIDER)) {
    t.skip('dist/computer-use/providers/windows/index.js not found. Run `npm run build` first.')
    return true
  }
  return false
}

describe('windows provider: invoke changes the foreground (regression anchor)', () => {
  it('uiaInvoke reports backgroundInvoke=true yet still takes the foreground', { timeout: 90_000 }, async (t) => {
    if (skipUnlessRunnable(t)) return

    const mod = await import(pathToFileURL(DIST_PROVIDER).href)
    const provider = new mod.WindowsComputerUseProvider()

    let target
    let front
    try {
      target = await startFixture('Claw FgCheck Target', createTargetFixture('Claw FgCheck Target'))
      front = await startFixture('Claw FgCheck Front', createFrontFixture('Claw FgCheck Front'))
      await sleep(1_000)

      const fgBefore = await readForeground()
      if (fgBefore.pid === target.pid) {
        console.log('[fg-side-effect] SKIP: target pid %s is still foreground (pid %s "%s"); could not establish the precondition.',
          target.pid, fgBefore.pid, fgBefore.title)
        t.skip('could not get the target into the background (front fixture did not take focus).')
        return
      }

      const element = await provider.findElement({ name: 'Fg Side Effect Button', processId: target.pid })
      assert.ok(element, 'target button not found through UIA')

      // Half 1: what the provider claims.
      assert.equal(element.capabilities.backgroundInvoke, true,
        'capability claim changed: this test pins the claim against observed behaviour')

      const result = await provider.invokeElement(element)
      await sleep(900)
      const fgAfter = await readForeground()

      // Half 2: what actually happens.
      assert.equal(result.ok, true, `expected invoke to succeed, got ${JSON.stringify(result.failure)}`)
      assert.equal(fgAfter.pid, target.pid,
        'expected the invoke to have taken the foreground. If this now passes without taking it, ' +
        'the side effect is gone - update actionMatrix() and promote the todo test below.')
      assert.notEqual(fgBefore.hwnd, fgAfter.hwnd, 'foreground window should have changed')

      console.log('[fg-side-effect] method=%s action=%s | foreground %s(pid %s "%s") -> %s(pid %s "%s")',
        result.method, result.action,
        fgBefore.hwnd, fgBefore.pid, fgBefore.title,
        fgAfter.hwnd, fgAfter.pid, fgAfter.title)
    } finally {
      target?.child.kill()
      front?.child.kill()
      // The provider holds a long-lived helper shell; without dispose() node never exits.
      try { provider.dispose() } catch { /* ignore */ }
      await sleep(300)
      cleanupTempScripts()
    }
  })

  // Desired end state, stated explicitly and kept visible in the test output.
  it('uiaInvoke should NOT take the foreground', { todo: 'known gap: UIA dispatch activates the target window; needs a non-activating path (virtual display / synthetic pen)' }, async () => {
    assert.fail('UIA invoke still activates the target window (see the sibling test for measurements)')
  })
})
