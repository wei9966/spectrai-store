/**
 * Persistent PowerShell process — spawn once, reuse for all commands.
 * Pre-loads assemblies and C# helper classes at startup.
 * Uses base64-encoded command protocol with marker-based output delimiting.
 */
import { spawn, ChildProcess } from 'child_process'

const MARKER = '<<<SPECTRAI_DONE>>>'
const ERR_PREFIX = '<<<SPECTRAI_ERR:'
const ERR_SUFFIX = '>>>'

export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** All Win32 helpers consolidated into one C# class, loaded once */
const BOOTSTRAP_CSHARP = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public class Win32 {
    // Mouse & Cursor
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

    // Window management
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    // Child window enumeration (for finding Chrome render widget)
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWnd, EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    // Accessibility forcing (triggers Chrome/Electron to build accessibility tree)
    [DllImport("oleacc.dll")]
    public static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint dwId, ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppvObject);

    public static readonly Guid IID_IAccessible = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
    public const uint OBJID_CLIENT = 0xFFFFFFFC;

    // Find Chrome_RenderWidgetHostHWND child and force accessibility
    public static IntPtr chromeRenderHwnd = IntPtr.Zero;
    public static bool FindChromeRenderWidget(IntPtr parentHwnd) {
        chromeRenderHwnd = IntPtr.Zero;
        EnumChildWindows(parentHwnd, (hWnd, _) => {
            var sb = new StringBuilder(256);
            GetClassName(hWnd, sb, 256);
            string cls = sb.ToString();
            if (cls == "Chrome_RenderWidgetHostHWND" || cls == "Intermediate D3D Window") {
                chromeRenderHwnd = hWnd;
                return false; // stop
            }
            return true;
        }, IntPtr.Zero);
        return chromeRenderHwnd != IntPtr.Zero;
    }

    public static bool ForceAccessibility(IntPtr hwnd) {
        try {
            object acc;
            Guid iid = IID_IAccessible;
            int hr = AccessibleObjectFromWindow(hwnd, OBJID_CLIENT, ref iid, out acc);
            return hr == 0 && acc != null;
        } catch { return false; }
    }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    public static List<object> windows = new List<object>();
    public static void ListWindows() {
        windows.Clear();
        EnumWindows((hWnd, _) => {
            if (!IsWindowVisible(hWnd)) return true;
            int len = GetWindowTextLength(hWnd);
            if (len == 0) return true;
            var sb = new StringBuilder(len + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            RECT r; GetWindowRect(hWnd, out r);
            uint pid; GetWindowThreadProcessId(hWnd, out pid);
            windows.Add(new { Handle = hWnd.ToInt64(), Title = sb.ToString(), ProcessId = pid,
                              X = r.Left, Y = r.Top, Width = r.Right - r.Left, Height = r.Bottom - r.Top });
            return true;
        }, IntPtr.Zero);
    }
}
"@
`

/** Bootstrap script: pre-load assemblies, define helpers, enter command loop */
const BOOTSTRAP_SCRIPT = `
$ErrorActionPreference = 'Continue'
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Pre-load .NET assemblies (one-time cost)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName 'System.Runtime.WindowsRuntime'
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation.UniversalApiContract, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation.UniversalApiContract, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation.UniversalApiContract, ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation.UniversalApiContract, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Foundation.UniversalApiContract, ContentType=WindowsRuntime]

# Pre-load consolidated Win32 helpers
${BOOTSTRAP_CSHARP}

# Pre-cache JPEG codec
$global:jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }

# Signal ready
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

# Command loop: read base64-encoded scripts from stdin
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($line -eq $null -or $line -eq 'EXIT') { break }
    try {
        $bytes = [Convert]::FromBase64String($line)
        $script = [System.Text.Encoding]::UTF8.GetString($bytes)
        $block = [ScriptBlock]::Create($script)
        $output = & $block 2>&1 | Out-String
        [Console]::Out.Write($output)
        [Console]::Out.WriteLine('${MARKER}')
        [Console]::Out.Flush()
    } catch {
        [Console]::Out.WriteLine('${ERR_PREFIX}' + $_.Exception.Message + '${ERR_SUFFIX}')
        [Console]::Out.WriteLine('${MARKER}')
        [Console]::Out.Flush()
    }
}
`

const START_TIMEOUT_MS = 30000
const PING_FAIL_THRESHOLD = 2

/** Machine-readable unhealthy prefix for callers / probes */
export const PS_UNHEALTHY = 'PS_UNHEALTHY'

export class PersistentShell {
  private proc: ChildProcess | null = null
  private ready = false
  private starting: Promise<void> | null = null
  private stdoutBuf = ''
  private pendingResolve: ((result: ShellResult) => void) | null = null
  private pendingReject: ((err: Error) => void) | null = null
  private pendingTimer: ReturnType<typeof setTimeout> | null = null
  /** Serial queue: at most one script in-flight (ponytail: chain, no PriorityQueue). */
  private queue: Promise<unknown> = Promise.resolve()
  private consecutivePingFails = 0
  /** Generation guard so stale exit/error handlers cannot wipe a newer proc. */
  private generation = 0

  /** Start the persistent PowerShell process (idempotent; awaits in-flight start). */
  async start(): Promise<void> {
    if (this.ready && this.proc && !this.proc.killed) return
    if (this.starting) return this.starting

    this.starting = this.spawnAndWaitReady().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  /** Explicit cold start after kill/hang. */
  async restart(): Promise<void> {
    this.kill()
    await this.start()
  }

  private forceKill(proc: ChildProcess): void {
    if (proc.killed) return
    const pid = proc.pid
    try {
      proc.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    // Windows: SIGTERM often leaves powershell.exe alive and blocks Node exit
    if (process.platform === 'win32' && pid) {
      try {
        spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        })
      } catch {
        /* ignore */
      }
    }
  }

  private async spawnAndWaitReady(): Promise<void> {
    if (this.proc) {
      this.kill()
    }

    this.ready = false
    this.stdoutBuf = ''
    const generation = ++this.generation

    await new Promise<void>((resolveReady, rejectReady) => {
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(startTimer)
        fn()
      }

      const startTimer = setTimeout(() => {
        this.kill()
        finish(() => rejectReady(new Error(`${PS_UNHEALTHY}: bootstrap timed out after ${START_TIMEOUT_MS}ms`)))
      }, START_TIMEOUT_MS)

      const proc = spawn('powershell.exe', [
        '-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-',
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this.proc = proc

      proc.stdout!.setEncoding('utf-8')
      proc.stderr!.setEncoding('utf-8')

      proc.stdout!.on('data', (chunk: string) => {
        if (this.generation !== generation || this.proc !== proc) return
        if (!this.ready) {
          this.stdoutBuf += chunk
          if (this.stdoutBuf.includes('READY')) {
            this.ready = true
            this.stdoutBuf = ''
            finish(() => resolveReady())
          }
          return
        }
        this.stdoutBuf += chunk
        this.tryResolve()
      })

      proc.stderr!.on('data', () => { /* swallow — errors via 2>&1 */ })

      proc.on('exit', (code) => {
        if (this.generation !== generation || this.proc !== proc) return
        const wasReady = this.ready
        this.ready = false
        this.proc = null
        if (this.pendingReject) {
          this.pendingReject(new Error(`PowerShell exited unexpectedly (code ${code})`))
          this.pendingReject = null
          this.pendingResolve = null
          this.clearTimer()
        }
        if (!wasReady) {
          finish(() => rejectReady(new Error(`${PS_UNHEALTHY}: exited during bootstrap (code ${code})`)))
        }
      })

      proc.on('error', (err) => {
        if (this.generation !== generation || this.proc !== proc) return
        this.ready = false
        if (this.pendingReject) {
          this.pendingReject(err)
          this.pendingReject = null
          this.pendingResolve = null
          this.clearTimer()
        }
        finish(() => rejectReady(new Error(`${PS_UNHEALTHY}: spawn failed: ${err.message}`)))
      })

      try {
        proc.stdin!.write(BOOTSTRAP_SCRIPT + '\n')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        finish(() => rejectReady(new Error(`${PS_UNHEALTHY}: stdin write failed: ${msg}`)))
      }
    })
  }

  private async ensureReady(): Promise<void> {
    if (this.ready && this.proc && !this.proc.killed) return
    try {
      await this.start()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        msg.startsWith(PS_UNHEALTHY)
          ? msg
          : `${PS_UNHEALTHY}: PowerShell process not available: ${msg}`,
      )
    }
    if (!this.proc || !this.ready) {
      throw new Error(`${PS_UNHEALTHY}: PowerShell process not available: failed to become ready`)
    }
  }

  private tryResolve(): void {
    const markerIdx = this.stdoutBuf.indexOf(MARKER)
    if (markerIdx === -1) return

    const output = this.stdoutBuf.substring(0, markerIdx)
    this.stdoutBuf = this.stdoutBuf.substring(markerIdx + MARKER.length).replace(/^\r?\n/, '')

    const errMatch = output.match(new RegExp(ERR_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(.+?)' + ERR_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

    if (this.pendingResolve) {
      this.clearTimer()
      if (errMatch) {
        this.pendingResolve({ stdout: '', stderr: errMatch[1], exitCode: 1 })
      } else {
        this.pendingResolve({ stdout: output.trimEnd(), stderr: '', exitCode: 0 })
      }
      this.pendingResolve = null
      this.pendingReject = null
    }
  }

  private clearTimer(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer)
      this.pendingTimer = null
    }
  }

  private execUnlocked(script: string, timeout: number): Promise<ShellResult> {
    return new Promise<ShellResult>((resolve, reject) => {
      this.pendingResolve = resolve
      this.pendingReject = reject

      this.pendingTimer = setTimeout(() => {
        this.pendingResolve = null
        this.pendingReject = null
        // Kill on timeout; next exec/restart cold-starts
        this.kill()
        reject(new Error(`PowerShell command timed out after ${timeout}ms`))
      }, timeout)

      try {
        const b64 = Buffer.from(script, 'utf-8').toString('base64')
        this.proc!.stdin!.write(b64 + '\n')
      } catch (err) {
        this.clearTimer()
        this.pendingResolve = null
        this.pendingReject = null
        this.kill()
        const msg = err instanceof Error ? err.message : String(err)
        reject(new Error(`${PS_UNHEALTHY}: PowerShell process not available: ${msg}`))
      }
    })
  }

  /** Execute a script in the persistent process (serialized). */
  async exec(script: string, timeout = 30000): Promise<ShellResult> {
    const run = this.queue.then(async () => {
      await this.ensureReady()
      return this.execUnlocked(script, timeout)
    })
    // Keep queue alive after failures so later callers still serialize
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Lightweight liveness probe. Consecutive failures yield PS_UNHEALTHY and attempt restart.
   */
  async ping(timeout = 5000): Promise<ShellResult> {
    try {
      const result = await this.exec("Write-Output 'PONG'", timeout)
      if (result.exitCode !== 0 || !result.stdout.includes('PONG')) {
        throw new Error('unexpected ping result')
      }
      this.consecutivePingFails = 0
      return result
    } catch (err) {
      this.consecutivePingFails += 1
      const fails = this.consecutivePingFails
      if (fails >= PING_FAIL_THRESHOLD) {
        await this.restart().catch(() => undefined)
      }
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`${PS_UNHEALTHY}: consecutive_ping_failures=${fails}: ${msg}`)
    }
  }

  /** Kill the persistent process (next exec will cold-start). */
  kill(): void {
    this.clearTimer()
    const proc = this.proc
    this.proc = null
    this.ready = false
    this.stdoutBuf = ''
    this.generation += 1
    if (this.pendingReject) {
      this.pendingReject(new Error(`${PS_UNHEALTHY}: PowerShell process killed`))
      this.pendingReject = null
      this.pendingResolve = null
    } else {
      this.pendingResolve = null
    }
    if (proc) this.forceKill(proc)
  }
}

/** Singleton instance */
export const shell = new PersistentShell()
