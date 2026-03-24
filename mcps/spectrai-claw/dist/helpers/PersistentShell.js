/**
 * Persistent PowerShell process — spawn once, reuse for all commands.
 * Pre-loads assemblies and C# helper classes at startup.
 * Uses base64-encoded command protocol with marker-based output delimiting.
 */
import { spawn } from 'child_process';
const MARKER = '<<<SPECTRAI_DONE>>>';
const ERR_PREFIX = '<<<SPECTRAI_ERR:';
const ERR_SUFFIX = '>>>';
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
`;
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
`;
class PersistentShell {
    proc = null;
    ready = false;
    readyPromise = null;
    stdoutBuf = '';
    pendingResolve = null;
    pendingReject = null;
    pendingTimer = null;
    /** Start or restart the persistent PowerShell process */
    async start() {
        if (this.proc && !this.proc.killed)
            return;
        this.ready = false;
        this.stdoutBuf = '';
        this.readyPromise = new Promise((resolveReady) => {
            this.proc = spawn('powershell.exe', [
                '-NoProfile', '-NoLogo', '-NonInteractive', '-Command', '-',
            ], {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
            this.proc.stdout.setEncoding('utf-8');
            this.proc.stderr.setEncoding('utf-8');
            // Handle initial READY signal and subsequent command outputs
            this.proc.stdout.on('data', (chunk) => {
                if (!this.ready) {
                    // Waiting for bootstrap READY signal
                    this.stdoutBuf += chunk;
                    if (this.stdoutBuf.includes('READY')) {
                        this.ready = true;
                        this.stdoutBuf = '';
                        resolveReady();
                    }
                    return;
                }
                this.stdoutBuf += chunk;
                this.tryResolve();
            });
            // Collect stderr but don't block
            this.proc.stderr.on('data', () => { });
            this.proc.on('exit', (code) => {
                this.ready = false;
                this.proc = null;
                if (this.pendingReject) {
                    this.pendingReject(new Error(`PowerShell exited unexpectedly (code ${code})`));
                    this.pendingReject = null;
                    this.pendingResolve = null;
                    this.clearTimer();
                }
            });
            this.proc.on('error', (err) => {
                this.ready = false;
                if (this.pendingReject) {
                    this.pendingReject(err);
                    this.pendingReject = null;
                    this.pendingResolve = null;
                    this.clearTimer();
                }
            });
            // Send bootstrap script
            const b64 = Buffer.from(BOOTSTRAP_SCRIPT, 'utf-8').toString('base64');
            // Bootstrap runs as initial command, but since it's the command loop itself,
            // we actually pass it as the -Command argument. Let me restructure:
            // Actually, we already pass `-Command -` and the bootstrap IS the stdin.
            // We need to write the bootstrap as the first thing to stdin.
        });
        // Write the bootstrap loop script to stdin
        // Since we use `-Command -`, PowerShell reads from stdin.
        // We can't use the base64 protocol for bootstrap itself — we write it directly.
        this.proc.stdin.write(BOOTSTRAP_SCRIPT + '\n');
        await this.readyPromise;
    }
    tryResolve() {
        const markerIdx = this.stdoutBuf.indexOf(MARKER);
        if (markerIdx === -1)
            return;
        const output = this.stdoutBuf.substring(0, markerIdx);
        this.stdoutBuf = this.stdoutBuf.substring(markerIdx + MARKER.length).replace(/^\r?\n/, '');
        // Check for error marker in output
        const errMatch = output.match(new RegExp(ERR_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(.+?)' + ERR_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        if (this.pendingResolve) {
            this.clearTimer();
            if (errMatch) {
                this.pendingResolve({ stdout: '', stderr: errMatch[1], exitCode: 1 });
            }
            else {
                this.pendingResolve({ stdout: output.trimEnd(), stderr: '', exitCode: 0 });
            }
            this.pendingResolve = null;
            this.pendingReject = null;
        }
    }
    clearTimer() {
        if (this.pendingTimer) {
            clearTimeout(this.pendingTimer);
            this.pendingTimer = null;
        }
    }
    /** Execute a script in the persistent process */
    async exec(script, timeout = 30000) {
        await this.start();
        if (!this.proc || !this.ready) {
            throw new Error('PowerShell process not available');
        }
        return new Promise((resolve, reject) => {
            this.pendingResolve = resolve;
            this.pendingReject = reject;
            this.pendingTimer = setTimeout(() => {
                this.pendingResolve = null;
                this.pendingReject = null;
                // Kill and restart on timeout
                this.kill();
                reject(new Error(`PowerShell command timed out after ${timeout}ms`));
            }, timeout);
            const b64 = Buffer.from(script, 'utf-8').toString('base64');
            this.proc.stdin.write(b64 + '\n');
        });
    }
    /** Kill the persistent process */
    kill() {
        this.clearTimer();
        if (this.proc && !this.proc.killed) {
            this.proc.kill('SIGTERM');
        }
        this.proc = null;
        this.ready = false;
        this.stdoutBuf = '';
        this.pendingResolve = null;
        this.pendingReject = null;
    }
}
/** Singleton instance */
export const shell = new PersistentShell();
