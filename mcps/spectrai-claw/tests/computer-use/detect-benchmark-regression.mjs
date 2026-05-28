#!/usr/bin/env node
/**
 * detect-benchmark-regression.mjs
 *
 * Compares current benchmark metrics against a baseline JSON file.
 * Exits non-zero if any required metric drops below (baseline - threshold).
 *
 * Usage:
 *   node tests/computer-use/detect-benchmark-regression.mjs \
 *     --current <metrics.json> \
 *     --baseline <baseline.json> \
 *     [--threshold 0.05]
 *
 * The threshold is the maximum allowed drop as a fraction (default: 0.05 = 5%).
 * A metric that drops MORE than <threshold> below the baseline triggers failure.
 *
 * Metric fields compared (must be rate metrics: { rate: number | null }):
 *   elementLocatingAccuracy, postActionVerificationSuccessRate,
 *   semanticActionSuccessRate, backgroundActionSuccessRate,
 *   foregroundFallbackRate, visionFallbackRate, hidFallbackRate, fallbackRate
 *
 * For "lower is better" metrics (fallback rates), the comparison is inverted:
 * regression is flagged when the current rate EXCEEDS baseline + threshold.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const HIGHER_IS_BETTER = [
  'elementLocatingAccuracy',
  'postActionVerificationSuccessRate',
  'semanticActionSuccessRate',
  'backgroundActionSuccessRate',
]

const LOWER_IS_BETTER = [
  'foregroundFallbackRate',
  'visionFallbackRate',
  'hidFallbackRate',
  'fallbackRate',
]

const ALL_METRICS = [...HIGHER_IS_BETTER, ...LOWER_IS_BETTER]

function parseArgs(argv) {
  const opts = { current: null, baseline: null, threshold: 0.05 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--current' && argv[i + 1]) opts.current = resolve(argv[++i])
    else if (argv[i] === '--baseline' && argv[i + 1]) opts.baseline = resolve(argv[++i])
    else if (argv[i] === '--threshold' && argv[i + 1]) opts.threshold = parseFloat(argv[++i])
  }
  return opts
}

function extractRate(metrics, name) {
  const field = metrics[name]
  if (field == null) return null
  // Support both flat number and {rate: number} objects
  if (typeof field === 'number') return field
  if (typeof field === 'object' && 'rate' in field) {
    return typeof field.rate === 'number' ? field.rate : null
  }
  return null
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  if (!opts.current || !opts.baseline) {
    console.error('Usage: detect-benchmark-regression.mjs --current <path> --baseline <path> [--threshold 0.05]')
    process.exitCode = 2
    return
  }

  let currentData, baselineData
  try {
    currentData = JSON.parse(await readFile(opts.current, 'utf8'))
    baselineData = JSON.parse(await readFile(opts.baseline, 'utf8'))
  } catch (err) {
    console.error(`Failed to read benchmark files: ${err.message}`)
    process.exitCode = 2
    return
  }

  const currentMetrics = currentData.metrics ?? currentData
  const baselineMetrics = baselineData.metrics ?? baselineData

  const regressions = []
  const comparisons = []

  for (const metric of ALL_METRICS) {
    const current = extractRate(currentMetrics, metric)
    const baseline = extractRate(baselineMetrics, metric)

    if (current == null || baseline == null) {
      comparisons.push({ metric, current, baseline, status: 'skipped', reason: 'null rate' })
      continue
    }

    const isHigherBetter = HIGHER_IS_BETTER.includes(metric)

    let regressed = false
    let drop = 0
    if (isHigherBetter) {
      drop = baseline - current
      regressed = drop > opts.threshold
    } else {
      drop = current - baseline
      regressed = drop > opts.threshold
    }

    const status = regressed ? 'REGRESSION' : 'ok'
    comparisons.push({ metric, current, baseline, drop: Number(drop.toFixed(4)), status, higherIsBetter: isHigherBetter })

    if (regressed) regressions.push({ metric, current, baseline, drop, threshold: opts.threshold })
  }

  const allOk = regressions.length === 0

  const output = {
    ok: allOk,
    threshold: opts.threshold,
    regressionCount: regressions.length,
    comparisons,
    regressions,
    currentFile: opts.current,
    baselineFile: opts.baseline,
    checkedAt: new Date().toISOString(),
  }

  console.log(JSON.stringify(output, null, 2))

  if (!allOk) {
    console.error(`\n[detect-benchmark-regression] FAILED: ${regressions.length} metric(s) regressed beyond threshold ${opts.threshold}:`)
    for (const r of regressions) {
      const dir = HIGHER_IS_BETTER.includes(r.metric) ? 'dropped' : 'rose'
      console.error(`  ${r.metric}: baseline=${r.baseline} current=${r.current} (${dir} by ${r.drop.toFixed(4)}, threshold=${opts.threshold})`)
    }
    process.exitCode = 1
  } else {
    console.error(`[detect-benchmark-regression] All metrics within acceptable range (threshold=${opts.threshold}).`)
  }
}

main().catch(err => {
  console.error(err.stack || err.message)
  process.exitCode = 1
})
