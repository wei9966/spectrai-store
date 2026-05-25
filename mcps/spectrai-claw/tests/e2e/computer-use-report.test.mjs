import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildCanonicalReport,
  renderMarkdownReport,
  writeReportArtifacts,
} from '../computer-use/generate-canonical-report.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PROJECT_ROOT = resolve(__dirname, '..', '..')
const SAMPLE_OBSERVATIONS = resolve(PROJECT_ROOT, 'tests', 'computer-use', 'fixtures', 'sample-runtime-observations.json')
const SCENARIOS = resolve(PROJECT_ROOT, 'tests', 'computer-use', 'fixtures', 'canonical-scenarios.json')
const REPORT_SCHEMA = resolve(PROJECT_ROOT, 'tests', 'computer-use', 'report-schema.json')

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

test('computer-use canonical report: computes semantic/background/fallback metrics from fixture', async () => {
  const input = await readJson(SAMPLE_OBSERVATIONS)
  const report = buildCanonicalReport(input, { generatedAt: '2026-05-25T00:00:00.000Z' })

  assert.equal(report.schemaVersion, 'computer-use-benchmark-report/v1')
  assert.equal(report.summary.caseCounts.total, 6)
  assert.equal(report.summary.caseCounts.passed, 4)
  assert.equal(report.summary.caseCounts.skipped, 1)
  assert.equal(report.summary.caseCounts.unsupported, 1)

  assert.equal(report.summary.requiredMetrics.semanticActionSuccessRate.rate, 0.9)
  assert.equal(report.summary.requiredMetrics.backgroundActionSuccessRate.rate, 0.9)
  assert.equal(report.summary.requiredMetrics.foregroundFallbackRate.rate, 0.1667)
  assert.equal(report.summary.requiredMetrics.visionFallbackRate.rate, 0.1667)
  assert.equal(report.summary.requiredMetrics.hidFallbackRate.rate, 0.0833)
  assert.equal(report.summary.requiredMetrics.postActionVerificationSuccessRate.rate, 1)

  assert.ok(report.summary.optionalMetrics.semanticTreeCoverage.rate > 0.85)
  assert.ok(report.summary.optionalMetrics.selectorHitRate.rate < 1, 'fallback selector miss should be observable')
  assert.equal(report.summary.optionalMetrics.misClickIncidentRate.rate, 0)
  assert.ok(report.summary.optionalMetrics.permissionBlockers.length >= 1)

  const macCase = report.cases.find(benchmarkCase => benchmarkCase.id === 'macos-ax-demo')
  assert.equal(macCase.status, 'unsupported')
  assert.match(macCase.unsupportedReason, /macOS/i)

  const fallbackCase = report.cases.find(benchmarkCase => benchmarkCase.id === 'vision-hid-fallback-canvas')
  assert.equal(fallbackCase.fallback.vision, true)
  assert.equal(fallbackCase.fallback.hid, true)

  const compatCase = report.cases.find(benchmarkCase => benchmarkCase.id === 'windows-legacy-claw-accuracy-compat')
  assert.equal(compatCase.status, 'passed')
  assert.equal(compatCase.fallback.hid, false)
})

test('computer-use fixtures and schema are present and report renders readable artifacts', async () => {
  assert.equal(existsSync(SCENARIOS), true)
  assert.equal(existsSync(REPORT_SCHEMA), true)

  const scenarios = await readJson(SCENARIOS)
  const scenarioIds = new Set(scenarios.scenarios.map(scenario => scenario.id))
  assert.ok(scenarioIds.has('win32-native-controls'))
  assert.ok(scenarioIds.has('chrome-baidu-search'))
  assert.ok(scenarioIds.has('electron-spectrai-controls'))
  assert.ok(scenarioIds.has('macos-ax-demo'))
  assert.ok(scenarioIds.has('vision-hid-fallback-canvas'))

  const input = await readJson(SAMPLE_OBSERVATIONS)
  const report = buildCanonicalReport(input, { generatedAt: '2026-05-25T00:00:00.000Z' })
  const markdown = renderMarkdownReport(report)
  assert.match(markdown, /Required metrics/)
  assert.match(markdown, /vision-hid-fallback-canvas/)
  assert.match(markdown, /Provider availability/)

  const tempDir = await mkdtemp(resolve(tmpdir(), 'spectrai-claw-computer-use-'))
  const outputs = await writeReportArtifacts(report, {
    jsonOut: resolve(tempDir, 'report.json'),
    markdownOut: resolve(tempDir, 'report.md'),
  })

  assert.equal(existsSync(outputs.jsonOut), true)
  assert.equal(existsSync(outputs.markdownOut), true)

  const renderedJson = await readJson(outputs.jsonOut)
  assert.equal(renderedJson.summary.requiredMetrics.hidFallbackRate.rate, 0.0833)
})
