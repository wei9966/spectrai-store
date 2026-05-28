/**
 * Execution trace recording for SpectrAI Claw computer-use runtime.
 * Captures pre/post state at each phase without inlining image buffers.
 */

export type TracePhase =
  | 'pre-route'
  | 'pre-find'
  | 'post-find'
  | 'pre-dispatch'
  | 'post-dispatch'
  | 'post-verify'

export interface ScreenshotRef {
  /** Absolute path to the screenshot file on disk. Never inline buffer. */
  path: string
  capturedAt: number
  /** Optional element count from annotation if available. */
  elementCount?: number
}

export interface TraceElementInfo {
  id?: string
  role?: string
  name?: string
  bounds?: { x: number; y: number; width: number; height: number }
  source?: string
  confidence?: number
}

export interface TraceProviderInfo {
  id: string
  kind: string
  priority?: number
  fallback?: boolean
}

export interface TraceStep {
  phase: TracePhase
  timestamp: number

  // Provider context
  provider?: TraceProviderInfo

  // Screenshots (path-only, no buffer)
  screenshotBefore?: ScreenshotRef
  screenshotAfter?: ScreenshotRef

  // Element find result
  elementFound?: boolean
  element?: TraceElementInfo

  // Dispatch result
  actionOk?: boolean
  actionMethod?: string
  actionChanged?: boolean
  actionError?: string

  // Verification
  verificationOk?: boolean
  verificationMode?: string
  verificationMessage?: string

  // Selector attempted
  selectorAttempted?: boolean
  selectorResolved?: boolean
  usedFallback?: boolean
  foregroundRequired?: boolean

  // Timing
  durationMs?: number

  // Free-form metadata
  metadata?: Record<string, unknown>
}

export interface TraceActionSummary {
  type: string
  id?: string
  target?: string
}

export interface ExecutionTrace {
  traceId: string
  sessionId?: string
  startedAt: number
  finishedAt?: number
  durationMs?: number
  action?: TraceActionSummary
  steps: TraceStep[]
  finalOk?: boolean
  finalPhase?: string
  finalProviderId?: string
  finalError?: string
  metadata?: Record<string, unknown>
}

/**
 * Records execution steps for a single executeAction call.
 * All record* methods are wrapped in try/catch — a recording failure
 * never propagates to the caller.
 */
export class TraceRecorder {
  private trace: ExecutionTrace
  private stepStart: Map<TracePhase, number> = new Map()

  constructor(traceId: string, sessionId?: string) {
    this.trace = {
      traceId,
      sessionId,
      startedAt: Date.now(),
      steps: [],
    }
  }

  startTrace(action?: TraceActionSummary): void {
    try {
      this.trace.action = action
      this.trace.startedAt = Date.now()
    } catch {
      // recording errors must not propagate
    }
  }

  recordStep(step: TraceStep): void {
    try {
      const now = Date.now()
      const phaseStart = this.stepStart.get(step.phase)
      const enriched: TraceStep = {
        ...step,
        timestamp: step.timestamp ?? now,
        durationMs: phaseStart != null ? now - phaseStart : step.durationMs,
      }
      this.trace.steps.push(enriched)
    } catch {
      // recording errors must not propagate
    }
  }

  markPhaseStart(phase: TracePhase): void {
    try {
      this.stepStart.set(phase, Date.now())
    } catch {
      // recording errors must not propagate
    }
  }

  recordPreRoute(): void {
    try {
      this.markPhaseStart('pre-route')
      this.recordStep({ phase: 'pre-route', timestamp: Date.now() })
    } catch {
      // recording errors must not propagate
    }
  }

  recordPreFind(provider: TraceProviderInfo, selectorAttempted: boolean): void {
    try {
      this.markPhaseStart('pre-find')
      this.recordStep({
        phase: 'pre-find',
        timestamp: Date.now(),
        provider,
        selectorAttempted,
      })
    } catch {
      // recording errors must not propagate
    }
  }

  recordPostFind(
    provider: TraceProviderInfo,
    elementFound: boolean,
    element?: TraceElementInfo,
  ): void {
    try {
      const phaseStart = this.stepStart.get('pre-find')
      this.recordStep({
        phase: 'post-find',
        timestamp: Date.now(),
        provider,
        elementFound,
        element,
        selectorResolved: elementFound,
        durationMs: phaseStart != null ? Date.now() - phaseStart : undefined,
      })
    } catch {
      // recording errors must not propagate
    }
  }

  recordPreDispatch(provider: TraceProviderInfo, element?: TraceElementInfo): void {
    try {
      this.markPhaseStart('pre-dispatch')
      this.recordStep({
        phase: 'pre-dispatch',
        timestamp: Date.now(),
        provider,
        element,
      })
    } catch {
      // recording errors must not propagate
    }
  }

  recordPostDispatch(
    provider: TraceProviderInfo,
    result: {
      ok: boolean
      method?: string
      changed?: boolean
      error?: string
      usedFallback?: boolean
      foregroundRequired?: boolean
    },
  ): void {
    try {
      const phaseStart = this.stepStart.get('pre-dispatch')
      this.recordStep({
        phase: 'post-dispatch',
        timestamp: Date.now(),
        provider,
        actionOk: result.ok,
        actionMethod: result.method,
        actionChanged: result.changed,
        actionError: result.error,
        usedFallback: result.usedFallback,
        foregroundRequired: result.foregroundRequired,
        durationMs: phaseStart != null ? Date.now() - phaseStart : undefined,
      })
    } catch {
      // recording errors must not propagate
    }
  }

  recordPostVerify(
    provider: TraceProviderInfo,
    verification: {
      ok: boolean
      mode?: string
      message?: string
    },
  ): void {
    try {
      this.recordStep({
        phase: 'post-verify',
        timestamp: Date.now(),
        provider,
        verificationOk: verification.ok,
        verificationMode: verification.mode,
        verificationMessage: verification.message,
      })
    } catch {
      // recording errors must not propagate
    }
  }

  finalize(result: { ok: boolean; phase?: string; providerId?: string; error?: string }): ExecutionTrace {
    try {
      const now = Date.now()
      this.trace.finishedAt = now
      this.trace.durationMs = now - this.trace.startedAt
      this.trace.finalOk = result.ok
      this.trace.finalPhase = result.phase
      this.trace.finalProviderId = result.providerId
      this.trace.finalError = result.error
    } catch {
      // recording errors must not propagate
    }
    return this.trace
  }

  getTrace(): ExecutionTrace {
    return this.trace
  }
}
