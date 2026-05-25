import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const fixturePath = join(__dirname, 'fixtures', 'windows-computer-use-real-apps.json')

async function loadFixture() {
  return JSON.parse(await readFile(fixturePath, 'utf8'))
}

const requiredCapabilityKeys = [
  'backgroundRead',
  'backgroundInvoke',
  'backgroundType',
  'requiresForeground',
  'visionFallbackNeeded',
  'fallbackUsed',
  'verificationConfidence',
]

const expectedScenarioIds = [
  'win-list-windows',
  'win-read-uia-tree',
  'win-selector-find',
  'calculator-invoke-button',
  'notepad-setvalue-type-verify',
  'explorer-focus-select',
]

const expectedTroubleshootingTerms = [
  'UIA tree',
  'AutomationId',
  'Win32 BM_CLICK',
  'foreground',
  'DPI',
  'RDP',
]

describe('Windows real-app computer-use fixture', () => {
  it('declares the Windows provider and required preflight checks', async () => {
    const fixture = await loadFixture()
    assert.equal(fixture.provider, 'windows-uia-win32')
    assert.equal(fixture.schemaVersion, 1)
    const checkIds = fixture.preflightChecklist.map(item => item.id)
    for (const id of ['uia-availability', 'win32-fallback', 'iaccessible-wake', 'foreground-hid-fallback', 'session-permissions']) {
      assert.ok(checkIds.includes(id), `missing preflight check: ${id}`)
    }
  })

  it('covers required real Windows app scenarios with capability expectations', async () => {
    const fixture = await loadFixture()
    const scenarioIds = fixture.scenarios.map(item => item.id)
    for (const id of expectedScenarioIds) {
      assert.ok(scenarioIds.includes(id), `missing scenario: ${id}`)
    }

    for (const scenario of fixture.scenarios) {
      assert.ok(scenario.app, `${scenario.id} missing app`)
      assert.ok(scenario.operation, `${scenario.id} missing operation`)
      assert.ok(Array.isArray(scenario.assertions) && scenario.assertions.length > 0, `${scenario.id} missing assertions`)
      for (const key of requiredCapabilityKeys) {
        assert.ok(Object.hasOwn(scenario.capabilityExpected, key), `${scenario.id} missing capabilityExpected.${key}`)
      }
      assert.ok(['high', 'medium', 'low'].includes(scenario.capabilityExpected.verificationConfidence), `${scenario.id} invalid verificationConfidence`)
    }
  })

  it('includes explicit background and fallback expectations for semantic actions', async () => {
    const fixture = await loadFixture()
    const byId = Object.fromEntries(fixture.scenarios.map(item => [item.id, item]))

    assert.equal(byId['calculator-invoke-button'].capabilityExpected.backgroundInvoke, true)
    assert.match(byId['calculator-invoke-button'].capabilityExpected.fallbackUsed, /InvokePattern|BM_CLICK/)

    assert.equal(byId['notepad-setvalue-type-verify'].capabilityExpected.backgroundType, true)
    assert.match(byId['notepad-setvalue-type-verify'].capabilityExpected.fallbackUsed, /ValuePattern|WM_SETTEXT/)

    assert.equal(byId['explorer-focus-select'].capabilityExpected.backgroundRead, true)
    assert.match(byId['explorer-focus-select'].capabilityExpected.fallbackUsed, /SelectionItemPattern|SetFocus|foreground/)
  })

  it('documents troubleshooting for the known Windows compatibility risks', async () => {
    const fixture = await loadFixture()
    const text = JSON.stringify(fixture.troubleshooting)
    for (const term of expectedTroubleshootingTerms) {
      assert.match(text, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `missing troubleshooting term: ${term}`)
    }
  })
})
