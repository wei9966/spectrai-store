#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, '..')
const fixturePath = join(repoRoot, 'tests', 'fixtures', 'windows-computer-use-real-apps.json')
const providerDistPath = join(repoRoot, 'dist', 'computer-use', 'providers', 'windows', 'index.js')
const args = new Set(process.argv.slice(2))

const fixtureOnly = args.has('--fixture-only')
const listOnly = args.has('--list-only')
const readOnly = args.has('--read-only') || listOnly || (!fixtureOnly && !args.has('--mutate'))
const mutate = args.has('--mutate') || process.env.SPECTRAI_WINDOWS_MUTATING_SMOKE === '1'
const launch = args.has('--launch')

function usage() {
  return `Windows Computer Use smoke

Usage:
  node scripts/windows-computer-use-smoke.mjs --fixture-only
  node scripts/windows-computer-use-smoke.mjs --list-only
  node scripts/windows-computer-use-smoke.mjs --read-only
  SPECTRAI_WINDOWS_MUTATING_SMOKE=1 node scripts/windows-computer-use-smoke.mjs --mutate --launch

Notes:
  - --fixture-only validates tests/fixtures/windows-computer-use-real-apps.json and does not import the provider.
  - --list-only imports the built dist provider and runs getCapabilityReport/listWindows only.
  - --read-only additionally samples readTree on an existing target window when possible.
  - --mutate may invoke Calculator, set text in Notepad, and select/focus in Explorer. Use only on an unlocked interactive Windows desktop.
  - Run npm run build before provider-backed modes so dist/computer-use/providers/windows exists.
`
}

function requireField(condition, message) {
  if (!condition) throw new Error(message)
}

function validateFixture(fixture) {
  requireField(fixture.schemaVersion === 1, 'schemaVersion must be 1')
  requireField(fixture.provider === 'windows-uia-win32', 'provider must be windows-uia-win32')
  requireField(Array.isArray(fixture.preflightChecklist) && fixture.preflightChecklist.length >= 5, 'preflightChecklist must include at least five checks')
  requireField(Array.isArray(fixture.scenarios) && fixture.scenarios.length >= 6, 'scenarios must include the required real-app coverage')
  requireField(Array.isArray(fixture.troubleshooting) && fixture.troubleshooting.length >= 6, 'troubleshooting must include compatibility risks')

  const requiredScenarioIds = [
    'win-list-windows',
    'win-read-uia-tree',
    'win-selector-find',
    'calculator-invoke-button',
    'notepad-setvalue-type-verify',
    'explorer-focus-select',
  ]
  const scenarioIds = new Set(fixture.scenarios.map(scenario => scenario.id))
  for (const id of requiredScenarioIds) requireField(scenarioIds.has(id), `missing scenario ${id}`)

  const capabilityKeys = ['backgroundRead', 'backgroundInvoke', 'backgroundType', 'requiresForeground', 'visionFallbackNeeded', 'fallbackUsed', 'verificationConfidence']
  for (const scenario of fixture.scenarios) {
    requireField(scenario.id, 'scenario missing id')
    requireField(scenario.operation, `${scenario.id} missing operation`)
    requireField(Array.isArray(scenario.assertions) && scenario.assertions.length > 0, `${scenario.id} missing assertions`)
    for (const key of capabilityKeys) requireField(Object.hasOwn(scenario.capabilityExpected, key), `${scenario.id} missing capabilityExpected.${key}`)
  }

  return {
    scenarioCount: fixture.scenarios.length,
    preflightCount: fixture.preflightChecklist.length,
    troubleshootingCount: fixture.troubleshooting.length,
  }
}

async function loadFixture() {
  return JSON.parse(await readFile(fixturePath, 'utf8'))
}

async function loadProvider() {
  if (!existsSync(providerDistPath)) {
    throw new Error(`Built provider not found: ${providerDistPath}. Run npm run build first.`)
  }
  const module = await import(pathToFileURL(providerDistPath).href)
  return module.windowsComputerUseProvider
}

function findScenario(fixture, id) {
  return fixture.scenarios.find(scenario => scenario.id === id)
}

function makeRegex(pattern) {
  return new RegExp(pattern, 'i')
}

function findWindowByScenario(windows, scenario) {
  const regex = makeRegex(scenario.titlePattern || '.*')
  return windows.find(window => regex.test(window.title))
}

function flatten(nodes) {
  const result = []
  const visit = node => {
    result.push(node)
    for (const child of node.children || []) visit(child)
  }
  for (const node of nodes || []) visit(node)
  return result
}

function expandAlternatives(value) {
  if (typeof value !== 'string' || !value.includes('|')) return [value]
  return value.split('|').map(item => item.trim()).filter(Boolean)
}

function expandSelector(selector) {
  const keys = Object.keys(selector || {})
  let selectors = [{}]
  for (const key of keys) {
    const values = expandAlternatives(selector[key])
    selectors = selectors.flatMap(base => values.map(value => ({ ...base, [key]: value })))
  }
  return selectors
}

async function findFirstElement(provider, baseOptions, selectors) {
  for (const selector of selectors) {
    const element = await provider.findElement({ ...baseOptions, selector })
    if (element) return { element, selector }
  }
  return { element: null, selector: null }
}

async function runReadOnlySmoke(provider, fixture) {
  const report = provider.getCapabilityReport()
  const windows = await provider.listWindows()
  requireField(windows.length > 0, 'listWindows returned no visible windows')

  const output = {
    provider: report.provider,
    supportsUia: report.supportsUia,
    supportsWin32Semantic: report.supportsWin32Semantic,
    supportsIAccessibleWake: report.supportsIAccessibleWake,
    windowCount: windows.length,
    sampledWindow: windows[0],
    readTree: null,
  }

  if (!listOnly) {
    const treeScenario = findScenario(fixture, 'win-read-uia-tree')
    const target = findWindowByScenario(windows, treeScenario) || windows[0]
    const tree = await provider.readTree({ processId: target.processId, windowId: target.windowId, depth: 4, maxNodes: 500 })
    const nodes = flatten(tree)
    output.readTree = {
      target: { title: target.title, processId: target.processId, windowId: target.windowId },
      roots: tree.length,
      nodes: nodes.length,
      patternNodes: nodes.filter(node => Array.isArray(node.patterns) && node.patterns.length > 0).length,
      hwndNodes: nodes.filter(node => node.nativeWindowHandle).length,
    }
    requireField(tree.length > 0, `readTree returned no roots for ${target.title}`)
  }

  return output
}

function launchApp(command, args = []) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
}

async function wait(ms) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function runMutatingSmoke(provider, fixture) {
  if (process.platform !== 'win32') throw new Error('--mutate requires Windows')
  if (launch) {
    launchApp('calc.exe')
    launchApp('notepad.exe')
    launchApp('explorer.exe')
    await wait(2500)
  }

  const windows = await provider.listWindows()
  const results = []

  const calculatorScenario = findScenario(fixture, 'calculator-invoke-button')
  const calculatorWindow = findWindowByScenario(windows, calculatorScenario)
  if (calculatorWindow) {
    const selectors = [
      { automationId: calculatorScenario.selector.automationId },
      { name: calculatorScenario.selector.name, controlType: calculatorScenario.selector.controlType },
      ...expandSelector(calculatorScenario.selector),
    ]
    const { element, selector } = await findFirstElement(provider, { processId: calculatorWindow.processId, windowId: calculatorWindow.windowId, depth: 6 }, selectors)
    if (element) {
      const action = await provider.executeAction({ element, action: 'invoke', requireBackground: true, verify: true })
      results.push({ scenario: calculatorScenario.id, ok: action.ok, selector, method: action.method, failure: action.failure })
    } else {
      results.push({ scenario: calculatorScenario.id, ok: false, failure: 'calculator button not found' })
    }
  } else {
    results.push({ scenario: calculatorScenario.id, ok: false, failure: 'Calculator window not found' })
  }

  const notepadScenario = findScenario(fixture, 'notepad-setvalue-type-verify')
  const notepadWindow = findWindowByScenario(windows, notepadScenario)
  if (notepadWindow) {
    const selectors = [
      { controlType: 'Edit' },
      { className: 'Edit' },
      { className: 'RichEditD2DPT' },
      ...expandSelector(notepadScenario.selector),
    ]
    const { element, selector } = await findFirstElement(provider, { processId: notepadWindow.processId, windowId: notepadWindow.windowId, depth: 6 }, selectors)
    if (element) {
      const value = `${notepadScenario.inputText} ${new Date().toISOString()}`
      const action = await provider.executeAction({ element, action: 'setValue', value, requireBackground: true, verify: true })
      results.push({ scenario: notepadScenario.id, ok: action.ok, selector, method: action.method, verification: action.verification, failure: action.failure })
    } else {
      results.push({ scenario: notepadScenario.id, ok: false, failure: 'Notepad edit element not found' })
    }
  } else {
    results.push({ scenario: notepadScenario.id, ok: false, failure: 'Notepad window not found' })
  }

  const explorerScenario = findScenario(fixture, 'explorer-focus-select')
  const explorerWindow = findWindowByScenario(windows, explorerScenario)
  if (explorerWindow) {
    const selectors = expandSelector(explorerScenario.selector)
    const { element, selector } = await findFirstElement(provider, { processId: explorerWindow.processId, windowId: explorerWindow.windowId, depth: 6 }, selectors)
    if (element) {
      const actionKind = element.supportedActions?.includes('select') ? 'select' : 'focus'
      const action = await provider.executeAction({ element, action: actionKind, requireBackground: false, verify: true })
      results.push({ scenario: explorerScenario.id, ok: action.ok, selector, action: actionKind, method: action.method, verification: action.verification, failure: action.failure })
    } else {
      results.push({ scenario: explorerScenario.id, ok: false, failure: 'Explorer selectable/focusable item not found' })
    }
  } else {
    results.push({ scenario: explorerScenario.id, ok: false, failure: 'Explorer window not found' })
  }

  return results
}

try {
  if (args.has('--help') || args.has('-h')) {
    console.log(usage())
    process.exit(0)
  }

  const fixture = await loadFixture()
  const fixtureSummary = validateFixture(fixture)
  const result = { fixture: fixtureSummary }

  if (!fixtureOnly) {
    const provider = await loadProvider()
    if (readOnly) result.readOnly = await runReadOnlySmoke(provider, fixture)
    if (mutate) result.mutating = await runMutatingSmoke(provider, fixture)
  }

  console.log(JSON.stringify(result, null, 2))
  process.exit(0)
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
}
