/**
 * SpectrAI Claw presence overlay — click-through HUD while AI drives the desktop.
 *
 * Windows: lazy-spawn a WinForms overlay process (presence-overlay.ps1).
 * Any failure is swallowed so automation never fails because of the HUD.
 */
import { spawn, type ChildProcess } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SCRIPT_PATH = join(__dirname, '..', 'scripts', 'presence-overlay.ps1')

let child: ChildProcess | null = null
let exitHookInstalled = false

export interface PresenceOverlayDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  spawn?: typeof spawn
  scriptPath?: string
}

function silent(_err?: unknown): void {
  // ponytail: overlay must never affect automation; swallow everything.
}

export function isPresenceEnabled(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (env.CLAW_PRESENCE === '0') return false
  return platform === 'win32'
}

/** Format a stdin command for the overlay process. Pure — safe to unit-test. */
export function formatPresenceCommand(label: string, x?: number, y?: number): string {
  const safe = sanitizeLabel(label)
  if (Number.isFinite(x) && Number.isFinite(y)) {
    return `MARK ${Math.round(x as number)} ${Math.round(y as number)} ${safe}`
  }
  return `BADGE ${safe}`
}

export function sanitizeLabel(label: string): string {
  return String(label ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 80)
}

function writeLine(proc: ChildProcess, line: string): void {
  try {
    if (!proc.stdin || proc.stdin.destroyed) return
    proc.stdin.write(line + '\n', 'utf8')
  } catch (err) {
    silent(err)
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  const stop = () => {
    try { presenceStop() } catch (err) { silent(err) }
  }
  process.once('exit', stop)
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

function ensureChild(deps: PresenceOverlayDeps = {}): ChildProcess | null {
  try {
    const platform = deps.platform ?? process.platform
    const env = deps.env ?? process.env
    if (!isPresenceEnabled(env, platform)) return null
    if (child && !child.killed && child.exitCode == null) return child

    const spawnFn = deps.spawn ?? spawn
    const scriptPath = deps.scriptPath ?? SCRIPT_PATH
    const proc = spawnFn('powershell.exe', [
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
    ], {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    })
    proc.unref?.()
    proc.on('error', silent)
    proc.on('exit', () => {
      if (child === proc) child = null
    })
    try { proc.stdin?.on('error', silent) } catch (err) { silent(err) }
    child = proc
    installExitHook()
    return proc
  } catch (err) {
    silent(err)
    child = null
    return null
  }
}

/**
 * Show presence. With x/y → MARK (ring + badge); otherwise BADGE only.
 * Never throws.
 */
export function presenceMark(label: string, x?: number, y?: number, deps?: PresenceOverlayDeps): void {
  try {
    const platform = deps?.platform ?? process.platform
    const env = deps?.env ?? process.env
    if (!isPresenceEnabled(env, platform)) return
    // ponytail: macOS overlay skipped — upgrade path is a Swift daemon NSPanel
    // (nonactivating, ignoresMouseEvents, floating level) talking over the existing socket.
    if (platform !== 'win32') return
    const proc = ensureChild(deps)
    if (!proc) return
    writeLine(proc, formatPresenceCommand(label, x, y))
  } catch (err) {
    silent(err)
  }
}

/** Hide overlay immediately. Never throws. */
export function presenceHide(deps?: PresenceOverlayDeps): void {
  try {
    const proc = child
    if (!proc || proc.killed || proc.exitCode != null) return
    if (deps) {
      const platform = deps.platform ?? process.platform
      const env = deps.env ?? process.env
      if (!isPresenceEnabled(env, platform)) return
    }
    writeLine(proc, 'HIDE')
  } catch (err) {
    silent(err)
  }
}

/** Kill overlay process (best-effort). Never throws. */
export function presenceStop(): void {
  try {
    const proc = child
    child = null
    if (!proc) return
    try { writeLine(proc, 'QUIT') } catch (err) { silent(err) }
    try { proc.stdin?.end() } catch (err) { silent(err) }
    try { proc.kill() } catch (err) { silent(err) }
  } catch (err) {
    silent(err)
  }
}

/** Test-only: reset singleton so cases can re-spawn. */
export function resetPresenceOverlayForTests(): void {
  child = null
}
