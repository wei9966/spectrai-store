/**
 * Persistent storage for execution traces.
 * Writes traces to .spectrai-traces/<date>/trace-<uuid>.json
 * Screenshots go in .spectrai-traces/<date>/screenshots/
 */

import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import type { ExecutionTrace, TraceStep } from './trace.js'

export interface TraceStorageOptions {
  baseDir?: string
  /** Max age in days for traces (0 = no cleanup). Default: 0 */
  retentionDays?: number
}

function dateTag(): string {
  return new Date().toISOString().slice(0, 10) // YYYY-MM-DD
}

function traceDir(baseDir: string): string {
  return join(baseDir, dateTag())
}

function screenshotDir(baseDir: string): string {
  return join(traceDir(baseDir), 'screenshots')
}

/**
 * Writes a single ExecutionTrace to disk as JSON.
 * Returns the file path written, or null on failure.
 * Failures are swallowed — storage errors must not affect main flow.
 */
export async function writeTrace(
  trace: ExecutionTrace,
  options: TraceStorageOptions = {},
): Promise<string | null> {
  try {
    const baseDir = options.baseDir ?? resolve('.spectrai-traces')
    const dir = traceDir(baseDir)
    await mkdir(dir, { recursive: true })
    await mkdir(screenshotDir(baseDir), { recursive: true })

    const filePath = join(dir, `trace-${trace.traceId}.json`)
    await writeFile(filePath, JSON.stringify(trace, null, 2), 'utf8')
    return filePath
  } catch {
    return null
  }
}

/**
 * Loads a trace from disk by its file path.
 */
export async function loadTrace(filePath: string): Promise<ExecutionTrace | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as ExecutionTrace
  } catch {
    return null
  }
}

/**
 * Lists all trace file paths under the given base directory.
 */
export async function listTraceFiles(baseDir?: string): Promise<string[]> {
  try {
    const base = baseDir ?? resolve('.spectrai-traces')
    if (!existsSync(base)) return []
    const dates = await readdir(base)
    const paths: string[] = []
    for (const date of dates) {
      const dateDir = join(base, date)
      try {
        const files = await readdir(dateDir)
        for (const file of files) {
          if (file.startsWith('trace-') && file.endsWith('.json')) {
            paths.push(join(dateDir, file))
          }
        }
      } catch {
        // skip unreadable date dirs
      }
    }
    return paths
  } catch {
    return []
  }
}

/**
 * Loads all traces from the given base directory.
 */
export async function loadAllTraces(baseDir?: string): Promise<ExecutionTrace[]> {
  const files = await listTraceFiles(baseDir)
  const traces: ExecutionTrace[] = []
  for (const file of files) {
    const trace = await loadTrace(file)
    if (trace) traces.push(trace)
  }
  return traces
}

/**
 * TraceLoader: loads traces from a directory, filters by date range.
 */
export class TraceLoader {
  constructor(private readonly baseDir?: string) {}

  async load(): Promise<ExecutionTrace[]> {
    return loadAllTraces(this.baseDir)
  }

  async loadById(traceId: string): Promise<ExecutionTrace | null> {
    const files = await listTraceFiles(this.baseDir)
    for (const file of files) {
      if (file.includes(`trace-${traceId}`)) {
        return loadTrace(file)
      }
    }
    return null
  }
}

/**
 * TraceAnalyzer: aggregates multiple traces into summary statistics.
 */
export class TraceAnalyzer {
  constructor(private readonly traces: ExecutionTrace[]) {}

  get count(): number {
    return this.traces.length
  }

  get successCount(): number {
    return this.traces.filter(t => t.finalOk).length
  }

  get failureCount(): number {
    return this.traces.filter(t => !t.finalOk).length
  }

  /** Average duration across finished traces (ms). */
  get avgDurationMs(): number | null {
    const finished = this.traces.filter(t => t.durationMs != null && t.durationMs >= 0)
    if (finished.length === 0) return null
    const total = finished.reduce((sum, t) => sum + (t.durationMs ?? 0), 0)
    return total / finished.length
  }

  /** All steps across all traces, flattened. */
  get allSteps(): TraceStep[] {
    return this.traces.flatMap(t => t.steps)
  }

  /** Steps that attempted selector resolution (pre-find + post-find phases). */
  get findSteps(): TraceStep[] {
    return this.allSteps.filter(s => s.phase === 'post-find')
  }

  /** Steps that completed dispatch (post-dispatch phase). */
  get dispatchSteps(): TraceStep[] {
    return this.allSteps.filter(s => s.phase === 'post-dispatch')
  }

  /** Steps that completed verification (post-verify phase). */
  get verifySteps(): TraceStep[] {
    return this.allSteps.filter(s => s.phase === 'post-verify')
  }
}
