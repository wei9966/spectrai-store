/**
 * macOS platform helper — calls the pre-compiled Swift helper binary.
 * Equivalent of PersistentShell.ts for Windows.
 */
import { execFileSync, execFile } from 'child_process'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Swift helper binary path — look for compiled binary, fall back to swift run
const HELPER_PATHS = [
  join(__dirname, '..', 'bin', 'darwin', 'spectrai-claw-helper'),
  join(__dirname, '..', '..', 'src', 'swift-helper', '.build', 'release', 'spectrai-claw-helper'),
  join(__dirname, '..', '..', 'src', 'swift-helper', '.build', 'debug', 'spectrai-claw-helper'),
]

function findHelper(): string {
  for (const p of HELPER_PATHS) {
    if (existsSync(p)) return p
  }
  return 'swift-run-fallback'
}

let helperPath: string | null = null

function getHelperPath(): string {
  if (!helperPath) {
    helperPath = findHelper()
  }
  return helperPath
}

export interface DarwinResult {
  success: boolean
  data?: any
  error?: string
}

/**
 * Call the Swift helper with a command and arguments.
 * Returns parsed JSON result.
 */
export function callHelper(
  command: string,
  args: Record<string, string | number | boolean> = {},
): DarwinResult {
  const hp = getHelperPath()
  const flatArgs = Object.entries(args)
    .filter(([_, v]) => v !== undefined && v !== null)
    .flatMap(([k, v]) => [`--${k}`, String(v)])

  try {
    let result: string
    if (hp === 'swift-run-fallback') {
      const packageDir = join(__dirname, '..', '..', 'src', 'swift-helper')
      result = execFileSync(
        'swift',
        ['run', 'spectrai-claw-helper', command, ...flatArgs],
        {
          encoding: 'utf-8',
          timeout: 30000,
          cwd: packageDir,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
    } else {
      result = execFileSync(hp, [command, ...flatArgs], {
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    }
    return { success: true, data: JSON.parse(result.trim()) }
  } catch (err: any) {
    const stderr = err.stderr?.toString() || ''
    const stdout = err.stdout?.toString() || ''
    return { success: false, error: stderr || stdout || err.message }
  }
}

/**
 * Async version of callHelper for non-blocking operations.
 */
export function callHelperAsync(
  command: string,
  args: Record<string, string | number | boolean> = {},
): Promise<DarwinResult> {
  return new Promise((resolve) => {
    const hp = getHelperPath()
    const flatArgs = Object.entries(args)
      .filter(([_, v]) => v !== undefined && v !== null)
      .flatMap(([k, v]) => [`--${k}`, String(v)])

    const execFn =
      hp === 'swift-run-fallback'
        ? {
            cmd: 'swift' as const,
            cmdArgs: ['run', 'spectrai-claw-helper', command, ...flatArgs],
            cwd: join(__dirname, '..', '..', 'src', 'swift-helper'),
          }
        : { cmd: hp, cmdArgs: [command, ...flatArgs], cwd: undefined as string | undefined }

    execFile(
      execFn.cmd,
      execFn.cmdArgs,
      {
        encoding: 'utf-8',
        timeout: 30000,
        cwd: execFn.cwd,
      },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ success: false, error: stderr || stdout || err.message })
        } else {
          try {
            resolve({ success: true, data: JSON.parse(stdout.trim()) })
          } catch {
            resolve({ success: false, error: `Invalid JSON: ${stdout}` })
          }
        }
      },
    )
  })
}

// Convenience functions for common operations
export const darwin = {
  screenshot(options?: {
    region?: string
    windowId?: number
    output?: string
    maxWidth?: number
  }) {
    const args: Record<string, any> = {}
    if (options?.region) args.region = options.region
    if (options?.windowId) args['window-id'] = options.windowId
    if (options?.output) args.output = options.output
    if (options?.maxWidth) args['max-width'] = options.maxWidth
    return callHelper('screenshot', args)
  },

  mouseMove(x: number, y: number) {
    return callHelper('mouse-move', { x, y })
  },

  mouseClick(x: number, y: number, button = 'left', count = 1) {
    return callHelper('mouse-click', { x, y, button, count })
  },

  mouseScroll(deltaY: number, deltaX = 0) {
    return callHelper('mouse-scroll', { 'delta-y': deltaY, 'delta-x': deltaX })
  },

  keyType(text: string) {
    return callHelper('key-type', { text })
  },

  keyPress(key: string, modifiers?: string) {
    const args: Record<string, any> = { key }
    if (modifiers) args.modifiers = modifiers
    return callHelper('key-press', args)
  },

  keyHotkey(keys: string) {
    return callHelper('key-hotkey', { keys })
  },

  axTree(pid: number, depth = 5) {
    return callHelper('ax-tree', { pid, depth })
  },

  axElementAt(x: number, y: number) {
    return callHelper('ax-element-at', { x, y })
  },

  ocr(imagePath: string, languages = 'en-US') {
    return callHelper('ocr', { image: imagePath, languages })
  },

  windowsList() {
    return callHelper('windows', {})
  },

  windowFocus(pid: number, title?: string) {
    const args: Record<string, any> = { pid }
    if (title) args.title = title
    return callHelper('window-focus', args)
  },

  windowClose(pid: number, title?: string) {
    const args: Record<string, any> = { pid }
    if (title) args.title = title
    return callHelper('window-close', args)
  },

  screenInfo() {
    return callHelper('screen-info', {})
  },

  checkPermissions() {
    return callHelper('permissions', {})
  },
}
