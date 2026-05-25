#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const DEFAULT_INPUT = resolve(__dirname, 'fixtures', 'sample-runtime-observations.json')
const DEFAULT_JSON_OUT = resolve(__dirname, 'reports', 'canonical-report.sample.json')
const DEFAULT_MARKDOWN_OUT = resolve(__dirname, 'reports', 'canonical-report.sample.md')

export const REQUIRED_METRIC_DEFINITIONS = {
  semanticActionSuccessRate: {
    numerator: 'semantic=true 且 actionSucceeded=true 的动作数',
    denominator: 'semantic=true 的动作尝试数',
    why: '证明主通道从截图编号点击转向 selector/控件树/DOM/AX/UIA 语义动作。',
  },
  backgroundActionSuccessRate: {
    numerator: 'background=true 且 actionSucceeded=true 的动作数',
    denominator: 'background=true 的动作尝试数',
    why: '衡量后台读取、invoke、input 是否真正可用，而不是必须抢前台。',
  },
  foregroundFallbackRate: {
    numerator: 'foregroundRequired=true 的动作数',
    denominator: '所有纳入统计的动作数',
    why: '衡量需要把目标 App 置前或依赖真实焦点的比例。',
  },
  visionFallbackRate: {
    numerator: 'visionFallbackUsed=true 的动作数',
    denominator: '所有纳入统计的动作数',
    why: '衡量视觉/OCR 仅作为补洞/兜底的比例。',
  },
  hidFallbackRate: {
    numerator: 'hidFallbackUsed=true 的动作数',
    denominator: '所有纳入统计的动作数',
    why: '衡量真实鼠标/键盘事件兜底比例，越低误点风险越低。',
  },
  postActionVerificationSuccessRate: {
    numerator: 'postActionVerificationRequired=true 且 postActionVerified=true 的动作数',
    denominator: 'postActionVerificationRequired=true 的动作数',
    why: '衡量动作后状态断言是否覆盖并成功，避免“发出动作即成功”的假阳性。',
  },
}

const OPTIONAL_METRIC_DEFINITIONS = {
  providerAvailabilityRate: 'available=true 的 provider/case 数 / 声明 provider/case 数。',
  semanticTreeCoverage: 'semanticElementCount / totalElementCount，按 eligible case 汇总。',
  selectorHitRate: 'selectorResolved=true 的动作数 / selectorAttempted=true 的动作数。',
  elementActionSuccessRate: 'actionSucceeded=true 的元素级动作数 / 有 actionSucceeded 结果的元素级动作数。',
  backgroundReadSuccessRate: 'operation=read 且 background=true 的成功率。',
  backgroundInvokeSuccessRate: 'operation=invoke 且 background=true 的成功率。',
  backgroundInputSuccessRate: 'operation=input 且 background=true 的成功率。',
  fallbackRate: 'foregroundRequired、visionFallbackUsed 或 hidFallbackUsed 任一为 true 的动作数 / 总动作数。',
  misClickIncidentRate: 'misClickIncident=true 的动作数 / 总动作数。',
  latency: '纳入统计动作的 latencyMs 平均值、p50、p95、最大值。',
  permissionBlockers: '阻止运行或降级 provider 的权限/环境条件清单。',
}

function usage() {
  return `Usage: node tests/computer-use/generate-canonical-report.mjs [--input file] [--out file] [--markdown-out file] [--strict]\n\nDefaults:\n  --input ${DEFAULT_INPUT}\n  --out ${DEFAULT_JSON_OUT}\n  --markdown-out ${DEFAULT_MARKDOWN_OUT}`
}

export function parseArgs(argv) {
  const options = {
    input: DEFAULT_INPUT,
    out: DEFAULT_JSON_OUT,
    markdownOut: DEFAULT_MARKDOWN_OUT,
    strict: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--input') {
      options.input = resolve(argv[++index])
    } else if (arg === '--out') {
      options.out = resolve(argv[++index])
    } else if (arg === '--markdown-out') {
      options.markdownOut = resolve(argv[++index])
    } else if (arg === '--strict') {
      options.strict = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`)
  }
}

function isEligibleCase(benchmarkCase) {
  return benchmarkCase.status !== 'skipped' && benchmarkCase.status !== 'unsupported'
}

function unique(values) {
  return Array.from(new Set(values.filter(value => value != null && value !== '')))
}

function bool(value) {
  return value === true
}

function safeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback
}

function rate(numerator, denominator) {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(4))
}

function metric(numerator, denominator) {
  return {
    numerator,
    denominator,
    rate: rate(numerator, denominator),
  }
}

function count(items, predicate) {
  return items.reduce((total, item) => total + (predicate(item) ? 1 : 0), 0)
}

function flattenActions(cases) {
  const actions = []
  for (const benchmarkCase of cases) {
    if (!isEligibleCase(benchmarkCase)) {
      continue
    }
    for (const action of benchmarkCase.actions ?? []) {
      if (action?.skipFromMetrics === true) {
        continue
      }
      actions.push({
        ...action,
        caseId: benchmarkCase.id,
        caseTitle: benchmarkCase.title,
        platform: benchmarkCase.platform,
        providerName: benchmarkCase.provider?.name ?? 'unknown',
      })
    }
  }
  return actions
}

function percentile(values, targetPercentile) {
  if (values.length === 0) {
    return null
  }
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * targetPercentile) - 1))
  return sorted[index]
}

function latencyStats(actions) {
  const values = actions
    .map(action => action.latencyMs)
    .filter(value => Number.isFinite(value) && value >= 0)

  if (values.length === 0) {
    return {
      count: 0,
      avgMs: null,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
    }
  }

  const sum = values.reduce((total, value) => total + value, 0)
  return {
    count: values.length,
    avgMs: Number((sum / values.length).toFixed(1)),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values),
  }
}

function caseCoverage(benchmarkCase) {
  const detection = benchmarkCase.detection ?? {}
  if (Number.isFinite(detection.semanticTreeCoverage)) {
    return Number(detection.semanticTreeCoverage.toFixed(4))
  }

  const total = safeNumber(detection.totalElementCount)
  const semantic = safeNumber(detection.semanticElementCount)
  return total === 0 ? null : Number((semantic / total).toFixed(4))
}

function computeCaseActionMetric(actions, predicate, successPredicate) {
  const attempts = actions.filter(predicate)
  return metric(count(attempts, successPredicate), attempts.length)
}

function summarizeCase(benchmarkCase) {
  const actions = benchmarkCase.actions ?? []
  const selectorMetric = computeCaseActionMetric(
    actions,
    action => bool(action.selectorAttempted),
    action => bool(action.selectorResolved),
  )
  const elementMetric = computeCaseActionMetric(
    actions,
    action => action.actionSucceeded != null,
    action => bool(action.actionSucceeded),
  )

  return {
    id: benchmarkCase.id,
    title: benchmarkCase.title,
    platform: benchmarkCase.platform,
    category: benchmarkCase.category,
    status: benchmarkCase.status,
    provider: benchmarkCase.provider ?? null,
    target: benchmarkCase.target ?? null,
    skipReason: benchmarkCase.skipReason ?? null,
    unsupportedReason: benchmarkCase.unsupportedReason ?? null,
    permissionBlockers: benchmarkCase.permissionBlockers ?? [],
    semanticTreeCoverage: caseCoverage(benchmarkCase),
    selectorHitRate: selectorMetric.rate,
    elementActionSuccessRate: elementMetric.rate,
    actionCount: actions.length,
    fallback: {
      foregroundRequired: actions.some(action => bool(action.foregroundRequired)),
      vision: actions.some(action => bool(action.visionFallbackUsed)),
      hid: actions.some(action => bool(action.hidFallbackUsed)),
    },
    background: {
      attempted: actions.some(action => bool(action.background)),
      read: actions.some(action => action.operation === 'read' && bool(action.background)),
      invoke: actions.some(action => action.operation === 'invoke' && bool(action.background)),
      input: actions.some(action => action.operation === 'input' && bool(action.background)),
    },
    latency: latencyStats(actions),
    notes: benchmarkCase.notes ?? [],
  }
}

function providerAvailability(cases) {
  const rows = []
  for (const benchmarkCase of cases) {
    const provider = benchmarkCase.provider ?? {}
    rows.push({
      caseId: benchmarkCase.id,
      platform: benchmarkCase.platform,
      provider: provider.name ?? 'unknown',
      mode: provider.mode ?? 'unknown',
      available: provider.available === true,
      reason: provider.available === true ? null : (provider.reason ?? benchmarkCase.unsupportedReason ?? benchmarkCase.skipReason ?? 'not reported'),
    })
  }

  return {
    rows,
    metric: metric(count(rows, row => row.available), rows.length),
  }
}

function operationMetric(actions, operation) {
  const attempts = actions.filter(action => action.operation === operation && bool(action.background))
  return metric(count(attempts, action => bool(action.actionSucceeded)), attempts.length)
}

function computeMetrics(cases) {
  const eligibleCases = cases.filter(isEligibleCase)
  const actions = flattenActions(cases)
  const semanticActions = actions.filter(action => bool(action.semantic))
  const backgroundActions = actions.filter(action => bool(action.background))
  const verificationActions = actions.filter(action => bool(action.postActionVerificationRequired))
  const selectorActions = actions.filter(action => bool(action.selectorAttempted))
  const elementActions = actions.filter(action => action.actionSucceeded != null)
  const fallbackActions = actions.filter(
    action => bool(action.foregroundRequired) || bool(action.visionFallbackUsed) || bool(action.hidFallbackUsed),
  )

  const totalElements = eligibleCases.reduce((sum, benchmarkCase) => sum + safeNumber(benchmarkCase.detection?.totalElementCount), 0)
  const semanticElements = eligibleCases.reduce((sum, benchmarkCase) => sum + safeNumber(benchmarkCase.detection?.semanticElementCount), 0)

  return {
    requiredMetrics: {
      semanticActionSuccessRate: metric(count(semanticActions, action => bool(action.actionSucceeded)), semanticActions.length),
      backgroundActionSuccessRate: metric(count(backgroundActions, action => bool(action.actionSucceeded)), backgroundActions.length),
      foregroundFallbackRate: metric(count(actions, action => bool(action.foregroundRequired)), actions.length),
      visionFallbackRate: metric(count(actions, action => bool(action.visionFallbackUsed)), actions.length),
      hidFallbackRate: metric(count(actions, action => bool(action.hidFallbackUsed)), actions.length),
      postActionVerificationSuccessRate: metric(
        count(verificationActions, action => bool(action.postActionVerified)),
        verificationActions.length,
      ),
    },
    optionalMetrics: {
      providerAvailabilityRate: providerAvailability(cases).metric,
      semanticTreeCoverage: metric(semanticElements, totalElements),
      selectorHitRate: metric(count(selectorActions, action => bool(action.selectorResolved)), selectorActions.length),
      elementActionSuccessRate: metric(count(elementActions, action => bool(action.actionSucceeded)), elementActions.length),
      backgroundReadSuccessRate: operationMetric(actions, 'read'),
      backgroundInvokeSuccessRate: operationMetric(actions, 'invoke'),
      backgroundInputSuccessRate: operationMetric(actions, 'input'),
      fallbackRate: metric(fallbackActions.length, actions.length),
      misClickIncidentRate: metric(count(actions, action => bool(action.misClickIncident)), actions.length),
      latency: latencyStats(actions),
      permissionBlockers: unique(cases.flatMap(benchmarkCase => benchmarkCase.permissionBlockers ?? [])),
    },
    providerAvailability: providerAvailability(cases),
  }
}

export function buildCanonicalReport(input, options = {}) {
  assertArray(input.cases, 'cases')

  const cases = input.cases.map(benchmarkCase => ({
    status: 'unsupported',
    actions: [],
    ...benchmarkCase,
  }))
  const metrics = computeMetrics(cases)

  return {
    schemaVersion: 'computer-use-benchmark-report/v1',
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    source: {
      fixtureSchemaVersion: input.schemaVersion ?? 'unknown',
      fixtureName: input.name ?? null,
      fixtureGeneratedAt: input.generatedAt ?? null,
      notes: input.notes ?? [],
    },
    environment: input.environment ?? {},
    metricDefinitions: {
      required: REQUIRED_METRIC_DEFINITIONS,
      optional: OPTIONAL_METRIC_DEFINITIONS,
    },
    summary: {
      caseCounts: {
        total: cases.length,
        eligible: cases.filter(isEligibleCase).length,
        passed: count(cases, benchmarkCase => benchmarkCase.status === 'passed'),
        failed: count(cases, benchmarkCase => benchmarkCase.status === 'failed'),
        skipped: count(cases, benchmarkCase => benchmarkCase.status === 'skipped'),
        unsupported: count(cases, benchmarkCase => benchmarkCase.status === 'unsupported'),
      },
      ...metrics,
    },
    cases: cases.map(summarizeCase),
    rawCaseIds: cases.map(benchmarkCase => benchmarkCase.id),
    regressionGates: input.regressionGates ?? [],
    risks: input.risks ?? [],
    nextRoundRecommendations: input.nextRoundRecommendations ?? [],
  }
}

function renderRate(value) {
  return value == null ? 'n/a' : `${(value * 100).toFixed(1)}%`
}

function renderMetricRow(name, value) {
  return `| ${name} | ${value.numerator}/${value.denominator} | ${renderRate(value.rate)} |`
}

function renderLatency(latency) {
  if (!latency || latency.count === 0) {
    return 'n/a'
  }
  return `avg ${latency.avgMs}ms / p50 ${latency.p50Ms}ms / p95 ${latency.p95Ms}ms / max ${latency.maxMs}ms`
}

export function renderMarkdownReport(report) {
  const required = report.summary.requiredMetrics
  const optional = report.summary.optionalMetrics
  const lines = []

  lines.push('# Computer Use Benchmark Canonical Report')
  lines.push('')
  lines.push(`- schemaVersion: ${report.schemaVersion}`)
  lines.push(`- generatedAt: ${report.generatedAt}`)
  lines.push(`- fixture: ${report.source.fixtureName ?? 'unknown'}`)
  lines.push(`- platform: ${report.environment.platform ?? 'unknown'}`)
  lines.push(`- node: ${report.environment.nodeVersion ?? 'unknown'}`)
  lines.push('')

  lines.push('## Case counts')
  lines.push('')
  lines.push('| total | eligible | passed | failed | skipped | unsupported |')
  lines.push('|---:|---:|---:|---:|---:|---:|')
  const counts = report.summary.caseCounts
  lines.push(`| ${counts.total} | ${counts.eligible} | ${counts.passed} | ${counts.failed} | ${counts.skipped} | ${counts.unsupported} |`)
  lines.push('')

  lines.push('## Required metrics')
  lines.push('')
  lines.push('| metric | numerator/denominator | rate |')
  lines.push('|---|---:|---:|')
  for (const [name, value] of Object.entries(required)) {
    lines.push(renderMetricRow(name, value))
  }
  lines.push('')

  lines.push('## Additional capability metrics')
  lines.push('')
  lines.push('| metric | numerator/denominator | rate |')
  lines.push('|---|---:|---:|')
  for (const [name, value] of Object.entries(optional)) {
    if (name === 'latency' || name === 'permissionBlockers') {
      continue
    }
    lines.push(renderMetricRow(name, value))
  }
  lines.push(`\n- latency: ${renderLatency(optional.latency)}`)
  lines.push(`- permissionBlockers: ${optional.permissionBlockers.length > 0 ? optional.permissionBlockers.join('; ') : 'none'}`)
  lines.push('')

  lines.push('## Case matrix')
  lines.push('')
  lines.push('| id | platform | status | provider | mode | background | foreground fallback | vision fallback | HID fallback | semantic coverage | selector hit | action success | latency |')
  lines.push('|---|---|---|---|---|---|---|---|---|---:|---:|---:|---|')
  for (const benchmarkCase of report.cases) {
    lines.push([
      `| ${benchmarkCase.id}`,
      benchmarkCase.platform,
      benchmarkCase.status,
      benchmarkCase.provider?.name ?? 'unknown',
      benchmarkCase.provider?.mode ?? 'unknown',
      benchmarkCase.background.attempted ? 'yes' : 'no',
      benchmarkCase.fallback.foregroundRequired ? 'yes' : 'no',
      benchmarkCase.fallback.vision ? 'yes' : 'no',
      benchmarkCase.fallback.hid ? 'yes' : 'no',
      renderRate(benchmarkCase.semanticTreeCoverage),
      renderRate(benchmarkCase.selectorHitRate),
      renderRate(benchmarkCase.elementActionSuccessRate),
      `${renderLatency(benchmarkCase.latency)} |`,
    ].join(' | '))
  }
  lines.push('')

  lines.push('## Provider availability')
  lines.push('')
  lines.push('| case | platform | provider | mode | available | reason |')
  lines.push('|---|---|---|---|---|---|')
  for (const row of report.summary.providerAvailability.rows) {
    lines.push(`| ${row.caseId} | ${row.platform} | ${row.provider} | ${row.mode} | ${row.available ? 'yes' : 'no'} | ${row.reason ?? ''} |`)
  }
  lines.push('')

  lines.push('## Regression gates')
  lines.push('')
  if (report.regressionGates.length === 0) {
    lines.push('- No gates declared by fixture.')
  } else {
    for (const gate of report.regressionGates) {
      lines.push(`- ${gate.metric}: ${gate.operator} ${gate.threshold} (${gate.scope})`)
    }
  }
  lines.push('')

  lines.push('## Risks')
  lines.push('')
  if (report.risks.length === 0) {
    lines.push('- none')
  } else {
    for (const risk of report.risks) {
      lines.push(`- ${risk}`)
    }
  }
  lines.push('')

  lines.push('## Next round recommendations')
  lines.push('')
  if (report.nextRoundRecommendations.length === 0) {
    lines.push('- none')
  } else {
    for (const recommendation of report.nextRoundRecommendations) {
      lines.push(`- ${recommendation}`)
    }
  }
  lines.push('')

  return `${lines.join('\n')}\n`
}

export async function writeReportArtifacts(report, options = {}) {
  const jsonOut = options.jsonOut ?? DEFAULT_JSON_OUT
  const markdownOut = options.markdownOut ?? DEFAULT_MARKDOWN_OUT

  await mkdir(dirname(jsonOut), { recursive: true })
  await mkdir(dirname(markdownOut), { recursive: true })
  await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(markdownOut, renderMarkdownReport(report), 'utf8')

  return { jsonOut, markdownOut }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }

  const input = JSON.parse(await readFile(options.input, 'utf8'))
  const report = buildCanonicalReport(input)
  const outputs = await writeReportArtifacts(report, {
    jsonOut: options.out,
    markdownOut: options.markdownOut,
  })

  console.log(`Computer Use canonical report written:\n- ${outputs.jsonOut}\n- ${outputs.markdownOut}`)

  if (options.strict && report.summary.caseCounts.failed > 0) {
    throw new Error(`Strict benchmark failed: ${report.summary.caseCounts.failed} case(s) failed`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error(err.stack || err.message)
    process.exitCode = 1
  })
}
