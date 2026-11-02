/**
 * Per-call identity supplied by the host through MCP `_meta`.
 * SpectrAI shares one Claw process between sessions, so "last screenshot" state and
 * relative paths must follow the calling session rather than the process.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { resolve } from 'node:path'

export interface ToolCallContext {
  sessionId?: string
  cwd?: string
}

export const META_SESSION_ID = 'spectrai/sessionId'
export const META_CWD = 'spectrai/cwd'

const storage = new AsyncLocalStorage<ToolCallContext>()

export function contextFromMeta(meta: unknown): ToolCallContext {
  const m = (meta && typeof meta === 'object' ? meta : {}) as Record<string, unknown>
  const pick = (k: string) => (typeof m[k] === 'string' && (m[k] as string).trim() ? (m[k] as string) : undefined)
  return { sessionId: pick(META_SESSION_ID), cwd: pick(META_CWD) }
}

export function runWithToolCallContext<T>(context: ToolCallContext, fn: () => T): T {
  return storage.run(context, fn)
}

export function currentToolCallContext(): ToolCallContext {
  return storage.getStore() ?? {}
}

/** Relative paths resolve against the calling session's directory, not the shared process cwd. */
export function resolveCallPath(p: string): string {
  const cwd = currentToolCallContext().cwd
  return cwd ? resolve(cwd, p) : resolve(p)
}

/** State bucket per calling session. Hosts that send no identity share one bucket (standalone use). */
export class SessionStateStore<T> {
  private readonly states = new Map<string, T>()

  constructor(
    private readonly create: () => T,
    private readonly maxSessions = 64,
  ) {}

  current(): T {
    const key = currentToolCallContext().sessionId ?? ''
    let state = this.states.get(key)
    if (state) {
      this.states.delete(key) // re-insert: Map order doubles as LRU
    } else {
      state = this.create()
      if (this.states.size >= this.maxSessions) {
        const oldest = this.states.keys().next().value
        if (oldest !== undefined) this.states.delete(oldest)
      }
    }
    this.states.set(key, state)
    return state
  }
}
