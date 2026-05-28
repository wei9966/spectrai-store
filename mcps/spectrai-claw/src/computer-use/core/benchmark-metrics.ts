/**
 * Benchmark metrics calculation from execution traces.
 *
 * Primary metrics align with generate-canonical-report.mjs REQUIRED_METRIC_DEFINITIONS:
 *   semanticActionSuccessRate, backgroundActionSuccessRate, foregroundFallbackRate,
 *   visionFallbackRate, hidFallbackRate, postActionVerificationSuccessRate
 *
 * Additional trace-derived metrics:
 *   elementLocatingAccuracy, fallbackRate, selectorHitRate, avgDurationMs
 *
 * Note: "semantic" means the action used a structured selector (non-HID).
 * "background" is approximated as non-foreground-required + action succeeded.
 */

import type { ExecutionTrace } from './trace.js'
import type { TraceAnalyzer } from './trace-storage.js'

export interface RateMetric {
  numerator: number
  denominator: number
  rate: number | null
}

function makeRate(numerator: number, denominator: number): RateMetric {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? null : Number((numerator / denominator).toFixed(4)),
  }
}

export interface BenchmarkMetrics {
  /** Rate at which element find succeeded (post-find selectorResolved=true) */
  elementLocatingAccuracy: RateMetric

  /**
   * postActionVerificationSuccessRate — aligns with REQUIRED_METRIC_DEFINITIONS.
   * Rate at which post-action verify steps passed.
   */
  postActionVerificationSuccessRate: RateMetric

  /**
   * Fraction of dispatch steps that used a fallback provider/method.
   */
  fallbackRate: RateMetric

  /**
   * Fraction of dispatch steps where foreground was required.
   * Aligns with foregroundFallbackRate in REQUIRED_METRIC_DEFINITIONS.
   */
  foregroundFallbackRate: RateMetric

  /**
   * Fraction of actions where vision/OCR fallback was used.
   * Aligns with visionFallbackRate in REQUIRED_METRIC_DEFINITIONS.
   */
  visionFallbackRate: RateMetric

  /**
   * Fraction of actions where HID fallback was used.
   * Aligns with hidFallbackRate in REQUIRED_METRIC_DEFINITIONS.
   */
  hidFallbackRate: RateMetric

  /**
   * Dispatch success rate for non-foreground-required steps (proxy for semantic/background).
   * Aligns with semanticActionSuccessRate / backgroundActionSuccessRate in REQUIRED_METRIC_DEFINITIONS.
   */
  semanticActionSuccessRate: RateMetric

  /**
   * Alias: backgroundActionSuccessRate (same denominator as semanticActionSuccessRate for trace-derived data).
   */
  backgroundActionSuccessRate: RateMetric

  /**
   * Selector resolution rate (post-find selectorResolved / selectorAttempted).
   */
  selectorHitRate: RateMetric

  /** Average action dispatch duration in ms, or null if no timing data. */
  avgDurationMs: number | null

  /** Total traces analysed. */
  traceCount: number

  /** Timestamp of calculation. */
  calculatedAt: string
}

/**
 * Calculates benchmark metrics from a single ExecutionTrace.
 * All errors are caught internally; returns a zero/null baseline on failure.
 */
export function calculateBenchmarkMetrics(trace: ExecutionTrace): BenchmarkMetrics {
  return calculateBenchmarkMetricsFromTraces([trace])
}

/**
 * Calculates benchmark metrics across multiple ExecutionTraces.
 */
export function calculateBenchmarkMetricsFromTraces(traces: ExecutionTrace[]): BenchmarkMetrics {
  try {
    const allSteps = traces.flatMap(t => t.steps)

    const findSteps = allSteps.filter(s => s.phase === 'post-find')
    const dispatchSteps = allSteps.filter(s => s.phase === 'post-dispatch')
    const verifySteps = allSteps.filter(s => s.phase === 'post-verify')

    // elementLocatingAccuracy: selectorResolved / selectorAttempted
    const selectorAttempted = findSteps.filter(s => s.selectorAttempted !== false)
    const selectorResolved = selectorAttempted.filter(s => s.selectorResolved === true || s.elementFound === true)
    const elementLocatingAccuracy = makeRate(selectorResolved.length, selectorAttempted.length)

    // selectorHitRate: same as element locating accuracy (post-find)
    const selectorHitRate = elementLocatingAccuracy

    // postActionVerificationSuccessRate
    const verifyPassed = verifySteps.filter(s => s.verificationOk === true)
    const postActionVerificationSuccessRate = makeRate(verifyPassed.length, verifySteps.length)

    // fallbackRate
    const fallbackSteps = dispatchSteps.filter(s => s.usedFallback === true)
    const fallbackRate = makeRate(fallbackSteps.length, dispatchSteps.length)

    // foregroundFallbackRate
    const foregroundSteps = dispatchSteps.filter(s => s.foregroundRequired === true)
    const foregroundFallbackRate = makeRate(foregroundSteps.length, dispatchSteps.length)

    // visionFallbackRate: provider kind 'vision-ocr'
    const visionSteps = dispatchSteps.filter(s =>
      s.provider?.kind === 'vision-ocr' || s.usedFallback === true && s.provider?.kind === 'vision-ocr',
    )
    const visionFallbackRate = makeRate(visionSteps.length, dispatchSteps.length)

    // hidFallbackRate: provider kind 'hid'
    const hidSteps = dispatchSteps.filter(s => s.provider?.kind === 'hid')
    const hidFallbackRate = makeRate(hidSteps.length, dispatchSteps.length)

    // semanticActionSuccessRate: non-foreground dispatch steps that succeeded
    const semanticSteps = dispatchSteps.filter(s => s.foregroundRequired !== true)
    const semanticSuccess = semanticSteps.filter(s => s.actionOk === true)
    const semanticActionSuccessRate = makeRate(semanticSuccess.length, semanticSteps.length)

    // backgroundActionSuccessRate: same bucket for trace-derived data
    const backgroundActionSuccessRate = semanticActionSuccessRate

    // avgDurationMs from post-dispatch steps
    const dispatchDurations = dispatchSteps
      .map(s => s.durationMs)
      .filter((d): d is number => d != null && d >= 0)
    const avgDurationMs = dispatchDurations.length > 0
      ? dispatchDurations.reduce((a, b) => a + b, 0) / dispatchDurations.length
      : null

    return {
      elementLocatingAccuracy,
      postActionVerificationSuccessRate,
      fallbackRate,
      foregroundFallbackRate,
      visionFallbackRate,
      hidFallbackRate,
      semanticActionSuccessRate,
      backgroundActionSuccessRate,
      selectorHitRate,
      avgDurationMs,
      traceCount: traces.length,
      calculatedAt: new Date().toISOString(),
    }
  } catch {
    const zero = makeRate(0, 0)
    return {
      elementLocatingAccuracy: zero,
      postActionVerificationSuccessRate: zero,
      fallbackRate: zero,
      foregroundFallbackRate: zero,
      visionFallbackRate: zero,
      hidFallbackRate: zero,
      semanticActionSuccessRate: zero,
      backgroundActionSuccessRate: zero,
      selectorHitRate: zero,
      avgDurationMs: null,
      traceCount: traces.length,
      calculatedAt: new Date().toISOString(),
    }
  }
}

/**
 * Convenience: compute metrics from a TraceAnalyzer instance.
 */
export function metricsFromAnalyzer(analyzer: TraceAnalyzer): BenchmarkMetrics {
  return calculateBenchmarkMetricsFromTraces(
    // TraceAnalyzer exposes allSteps, but we need full traces.
    // Re-expose via a synthetic single trace that aggregates all steps.
    [{
      traceId: 'aggregate',
      startedAt: 0,
      steps: analyzer.allSteps,
      finalOk: analyzer.successCount > 0,
    }],
  )
}
