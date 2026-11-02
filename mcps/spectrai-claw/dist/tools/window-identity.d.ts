/**
 * Window identity for the screenshot → number → action chain.
 * Each annotated element is bound to the top-level window actually hit at its centre, so
 * Pane/owned dialogs (NativeWindowHandle=0, Process.MainWindowHandle=0) stay addressable and
 * a later action can prove the surface is still the one shown in the image.
 */
export interface WindowIdentity {
    hwnd: number;
    pid: number;
    left: number;
    top: number;
    right: number;
    bottom: number;
    title: string;
}
export interface ClickProbe {
    exists: boolean;
    pid: number;
    visible: boolean;
    iconic: boolean;
    left: number;
    top: number;
    right: number;
    bottom: number;
    foreground: number;
    foregroundPid: number;
    foregroundTitle: string;
    hit: number;
    hitTitle: string;
}
export type ClickGuardCode = 'no_window_identity' | 'probe_failed' | 'window_gone' | 'window_hidden' | 'window_moved' | 'target_occluded' | 'foreground_unavailable' | 'foreground_changed' | 'not_foreground';
export type ClickGuardResult = {
    ok: true;
} | {
    ok: false;
    code: ClickGuardCode;
    detail: string;
    next: string;
};
/** Decide whether input may be sent. Never activates anything: focus changes stay an explicit window_focus call. */
export declare function classifyClickGuard(input: {
    rootHwnd?: number;
    identity?: WindowIdentity | null;
    foregroundAtCapture?: number;
    probe: ClickProbe | null;
}): ClickGuardResult;
export declare function formatClickGuardRefusal(action: 'Click' | 'Type', result: Exclude<ClickGuardResult, {
    ok: true;
}>): string;
export declare function parseClickProbe(stdout: string): ClickProbe | null;
/** Parse one `__WIN__|hwnd|pid|l|t|r|b|title` line. Titles may contain '|'. */
export declare function parseWindowLine(line: string): WindowIdentity | null;
/** Foreground at the start/end of annotation; differing values mean numbers may not match the image. */
export declare function parseForegroundLine(line: string): {
    start: number;
    end: number;
} | null;
/** Captured the assistant host itself rather than the app being driven (common with followForeground). */
export declare function isSelfHostWindow(title: string): boolean;
/** Compiled once per PersistentShell. Avoid '$' in the C# body: it sits in an expanding here-string. */
export declare const CLAW_WIN_TYPE_PS = "\nif (-not (\"ClawWin1\" -as [type])) {\nAdd-Type @\"\nusing System;\nusing System.Text;\nusing System.Runtime.InteropServices;\npublic class ClawWin1 {\n  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }\n  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }\n  delegate bool EnumProc(IntPtr h, IntPtr l);\n  [DllImport(\"user32.dll\")] static extern IntPtr WindowFromPoint(POINT p);\n  [DllImport(\"user32.dll\")] static extern IntPtr GetAncestor(IntPtr h, uint flags);\n  [DllImport(\"user32.dll\")] static extern IntPtr GetForegroundWindow();\n  [DllImport(\"user32.dll\")] public static extern bool IsWindow(IntPtr h);\n  [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr h);\n  [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr h);\n  [DllImport(\"user32.dll\")] static extern bool IsWindowEnabled(IntPtr h);\n  [DllImport(\"user32.dll\")] public static extern bool GetWindowRect(IntPtr h, out RECT r);\n  [DllImport(\"user32.dll\")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);\n  [DllImport(\"user32.dll\")] static extern bool EnumWindows(EnumProc cb, IntPtr l);\n  [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);\n  public static long RootOf(long h) { return h == 0 ? 0 : GetAncestor(new IntPtr(h), 2).ToInt64(); }\n  public static long RootAt(int x, int y) {\n    POINT p; p.X = x; p.Y = y;\n    IntPtr h = WindowFromPoint(p);\n    return h == IntPtr.Zero ? 0 : GetAncestor(h, 2).ToInt64();\n  }\n  public static long ForegroundRoot() { return RootOf(GetForegroundWindow().ToInt64()); }\n  public static string Title(long h) { var s = new StringBuilder(512); GetWindowText(new IntPtr(h), s, s.Capacity); return s.ToString(); }\n  public static long PidOf(long h) { uint pid; GetWindowThreadProcessId(new IntPtr(h), out pid); return pid; }\n  public static string Info(long h) {\n    RECT r; GetWindowRect(new IntPtr(h), out r);\n    return h + \"|\" + PidOf(h) + \"|\" + r.Left + \"|\" + r.Top + \"|\" + r.Right + \"|\" + r.Bottom + \"|\" + Title(h).Replace(\"\\r\", \" \").Replace(\"\\n\", \" \");\n  }\n  // Process.MainWindowHandle is 0 for owned dialogs and helper processes, so enumerate instead.\n  public static long Find(long pid, string title) {\n    long best = 0; long bestScore = -1; long fg = ForegroundRoot();\n    EnumWindows(delegate(IntPtr h, IntPtr l) {\n      if (!IsWindowVisible(h) || IsIconic(h)) return true;\n      RECT r; if (!GetWindowRect(h, out r) || r.Left <= -30000) return true;\n      long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);\n      if (area <= 0) return true;\n      long v = h.ToInt64();\n      if (pid != 0 && PidOf(v) != pid) return true;\n      if (!string.IsNullOrEmpty(title) && Title(v).IndexOf(title, StringComparison.OrdinalIgnoreCase) < 0) return true;\n      long score = area + (IsWindowEnabled(h) ? (1L << 40) : 0) + (v == fg ? (1L << 41) : 0);\n      if (score > bestScore) { bestScore = score; best = v; }\n      return true;\n    }, IntPtr.Zero);\n    return best;\n  }\n}\n\"@\n}\n";
/** Must run right after the $filtered element list is built; adds $el.R and emits window lines. */
export declare const ANNOTATE_WINDOW_OUTPUT_PS = "\n$clawRoots = @{}\nforeach ($el in $filtered) {\n    $el.R = [ClawWin1]::RootAt([int]$el.CX, [int]$el.CY)\n    if ($el.R -ne 0) { $clawRoots[[long]$el.R] = $true }\n}\nforeach ($clawRoot in $clawRoots.Keys) { Write-Output \"__WIN__|$([ClawWin1]::Info($clawRoot))\" }\nWrite-Output \"__FG__|$clawFgStart|$([ClawWin1]::ForegroundRoot())\"\n";
export declare function clickProbeScript(hwnd: number, x: number, y: number): string;
