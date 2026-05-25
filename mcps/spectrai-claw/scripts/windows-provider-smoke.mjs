#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = resolve(__dirname, '..')
const DIST_PROVIDER = resolve(PROJECT_ROOT, 'dist', 'computer-use', 'providers', 'windows', 'index.js')

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function createValueFixtureScript(title) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = ${psQuote(title)}
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(80, 80)
$form.Size = New-Object System.Drawing.Size(420, 180)
$form.TopMost = $true
$textBox = New-Object System.Windows.Forms.TextBox
$textBox.Name = 'SmokeInput'
$textBox.AccessibleName = 'SmokeInput'
$textBox.Text = 'initial'
$textBox.Location = New-Object System.Drawing.Point(24, 28)
$textBox.Size = New-Object System.Drawing.Size(320, 28)
$form.Controls.Add($textBox)
$form.Add_Shown({ $form.Activate(); [void]$textBox.Focus(); [Console]::Out.WriteLine('SPECTRAI_FIXTURE_READY:' + $PID); [Console]::Out.Flush() })
[void][System.Windows.Forms.Application]::Run($form)
`
}

function createActionFixtureScript(title) {
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
$button.Name = 'SmokeApplyButton'
$button.AccessibleName = 'Apply Smoke'
$button.Text = 'Apply Smoke'
$button.Location = New-Object System.Drawing.Point(24, 24)
$button.Size = New-Object System.Drawing.Size(130, 32)
$button.Add_Click({ $form.Text = 'Clicked:Apply Smoke' })
$form.Controls.Add($button)
$list = New-Object System.Windows.Forms.ListBox
$list.Name = 'SmokeList'
$list.AccessibleName = 'Smoke List'
$list.Location = New-Object System.Drawing.Point(24, 88)
$list.Size = New-Object System.Drawing.Size(220, 110)
[void]$list.Items.Add('Alpha')
[void]$list.Items.Add('Beta')
[void]$list.Items.Add('Gamma')
$list.SelectedIndex = 0
$form.Controls.Add($list)
$form.Add_Shown({ [Console]::Out.WriteLine('SPECTRAI_FIXTURE_READY:' + $PID); [Console]::Out.Flush() })
[void][System.Windows.Forms.Application]::Run($form)
`
}

async function startFixture(title, script) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: false,
  })

  let stdout = ''
  let stderr = ''
  let settled = false
  const ready = new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      rejectPromise(new Error(`Timed out waiting for Windows fixture ${title}. stdout=${stdout} stderr=${stderr}`))
    }, 12_000)

    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      const match = stdout.match(/SPECTRAI_FIXTURE_READY:(\d+)/)
      if (match && !settled) {
        settled = true
        clearTimeout(timeout)
        resolvePromise(Number(match[1]))
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
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
      rejectPromise(new Error(`Windows fixture ${title} exited early with code ${code}. stdout=${stdout} stderr=${stderr}`))
    })
  })

  child.stdin.end(script, 'utf-8')
  const pid = await ready
  await sleep(900)
  return { child, pid, title }
}

async function waitForElement(provider, selector, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const element = await provider.findElement(selector)
    if (element) return element
    await sleep(120)
  }
  return null
}

async function waitForWindowTitle(provider, processId, titleContains, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const state = await provider.getAppState({ processId })
    const matched = state.windows.find((window) => window.title.includes(titleContains))
    if (matched) return matched
    await sleep(120)
  }
  return null
}

async function retrySetValue(provider, target, text, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs
  let lastResult = null
  while (Date.now() <= deadline) {
    lastResult = await provider.setValue(target, text)
    if (lastResult.ok) return lastResult
    await sleep(160)
  }
  return lastResult
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('WINDOWS_PROVIDER_SMOKE_SKIPPED platform_not_win32')
    return 0
  }
  if (!existsSync(DIST_PROVIDER)) {
    throw new Error(`Provider dist file not found: ${DIST_PROVIDER}. Run npm run build first.`)
  }

  const { WindowsComputerUseProvider } = await import(pathToFileURL(DIST_PROVIDER).href)
  const provider = new WindowsComputerUseProvider()
  const fixtures = []
  const suffix = randomUUID().slice(0, 8)

  try {
    const capabilities = provider.getCapabilities()
    assert.equal(capabilities.available, true)

    const valueTitle = `SpectrAI Windows Value Smoke ${suffix}`
    const valueFixture = await startFixture(valueTitle, createValueFixtureScript(valueTitle))
    fixtures.push(valueFixture)

    const valueState = await provider.getAppState({ processId: valueFixture.pid })
    assert.ok(valueState.windows.some((window) => window.title.includes(valueTitle)), 'value fixture window should be visible in app state')
    const valueTree = await provider.getAppTree({ processId: valueFixture.pid, maxDepth: 6 })
    assert.ok(valueTree.nodes.length >= 1, 'value fixture UIA tree should contain at least one root')

    let input = await waitForElement(provider, { processId: valueFixture.pid, automationId: 'SmokeInput', controlType: 'Edit', exact: true, maxDepth: 8 })
      ?? await waitForElement(provider, { processId: valueFixture.pid, name: 'SmokeInput', controlType: 'Edit', exact: true, maxDepth: 8 })
      ?? await waitForElement(provider, { processId: valueFixture.pid, controlType: 'Edit', maxDepth: 8 })
    if (input) {
      assert.ok(input.capabilities.backgroundType, 'TextBox should advertise background type capability')
    }

    const typedText = `from-provider-${suffix}`
    const valueSelector = input ?? { processId: valueFixture.pid, controlType: 'Edit', maxDepth: 8 }
    const setValue = await retrySetValue(provider, valueSelector, typedText)
    input = input ?? setValue.target
    assert.equal(setValue.ok, true, setValue.message)
    assert.equal(setValue.verification?.actualValue, typedText)
    assert.match(String(setValue.method), /uiaValue|win32SetText/)

    valueFixture.child.kill()

    const actionTitle = `SpectrAI Windows Action Smoke ${suffix}`
    const actionFixture = await startFixture(actionTitle, createActionFixtureScript(actionTitle))
    fixtures.push(actionFixture)

    const actionState = await provider.getAppState({ processId: actionFixture.pid })
    assert.ok(actionState.windows.some((window) => window.title.includes(actionTitle)), 'action fixture window should be visible in app state')
    const actionTree = await provider.getAppTree({ processId: actionFixture.pid, maxDepth: 6 })
    assert.ok(actionTree.nodes.length >= 1, 'action fixture UIA tree should contain at least one root')

    const button = await waitForElement(provider, { processId: actionFixture.pid, name: 'Apply Smoke', controlType: 'Button', exact: true, maxDepth: 8 })
    assert.ok(button, 'Button should be discoverable by selector')
    assert.ok(button.capabilities.backgroundInvoke, 'Button should advertise background invoke capability')

    const invoke = await provider.invokeElement(button)
    assert.equal(invoke.ok, true, invoke.message)
    assert.match(String(invoke.method), /uiaInvoke|win32BmClick/)

    const mutatedWindow = await waitForWindowTitle(provider, actionFixture.pid, 'Clicked:Apply Smoke')
    assert.ok(mutatedWindow, 'Button Invoke/BM_CLICK should mutate window title and be observable by Win32 app state')

    const beta = await waitForElement(provider, { processId: actionFixture.pid, name: 'Beta', controlType: 'ListItem', exact: true, maxDepth: 8 })
      ?? await waitForElement(provider, { processId: actionFixture.pid, name: 'Beta', exact: true, maxDepth: 8 })
    assert.ok(beta, 'List item should be discoverable by selector')

    const select = await provider.selectElement(beta)
    assert.equal(select.ok, true, select.message)
    assert.equal(select.verification?.selected, true)
    assert.equal(select.method, 'uiaSelect')

    const artifact = join(tmpdir(), `spectrai-claw-windows-provider-smoke-${suffix}.json`)
    writeFileSync(artifact, JSON.stringify({
      provider: capabilities.provider,
      artifactKind: 'windows-provider-smoke',
      valueFixture: { title: valueTitle, processId: valueFixture.pid },
      actionFixture: { title: actionTitle, processId: actionFixture.pid, mutatedTitle: mutatedWindow.title },
      capabilityReport: capabilities,
      appState: {
        valueWindowCount: valueState.windows.length,
        actionWindowCount: actionState.windows.length,
        valueWarnings: valueState.warnings,
        actionWarnings: actionState.warnings,
      },
      tree: {
        valueRootCount: valueTree.nodes.length,
        actionRootCount: actionTree.nodes.length,
        valueWarnings: valueTree.warnings,
        actionWarnings: actionTree.warnings,
      },
      selectors: {
        input: { id: input.id, patterns: input.patterns, capabilities: input.capabilities },
        button: { id: button.id, patterns: button.patterns, capabilities: button.capabilities },
        beta: { id: beta.id, patterns: beta.patterns, capabilities: beta.capabilities },
      },
      actions: { setValue, invoke, select },
    }, null, 2), 'utf-8')

    console.log(`windows provider smoke artifact: ${artifact}`)
    console.log('WINDOWS_PROVIDER_SMOKE_PASSED')
    return 0
  } finally {
    provider.dispose()
    for (const fixture of fixtures) {
      if (fixture?.child && !fixture.child.killed) {
        fixture.child.kill()
      }
    }
  }
}

main().then((code) => {
  process.exitCode = code
}).catch((err) => {
  console.error('WINDOWS_PROVIDER_SMOKE_FAILED')
  console.error(err instanceof Error ? err.stack : String(err))
  process.exitCode = 1
})
