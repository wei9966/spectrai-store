#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const REQUIRED_SCENARIOS = [
  'win-notepad-uia-type',
  'win-calculator-uia-invoke',
  'browser-baidu-dom-search',
  'electron-spectrai-uia-command',
  'macos-ax-demo-button',
  'fallback-canvas-vision-ocr-hid',
]

const REQUIRED_METRICS = [
  'semanticActionSuccessRate',
  'backgroundActionSuccessRate',
  'backgroundReadCoverageRate',
  'backgroundInvokeCoverageRate',
  'backgroundTypeCoverageRate',
  'foregroundFallbackRate',
  'visionFallbackRate',
  'hidFallbackRate',
  'postActionVerificationSuccessRate',
  'averageVerificationConfidence',
  'wrongClickRiskWeightedScore',
  'fallbackTraceabilityRate',
]

const CAPABILITY_FIELDS = [
  'backgroundRead',
  'backgroundInvoke',
  'backgroundType',
  'requiresForeground',
  'visionFallbackNeeded',
  'hidFallbackNeeded',
]

const REQUIRED_PROVIDER_LINES = [
  'core-runtime',
  'windows-provider',
  'macos-provider',
  'browser-provider',
  'fallback-layer',
]

const REQUIRED_POST_MERGE_LINES = [
  ...REQUIRED_PROVIDER_LINES,
  'benchmark-package',
]

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(__dirname, relativePath), 'utf8'))
}

function round4(value) {
  return Math.round(value * 10000) / 10000
}

function rate(numerator, denominator) {
  return denominator === 0 ? 0 : round4(numerator / denominator)
}

function approxEqual(a, b) {
  return Math.abs(a - b) <= 0.0001
}

function requireObject(value, label) {
  assert.equal(typeof value, 'object', `${label} must be an object`)
  assert.notEqual(value, null, `${label} must not be null`)
}

function validateScenarios(scenariosDoc) {
  assert.equal(scenariosDoc.schemaVersion, 'computer-use-benchmark.scenarios.v0')
  assert.ok(Array.isArray(scenariosDoc.scenarios), 'scenarios must be an array')
  assert.equal(scenariosDoc.scenarios.length, REQUIRED_SCENARIOS.length, 'scenario count mismatch')

  const ids = new Set(scenariosDoc.scenarios.map((scenario) => scenario.id))
  for (const id of REQUIRED_SCENARIOS) {
    assert.ok(ids.has(id), `missing scenario ${id}`)
  }

  for (const scenario of scenariosDoc.scenarios) {
    requireObject(scenario.selector, `scenario ${scenario.id}.selector`)
    requireObject(scenario.action, `scenario ${scenario.id}.action`)
    requireObject(scenario.verification, `scenario ${scenario.id}.verification`)
    requireObject(scenario.capabilityExpectation, `scenario ${scenario.id}.capabilityExpectation`)
    for (const field of CAPABILITY_FIELDS) {
      assert.equal(typeof scenario.capabilityExpectation[field], 'boolean', `scenario ${scenario.id} capability ${field} must be boolean`)
    }
    assert.ok(['low', 'medium', 'high-until-verified'].includes(scenario.riskWeight), `scenario ${scenario.id} riskWeight invalid`)
    assert.ok(Array.isArray(scenario.evidenceRequired), `scenario ${scenario.id} evidenceRequired must be an array`)
  }
}

function validateReport(report, scenarioIds) {
  assert.equal(report.schemaVersion, 'computer-use-benchmark.report.v0')
  requireObject(report.run, 'report.run')
  requireObject(report.metrics, 'report.metrics')
  assert.ok(Array.isArray(report.cases), 'report.cases must be an array')
  assert.equal(report.cases.length, scenarioIds.size, 'case count must match scenario count')

  for (const metric of REQUIRED_METRICS) {
    assert.equal(typeof report.metrics[metric], 'number', `metric ${metric} must be numeric`)
    assert.ok(report.metrics[metric] >= 0, `metric ${metric} must be non-negative`)
  }

  const caseIds = new Set(report.cases.map((testCase) => testCase.scenario))
  for (const scenarioId of scenarioIds) {
    assert.ok(caseIds.has(scenarioId), `report missing case ${scenarioId}`)
  }

  for (const testCase of report.cases) {
    assert.ok(scenarioIds.has(testCase.scenario), `unknown report case ${testCase.scenario}`)
    assert.equal(typeof testCase.provider, 'string', `${testCase.scenario} provider must be string`)
    assert.equal(typeof testCase.providerLine, 'string', `${testCase.scenario} providerLine must be string`)
    requireObject(testCase.selector, `${testCase.scenario}.selector`)
    requireObject(testCase.action, `${testCase.scenario}.action`)
    requireObject(testCase.capability, `${testCase.scenario}.capability`)
    requireObject(testCase.beforeVerification, `${testCase.scenario}.beforeVerification`)
    requireObject(testCase.afterVerification, `${testCase.scenario}.afterVerification`)
    assert.equal(typeof testCase.action.semantic, 'boolean', `${testCase.scenario} action.semantic must be boolean`)
    assert.equal(typeof testCase.action.background, 'boolean', `${testCase.scenario} action.background must be boolean`)
    for (const field of CAPABILITY_FIELDS) {
      assert.equal(typeof testCase.capability[field], 'boolean', `${testCase.scenario} capability ${field} must be boolean`)
    }
    assert.equal(typeof testCase.beforeVerification.confidence, 'number', `${testCase.scenario} before confidence must be numeric`)
    assert.equal(typeof testCase.afterVerification.success, 'boolean', `${testCase.scenario} after success must be boolean`)
    assert.equal(typeof testCase.afterVerification.confidence, 'number', `${testCase.scenario} after confidence must be numeric`)
    assert.ok(Array.isArray(testCase.fallbackUsed), `${testCase.scenario} fallbackUsed must be an array`)
    assert.ok(Array.isArray(testCase.riskFlags), `${testCase.scenario} riskFlags must be an array`)
    assert.equal(typeof testCase.pass, 'boolean', `${testCase.scenario} pass must be boolean`)
    assert.equal(typeof testCase.reason, 'string', `${testCase.scenario} reason must be string`)

    if (testCase.pass) {
      assert.ok(testCase.afterVerification.success, `${testCase.scenario} cannot pass without afterVerification.success`)
    } else {
      const skipped = testCase.afterVerification.skipped || testCase.riskFlags.includes('environmentUnsupported') || testCase.status?.includes('blocked')
      assert.ok(skipped, `${testCase.scenario} failed case must be explicit skipped/blocked evidence`)
    }

    for (const fallback of testCase.fallbackUsed) {
      assert.equal(typeof fallback.type, 'string', `${testCase.scenario} fallback type required`)
      assert.equal(typeof fallback.reason, 'string', `${testCase.scenario} fallback reason required`)
      assert.equal(typeof fallback.traceId, 'string', `${testCase.scenario} fallback traceId required`)
    }
  }
}

function riskScoreForCase(testCase) {
  if (testCase.riskFlags.includes('environmentUnsupported')) return 0.2
  if (testCase.riskFlags.includes('highUntilVerified') || testCase.riskFlags.includes('hidFinalFallback')) return 0.8
  if (testCase.capability.requiresForeground || testCase.capability.visionFallbackNeeded) return 0.5
  return 0.1
}

function deriveMetrics(report) {
  const cases = report.cases
  const semanticCases = cases.filter((testCase) => testCase.action.semantic)
  const backgroundActionCases = cases.filter(
    (testCase) => testCase.action.background || testCase.capability.backgroundInvoke || testCase.capability.backgroundType,
  )
  const fallbackCases = cases.filter((testCase) => testCase.fallbackUsed.length > 0)
  const traceableFallbackCases = fallbackCases.filter((testCase) =>
    testCase.fallbackUsed.every((entry) => entry.type && entry.reason && entry.traceId),
  )

  return {
    semanticActionSuccessRate: rate(semanticCases.filter((testCase) => testCase.pass && testCase.afterVerification.success).length, semanticCases.length),
    backgroundActionSuccessRate: rate(backgroundActionCases.filter((testCase) => testCase.pass && testCase.afterVerification.success).length, backgroundActionCases.length),
    backgroundReadCoverageRate: rate(cases.filter((testCase) => testCase.capability.backgroundRead).length, cases.length),
    backgroundInvokeCoverageRate: rate(cases.filter((testCase) => testCase.capability.backgroundInvoke).length, cases.length),
    backgroundTypeCoverageRate: rate(cases.filter((testCase) => testCase.capability.backgroundType).length, cases.length),
    foregroundFallbackRate: rate(cases.filter((testCase) => testCase.capability.requiresForeground).length, cases.length),
    visionFallbackRate: rate(cases.filter((testCase) => testCase.capability.visionFallbackNeeded).length, cases.length),
    hidFallbackRate: rate(cases.filter((testCase) => testCase.capability.hidFallbackNeeded).length, cases.length),
    postActionVerificationSuccessRate: rate(cases.filter((testCase) => testCase.afterVerification.success).length, cases.length),
    averageVerificationConfidence: round4(cases.reduce((sum, testCase) => sum + testCase.afterVerification.confidence, 0) / cases.length),
    wrongClickRiskWeightedScore: round4(cases.reduce((sum, testCase) => sum + riskScoreForCase(testCase), 0) / cases.length),
    fallbackTraceabilityRate: rate(traceableFallbackCases.length, fallbackCases.length),
  }
}

function validateDerivedMetrics(report, derivedMetrics) {
  for (const metric of REQUIRED_METRICS) {
    assert.ok(
      approxEqual(report.metrics[metric], derivedMetrics[metric]),
      `metric ${metric} mismatch: report=${report.metrics[metric]} derived=${derivedMetrics[metric]}`,
    )
  }
}

function validateThreshold(threshold, label) {
  requireObject(threshold, label)
  assert.equal(typeof threshold.rule, 'string', `${label}.rule must be string`)
  const numericKeys = Object.keys(threshold).filter((key) => key !== 'rule')
  assert.ok(numericKeys.length > 0, `${label} must contain at least one numeric threshold`)
  for (const key of numericKeys) {
    assert.equal(typeof threshold[key], 'number', `${label}.${key} must be numeric`)
  }
}

function validateAcceptance(acceptance) {
  assert.equal(acceptance.schemaVersion, 'computer-use-benchmark.provider-acceptance.v0')
  requireObject(acceptance.riskThresholds, 'acceptance.riskThresholds')
  for (const metric of REQUIRED_METRICS) {
    assert.ok(metric in acceptance.riskThresholds, `acceptance missing threshold for ${metric}`)
    validateThreshold(acceptance.riskThresholds[metric], `acceptance.riskThresholds.${metric}`)
  }

  assert.ok(Array.isArray(acceptance.providerMatrix), 'providerMatrix must be an array')
  const providerIds = new Set(acceptance.providerMatrix.map((provider) => provider.id))
  for (const providerId of REQUIRED_PROVIDER_LINES) {
    assert.ok(providerIds.has(providerId), `missing provider acceptance line ${providerId}`)
  }

  for (const provider of acceptance.providerMatrix) {
    assert.ok(Array.isArray(provider.canonicalScenarios), `${provider.id} canonicalScenarios must be array`)
    assert.ok(Array.isArray(provider.blockingFailures), `${provider.id} blockingFailures must be array`)
    requireObject(provider.capabilityFields, `${provider.id}.capabilityFields`)
    requireObject(provider.selectorFields, `${provider.id}.selectorFields`)
    requireObject(provider.actionVerification, `${provider.id}.actionVerification`)
    requireObject(provider.fallbackTraceability, `${provider.id}.fallbackTraceability`)
  }

  assert.ok(Array.isArray(acceptance.postMergeRetestSequence), 'postMergeRetestSequence must be an array')
  assert.ok(acceptance.postMergeRetestSequence.length >= 4, 'postMergeRetestSequence must include provider live checks')
  const orders = acceptance.postMergeRetestSequence.map((step) => step.order)
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b), 'postMergeRetestSequence must be ordered')
}

function evaluateFixtureThresholds(metrics, thresholds) {
  const results = {}
  for (const metric of REQUIRED_METRICS) {
    const threshold = thresholds[metric]
    if ('minFixture' in threshold) {
      results[metric] = metrics[metric] >= threshold.minFixture
    } else if ('maxFixture' in threshold) {
      results[metric] = metrics[metric] <= threshold.maxFixture
    } else {
      results[metric] = true
    }
    assert.ok(results[metric], `${metric} violates fixture threshold`)
  }
  return results
}

function validatePostMergeReport(postMergeReport) {
  assert.equal(postMergeReport.schemaVersion, 'computer-use-benchmark.post-merge-acceptance.v0')
  requireObject(postMergeReport.summary, 'postMergeReport.summary')
  assert.ok(Array.isArray(postMergeReport.providerAcceptanceMatrix), 'providerAcceptanceMatrix must be an array')
  const providerLines = new Set(postMergeReport.providerAcceptanceMatrix.map((row) => row.providerLine))
  for (const providerLine of REQUIRED_POST_MERGE_LINES) {
    assert.ok(providerLines.has(providerLine), `post-merge report missing ${providerLine}`)
  }
  for (const row of postMergeReport.providerAcceptanceMatrix) {
    assert.equal(typeof row.status, 'string', `${row.providerLine}.status must be string`)
    requireObject(row.baselineEvidence, `${row.providerLine}.baselineEvidence`)
    requireObject(row.currentRoundEvidence, `${row.providerLine}.currentRoundEvidence`)
    assert.ok(Array.isArray(row.remainingRisk), `${row.providerLine}.remainingRisk must be array`)
  }
  assert.ok(Array.isArray(postMergeReport.commandsAndLogs), 'commandsAndLogs must be array')
  assert.ok(postMergeReport.commandsAndLogs.length >= 2, 'commandsAndLogs must include local benchmark commands')
  assert.ok(Array.isArray(postMergeReport.remainingRisks), 'remainingRisks must be array')
}

const scenariosDoc = readJson('scenarios/canonical-scenarios.json')
const report = readJson('reports/canonical-report.sample.json')
const acceptance = readJson('reports/provider-integration-acceptance.json')
const postMergeReport = readJson('reports/post-merge-acceptance-report.json')

validateScenarios(scenariosDoc)
const scenarioIds = new Set(scenariosDoc.scenarios.map((scenario) => scenario.id))
validateReport(report, scenarioIds)
const derivedMetrics = deriveMetrics(report)
validateDerivedMetrics(report, derivedMetrics)
validateAcceptance(acceptance)
const thresholdResults = evaluateFixtureThresholds(derivedMetrics, acceptance.riskThresholds)
validatePostMergeReport(postMergeReport)

const output = {
  ok: true,
  mode: report.run.mode,
  scenarioCount: scenariosDoc.scenarios.length,
  caseCount: report.cases.length,
  providerAcceptanceCount: acceptance.providerMatrix.length,
  postMergeProviderLineCount: postMergeReport.providerAcceptanceMatrix.length,
  metrics: derivedMetrics,
  thresholdResults,
}

console.log(JSON.stringify(output, null, 2))
