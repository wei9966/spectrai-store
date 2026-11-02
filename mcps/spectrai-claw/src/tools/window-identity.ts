/**
 * Window identity for the screenshot → number → action chain.
 * Each annotated element is bound to the top-level window actually hit at its centre, so
 * Pane/owned dialogs (NativeWindowHandle=0, Process.MainWindowHandle=0) stay addressable and
 * a later action can prove the surface is still the one shown in the image.
 */

export interface WindowIdentity {
  hwnd: number
  pid: number
  left: number
  top: number
  right: number
  bottom: number
  title: string
}

export interface ClickProbe {
  exists: boolean
  pid: number
  visible: boolean
  iconic: boolean
  left: number
  top: number
  right: number
  bottom: number
  foreground: number
  foregroundPid: number
  foregroundTitle: string
  hit: number
  hitTitle: string
}

export type ClickGuardCode =
  | 'no_window_identity'
  | 'probe_failed'
  | 'window_gone'
  | 'window_hidden'
  | 'window_moved'
  | 'target_occluded'
  | 'foreground_unavailable'
  | 'foreground_changed'
  | 'not_foreground'

export type ClickGuardResult =
  | { ok: true }
  | { ok: false; code: ClickGuardCode; detail: string; next: string }

const RESCREENSHOT = 'Take a new screenshot(annotate=true); old element numbers are no longer valid.'

/** Decide whether input may be sent. Never activates anything: focus changes stay an explicit window_focus call. */
export function classifyClickGuard(input: {
  rootHwnd?: number
  identity?: WindowIdentity | null
  foregroundAtCapture?: number
  probe: ClickProbe | null
}): ClickGuardResult {
  const { rootHwnd, identity, foregroundAtCapture, probe } = input
  if (!rootHwnd || !identity) {
    return { ok: false, code: 'no_window_identity', detail: 'This element has no recorded window (old or incomplete screenshot metadata).', next: RESCREENSHOT }
  }
  const name = `"${identity.title}" hwnd=${identity.hwnd}`
  if (!probe) {
    return { ok: false, code: 'probe_failed', detail: `Could not read the state of ${name}.`, next: 'Retry once; if it repeats, take a new screenshot(annotate=true).' }
  }
  if (!probe.exists || probe.pid !== identity.pid) {
    return { ok: false, code: 'window_gone', detail: `Window ${name} no longer exists (closed, or its handle was reused).`, next: RESCREENSHOT }
  }
  if (probe.iconic || !probe.visible) {
    return { ok: false, code: 'window_hidden', detail: `Window ${name} is ${probe.iconic ? 'minimized' : 'hidden'}.`, next: `Call window_focus({handle:${identity.hwnd}}), then retry.` }
  }
  if (
    probe.left !== identity.left || probe.top !== identity.top ||
    probe.right !== identity.right || probe.bottom !== identity.bottom
  ) {
    return { ok: false, code: 'window_moved', detail: `Window ${name} moved or resized since the screenshot, so element coordinates are stale.`, next: RESCREENSHOT }
  }
  if (!probe.foreground) {
    return { ok: false, code: 'foreground_unavailable', detail: 'No foreground window (locked screen, UAC prompt or secure desktop).', next: 'Stop and wait for the user; do not retry in a loop.' }
  }
  if (probe.hit !== identity.hwnd) {
    return { ok: false, code: 'target_occluded', detail: `The click point is covered by "${probe.hitTitle}" hwnd=${probe.hit}.`, next: `If that window is the real target call screenshot({followHandle:${probe.hit}}); otherwise wait for it to close. Do not retry this number.` }
  }
  if (probe.foreground !== identity.hwnd) {
    const fg = `"${probe.foregroundTitle}" hwnd=${probe.foreground}`
    if (foregroundAtCapture && probe.foreground !== foregroundAtCapture) {
      return { ok: false, code: 'foreground_changed', detail: `Foreground moved to ${fg} after the screenshot; the user may be working there.`, next: `Pause and do not take the window back automatically. Only if this task may switch windows, call window_focus({handle:${identity.hwnd}}), then retry.` }
    }
    // Unchanged foreground in the same app: a menu or dropdown is its own top-level window.
    if (probe.foregroundPid !== identity.pid) {
      return { ok: false, code: 'not_foreground', detail: `Target ${name} is behind ${fg}.`, next: `Call window_focus({handle:${identity.hwnd}}), then retry.` }
    }
  }
  return { ok: true }
}

export function formatClickGuardRefusal(action: 'Click' | 'Type', result: Exclude<ClickGuardResult, { ok: true }>): string {
  return `${action} aborted: ${result.code}. ${result.detail} No input was sent. NEXT: ${result.next}`
}

const CLICK_PROBE_MARKER = '__SPECTRAI_CLICK_PROBE__'

export function parseClickProbe(stdout: string): ClickProbe | null {
  const line = stdout.split('\n').map(l => l.trim()).reverse().find(l => l.startsWith(CLICK_PROBE_MARKER))
  if (!line) return null
  try {
    return JSON.parse(line.slice(CLICK_PROBE_MARKER.length)) as ClickProbe
  } catch {
    return null
  }
}

/** Parse one `__WIN__|hwnd|pid|l|t|r|b|title` line. Titles may contain '|'. */
export function parseWindowLine(line: string): WindowIdentity | null {
  const p = line.split('|')
  if (p[0] !== '__WIN__' || p.length < 8) return null
  const [hwnd, pid, left, top, right, bottom] = p.slice(1, 7).map(Number)
  if (![hwnd, pid, left, top, right, bottom].every(Number.isFinite) || !hwnd) return null
  return { hwnd, pid, left, top, right, bottom, title: p.slice(7).join('|') }
}

/** Foreground at the start/end of annotation; differing values mean numbers may not match the image. */
export function parseForegroundLine(line: string): { start: number; end: number } | null {
  const p = line.split('|')
  if (p[0] !== '__FG__' || p.length < 3) return null
  const start = Number(p[1])
  const end = Number(p[2])
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null
}

/** Captured the assistant host itself rather than the app being driven (common with followForeground). */
export function isSelfHostWindow(title: string): boolean {
  return /spectrai/i.test(title)
}

/** Compiled once per PersistentShell. Avoid '$' in the C# body: it sits in an expanding here-string. */
export const CLAW_WIN_TYPE_PS = `
if (-not ("ClawWin1" -as [type])) {
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ClawWin1 {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static long RootOf(long h) { return h == 0 ? 0 : GetAncestor(new IntPtr(h), 2).ToInt64(); }
  public static long RootAt(int x, int y) {
    POINT p; p.X = x; p.Y = y;
    IntPtr h = WindowFromPoint(p);
    return h == IntPtr.Zero ? 0 : GetAncestor(h, 2).ToInt64();
  }
  public static long ForegroundRoot() { return RootOf(GetForegroundWindow().ToInt64()); }
  public static string Title(long h) { var s = new StringBuilder(512); GetWindowText(new IntPtr(h), s, s.Capacity); return s.ToString(); }
  public static long PidOf(long h) { uint pid; GetWindowThreadProcessId(new IntPtr(h), out pid); return pid; }
  public static string Info(long h) {
    RECT r; GetWindowRect(new IntPtr(h), out r);
    return h + "|" + PidOf(h) + "|" + r.Left + "|" + r.Top + "|" + r.Right + "|" + r.Bottom + "|" + Title(h).Replace("\\r", " ").Replace("\\n", " ");
  }
  // Process.MainWindowHandle is 0 for owned dialogs and helper processes, so enumerate instead.
  public static long Find(long pid, string title) {
    long best = 0; long bestScore = -1; long fg = ForegroundRoot();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      RECT r; if (!GetWindowRect(h, out r) || r.Left <= -30000) return true;
      long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (area <= 0) return true;
      long v = h.ToInt64();
      if (pid != 0 && PidOf(v) != pid) return true;
      if (!string.IsNullOrEmpty(title) && Title(v).IndexOf(title, StringComparison.OrdinalIgnoreCase) < 0) return true;
      long score = area + (IsWindowEnabled(h) ? (1L << 40) : 0) + (v == fg ? (1L << 41) : 0);
      if (score > bestScore) { bestScore = score; best = v; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
"@
}
`

/** Must run right after the $filtered element list is built; adds $el.R and emits window lines. */
export const ANNOTATE_WINDOW_OUTPUT_PS = `
$clawRoots = @{}
foreach ($el in $filtered) {
    $el.R = [ClawWin1]::RootAt([int]$el.CX, [int]$el.CY)
    if ($el.R -ne 0) { $clawRoots[[long]$el.R] = $true }
}
foreach ($clawRoot in $clawRoots.Keys) { Write-Output "__WIN__|$([ClawWin1]::Info($clawRoot))" }
Write-Output "__FG__|$clawFgStart|$([ClawWin1]::ForegroundRoot())"
`

export function clickProbeScript(hwnd: number, x: number, y: number): string {
  return `
${CLAW_WIN_TYPE_PS}
$h = [IntPtr]::new(${Math.trunc(hwnd)})
$fgRoot = [ClawWin1]::ForegroundRoot()
$hitRoot = [ClawWin1]::RootAt(${Math.round(x)}, ${Math.round(y)})
$rect = New-Object ClawWin1+RECT
$exists = [ClawWin1]::IsWindow($h)
if ($exists) { [ClawWin1]::GetWindowRect($h, [ref]$rect) | Out-Null }
$probe = @{
  exists = [bool]$exists
  pid = if ($exists) { [ClawWin1]::PidOf(${Math.trunc(hwnd)}) } else { 0 }
  visible = [bool]([ClawWin1]::IsWindowVisible($h))
  iconic = [bool]([ClawWin1]::IsIconic($h))
  left = $rect.Left; top = $rect.Top; right = $rect.Right; bottom = $rect.Bottom
  foreground = $fgRoot
  foregroundPid = if ($fgRoot) { [ClawWin1]::PidOf($fgRoot) } else { 0 }
  foregroundTitle = if ($fgRoot) { [ClawWin1]::Title($fgRoot) } else { '' }
  hit = $hitRoot
  hitTitle = if ($hitRoot) { [ClawWin1]::Title($hitRoot) } else { '' }
}
Write-Output "${CLICK_PROBE_MARKER}$($probe | ConvertTo-Json -Compress)"
`
}
