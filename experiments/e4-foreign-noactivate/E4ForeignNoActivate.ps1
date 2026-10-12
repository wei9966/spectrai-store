# E4 - cross-process WS_EX_NOACTIVATE: make a FOREIGN window not steal foreground
# ---------------------------------------------------------------------------
# E3 proved, on a witness window created by our own process, that
#   synthetic pen click + WS_EX_NOACTIVATE  => hit + zero cursor move + foreground unchanged
# E4 asks the product-relevant question: can the same mitigation be applied to a
# window owned by ANOTHER process, at runtime, and taken back off afterwards?
#
#   prev = GetWindowLongPtrW(hwnd, GWL_EXSTYLE)          (-20)
#   SetWindowLongPtrW(hwnd, GWL_EXSTYLE, prev | 0x08000000)   // WS_EX_NOACTIVATE
#   ... inject pen click ...
#   SetWindowLongPtrW(hwnd, GWL_EXSTYLE, prev)           // restore
#
# Readout: the target's own window TITLE (set by the page's JS on pointerdown,
# with screenX/screenY/pointerType). No bitmap reading, no screenshot.
#
# Safety: only the ex-style of one window is touched, only for the duration of
# the run, and it is restored and read back for verification. No injection into
# the target process, no DLL, no hooks, no SendInput.
#
# 100% ASCII on purpose (PS 5.1 decodes a BOM-less .ps1 as ANSI).

[CmdletBinding()]
param(
    # target: exact hwnd, or a regex over window titles
    [int]$TargetHwnd = 0,
    [string]$TargetTitle = '',

    # click point in virtual-screen pixels; -1 = centre of the target's rect
    [int]$ClickX = -1,
    [int]$ClickY = -1,
    [int]$Clicks = 1,

    # add WS_EX_NOACTIVATE for the duration of the run, then restore it
    [switch]$SetNoActivate,
    # do NOT restore afterwards (leaves the style on) - off by default
    [switch]$KeepStyle,

    # raise the target to the top of the non-topmost band (HWND_TOP +
    # SWP_NOACTIVATE) so the click point is unoccluded without changing focus
    [switch]$Raise,
    # promote the target to the topmost band (HWND_TOPMOST + SWP_NOACTIVATE);
    # reverted at the end unless -KeepStyle is given
    [switch]$Topmost,

    # just print the current ex-style and exit
    [switch]$ReadOnly,

    [switch]$NoPark,
    [string]$ParkProc = '',
    [string]$ParkClass = '',
    [string]$ParkTitle = '',

    [int]$PreMs = 500,
    [int]$SettleMs = 700,

    [ValidateSet(2,3)]
    [int]$PointerType = 3,
    [ValidateSet(1,2,3)]
    [int]$FeedbackMode = 1,

    [string]$OutDir = ''
)

if ([string]::IsNullOrEmpty($OutDir)) { $OutDir = $PSScriptRoot }

$ErrorActionPreference = 'Stop'

$cs = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class E4
{
    private delegate bool EnumProc(IntPtr h, IntPtr l);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int L, T, R, B; }

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] private static extern void SwitchToThisWindow(IntPtr h, bool altTab);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr h);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong32(IntPtr h, int i);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] private static extern int SetWindowLong32(IntPtr h, int i, int v);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr64(IntPtr h, int i);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] private static extern IntPtr SetWindowLongPtr64(IntPtr h, int i, IntPtr v);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr CreateSyntheticPointerDevice(int pointerType, uint maxCount, int mode);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool InjectSyntheticPointerInput(IntPtr dev, ref POINTER_TYPE_INFO info, uint count);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern void DestroySyntheticPointerDevice(IntPtr dev);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();

    [StructLayout(LayoutKind.Sequential)]
    public struct POINTER_INFO
    {
        public uint pointerType; public uint pointerId; public uint frameId; public uint pointerFlags;
        public IntPtr sourceDevice; public IntPtr hwndTarget;
        public int pixX, pixY, himX, himY, pixRawX, pixRawY, himRawX, himRawY;
        public uint dwTime; public uint historyCount; public int InputData; public uint dwKeyStates;
        public ulong PerformanceCount; public int ButtonChangeType;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PEN_INFO { public POINTER_INFO pi; public uint penMask; public uint pressure; public uint rotation; public int tiltX, tiltY; }
    [StructLayout(LayoutKind.Sequential)]
    public struct POINTER_TYPE_INFO { public uint type; public PEN_INFO pen; public ulong p0, p1, p2, p3, p4, p5, p6, p7; }

    private const int GWL_EXSTYLE = -20;
    private const long WS_EX_NOACTIVATE = 0x08000000L;
    private const uint POINTER_FLAG_INRANGE = 0x00000002;
    private const uint POINTER_FLAG_INCONTACT = 0x00000004;
    private const uint POINTER_FLAG_PRIMARY = 0x00002000;
    private const uint POINTER_FLAG_DOWN = 0x00010000;
    private const uint POINTER_FLAG_UP = 0x00040000;
    private const uint PEN_MASK_PRESSURE = 0x00000001;

    public class WinInfo { public IntPtr Hwnd; public string Title; public string Cls; public uint Pid; public string Proc; }

    private static System.Text.RegularExpressions.Regex Rx(string p)
    {
        return string.IsNullOrEmpty(p) ? null
            : new System.Text.RegularExpressions.Regex(p, System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    }

    public static List<WinInfo> TopLevel(string titleRegex)
    {
        var res = new List<WinInfo>();
        var tr = Rx(titleRegex);
        uint myPid = (uint)Process.GetCurrentProcess().Id;
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            var sb = new StringBuilder(512); GetWindowTextW(h, sb, sb.Capacity); string t = sb.ToString();
            if (tr != null && !tr.IsMatch(t)) return true;
            var cb = new StringBuilder(256); GetClassNameW(h, cb, cb.Capacity); string c = cb.ToString();
            uint pid; GetWindowThreadProcessId(h, out pid);
            string p = "?";
            try { p = Process.GetProcessById((int)pid).ProcessName; } catch { }
            res.Add(new WinInfo { Hwnd = h, Title = t, Cls = c, Pid = pid, Proc = p });
            return true;
        }, IntPtr.Zero);
        return res;
    }

    private static long GetExStyle(IntPtr h)
    {
        if (IntPtr.Size == 8) return GetWindowLongPtr64(h, GWL_EXSTYLE).ToInt64();
        return (uint)GetWindowLong32(h, GWL_EXSTYLE);
    }
    private static bool SetExStyle(IntPtr h, long v)
    {
        if (IntPtr.Size == 8) { SetWindowLongPtr64(h, GWL_EXSTYLE, new IntPtr(v)); return Marshal.GetLastWin32Error() == 0; }
        SetWindowLong32(h, GWL_EXSTYLE, (int)v); return Marshal.GetLastWin32Error() == 0;
    }

    public static string Esc(string s)
    {
        if (s == null) return "";
        var sb = new StringBuilder();
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < 0x20) sb.Append('?');
            else sb.Append(c);
        }
        return sb.ToString();
    }

    private static string TitleOf(IntPtr h)
    {
        var sb = new StringBuilder(512); GetWindowTextW(h, sb, sb.Capacity); return sb.ToString();
    }

    private class Sample { public long T; public int X, Y; public long Fg; }

    // Who actually receives a click at this point right now (first visible
    // top-level window covering it, in z-order top-first), and where the target
    // sits in that same order.
    public static int ZIndexOf(long hwnd)
    {
        var all = TopLevel("");
        for (int i = 0; i < all.Count; i++) if (all[i].Hwnd.ToInt64() == hwnd) return i;
        return -1;
    }

    public static string Preflight(long targetHwnd, int px, int py)
    {
        var all = TopLevel("");
        int zi = -1;
        string tgtProc = "?";
        WinInfo first = null;
        for (int i = 0; i < all.Count; i++)
        {
            var w = all[i];
            if (w.Hwnd.ToInt64() == targetHwnd) { zi = i; tgtProc = w.Proc; }
            if (first == null)
            {
                RECT r;
                if (GetWindowRect(w.Hwnd, out r) && px >= r.L && px < r.R && py >= r.T && py < r.B)
                    first = w;
            }
        }
        var sb = new StringBuilder();
        sb.Append("{\"targetZIndex\":" + zi);
        sb.Append(",\"targetProc\":\"" + Esc(tgtProc) + "\"");
        if (first == null) sb.Append(",\"receiver\":null");
        else
        {
            RECT fr; GetWindowRect(first.Hwnd, out fr);
            sb.Append(",\"receiver\":{\"proc\":\"" + Esc(first.Proc) + "\",\"title\":\"" + Esc(first.Title)
                      + "\",\"hwnd\":" + first.Hwnd.ToInt64() + ",\"rect\":[" + fr.L + "," + fr.T + "," + fr.R + "," + fr.B + "]"
                      + ",\"isTarget\":" + (first.Hwnd.ToInt64() == targetHwnd ? "true" : "false") + "}");
        }
        sb.Append("}");
        return sb.ToString();
    }

    public static string Run(long targetHwnd, string titleRegex, int clickX, int clickY, int clicks,
                             bool setNoActivate, bool keepStyle, bool readOnly, bool raise, bool topmost,
                             bool noPark, string parkProc, string parkClass, string parkTitle,
                             int preMs, int settleMs, int pointerType, int feedbackMode)
    {
        try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { }
        try { SetProcessDPIAware(); } catch { }

        var log = new List<string>();

        WinInfo target = null;
        if (targetHwnd != 0)
        {
            foreach (var w in TopLevel("")) if (w.Hwnd.ToInt64() == targetHwnd) { target = w; break; }
        }
        else
        {
            foreach (var w in TopLevel(titleRegex)) { target = w; break; }
        }
        if (target == null)
            return "{\"ok\":false,\"error\":\"target window not found\"}";

        uint myPid = (uint)Process.GetCurrentProcess().Id;
        bool sameProcess = (target.Pid == myPid);

        long exBefore = GetExStyle(target.Hwnd);
        bool noActBefore = (exBefore & WS_EX_NOACTIVATE) != 0;

        RECT wr; GetWindowRect(target.Hwnd, out wr);
        int tX = clickX, tY = clickY;
        if (tX < 0 || tY < 0) { tX = (wr.L + wr.R) / 2; tY = (wr.T + wr.B) / 2; }

        // ---- park ----
        string parkNote = "not-requested"; long parked = 0;
        if (!noPark && (!string.IsNullOrEmpty(parkProc) || !string.IsNullOrEmpty(parkClass) || !string.IsNullOrEmpty(parkTitle)))
        {
            WinInfo pw = null;
            foreach (var w in TopLevel(parkTitle))
            {
                if (w.Hwnd == target.Hwnd) continue;
                if (!string.IsNullOrEmpty(parkProc) && w.Proc.IndexOf(parkProc, StringComparison.OrdinalIgnoreCase) < 0) continue;
                if (!string.IsNullOrEmpty(parkClass) && w.Cls.IndexOf(parkClass, StringComparison.OrdinalIgnoreCase) < 0) continue;
                pw = w; break;
            }
            if (pw == null) parkNote = "no-park-window-match";
            else
            {
                SetForegroundWindow(pw.Hwnd); Thread.Sleep(150);
                SwitchToThisWindow(pw.Hwnd, true); Thread.Sleep(400);
                parked = pw.Hwnd.ToInt64();
                parkNote = (GetForegroundWindow() == pw.Hwnd) ? "ok" : "failed";
                if (parkNote == "failed")
                {
                    // Windows foreground lock: temporarily share the input queue
                    // with the current foreground thread, then set the foreground.
                    // Setup only - it does not touch the injection path.
                    IntPtr curFg = GetForegroundWindow();
                    uint junkTid;
                    uint fgTid = GetWindowThreadProcessId(curFg, out junkTid);
                    uint myTid2 = GetCurrentThreadId();
                    if (AttachThreadInput(myTid2, fgTid, true))
                    {
                        SetForegroundWindow(pw.Hwnd);
                        BringWindowToTop(pw.Hwnd);
                        Thread.Sleep(300);
                        AttachThreadInput(myTid2, fgTid, false);
                    }
                    Thread.Sleep(200);
                    parkNote = (GetForegroundWindow() == pw.Hwnd) ? "ok-via-attach" : "failed";
                }
            }
        }

        bool raised = false, topApplied = false;
        int zStart = ZIndexOf(target.Hwnd.ToInt64());
        log.Add("zIndex@start=" + zStart);
        if (raise)
        {
            // HWND_TOP=0, SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE = 0x1|0x2|0x10
            raised = SetWindowPos(target.Hwnd, IntPtr.Zero, 0, 0, 0, 0, 0x13);
            Thread.Sleep(250);
            log.Add("SetWindowPos(HWND_TOP,..NOACTIVATE) -> " + raised + ", zIndex@afterRaise=" + ZIndexOf(target.Hwnd.ToInt64()));
        }
        if (topmost)
        {
            // HWND_TOPMOST=-1, SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE|SWP_NOOWNERZORDER
            topApplied = SetWindowPos(target.Hwnd, new IntPtr(-1), 0, 0, 0, 0, 0x13 | 0x200);
            Thread.Sleep(250);
            log.Add("SetWindowPos(HWND_TOPMOST,..NOACTIVATE) -> " + topApplied + ", zIndex@afterTopmost=" + ZIndexOf(target.Hwnd.ToInt64()));
        }
        long fgAfterSetup = GetForegroundWindow().ToInt64();
        log.Add("fg after setup = " + fgAfterSetup + " (setupChangedForeground=" + (fgAfterSetup != parked && parked != 0) + ")");

        var sb0 = new StringBuilder();
        sb0.Append("{\"ok\":true");
        sb0.Append(",\"target\":{\"hwnd\":" + target.Hwnd.ToInt64() + ",\"class\":\"" + Esc(target.Cls)
                   + "\",\"proc\":\"" + Esc(target.Proc) + "\",\"pid\":" + target.Pid
                   + ",\"sameProcess\":" + (sameProcess ? "true" : "false")
                   + ",\"rect\":[" + wr.L + "," + wr.T + "," + wr.R + "," + wr.B + "]}");
        sb0.Append(",\"style\":{\"before\":" + exBefore + ",\"noActivateBefore\":" + (noActBefore ? "true" : "false") + "}");

        if (readOnly)
        {
            sb0.Append(",\"mode\":\"readonly\",\"title\":\"" + Esc(target.Title) + "\"}");
            return sb0.ToString();
        }

        // ---- apply the mitigation (cross-process) ----
        bool applied = false; long exDuring = exBefore; bool readbackOk = true;
        if (setNoActivate && !noActBefore)
        {
            SetExStyle(target.Hwnd, exBefore | WS_EX_NOACTIVATE);
            exDuring = GetExStyle(target.Hwnd);
            applied = (exDuring & WS_EX_NOACTIVATE) != 0;
            readbackOk = applied;
            log.Add("SetWindowLongPtr(GWL_EXSTYLE, 0x" + exBefore.ToString("X") + " | WS_EX_NOACTIVATE) -> readback 0x" + exDuring.ToString("X") + " applied=" + applied);
        }
        else if (setNoActivate && noActBefore)
        {
            log.Add("WS_EX_NOACTIVATE already present; nothing to apply");
        }

        string titleBefore = TitleOf(target.Hwnd);
        POINT c0; GetCursorPos(out c0);
        long fg0 = GetForegroundWindow().ToInt64();
        string fg0t = TitleOf(GetForegroundWindow());

        long fg1 = GetForegroundWindow().ToInt64();
        bool targetWasFg = (fg1 == target.Hwnd.ToInt64());
        log.Add("before inject: fg=" + fg1 + " targetIsFg=" + targetWasFg + " park=" + parkNote);
        string preflight = Preflight(target.Hwnd.ToInt64(), tX, tY);
        log.Add("preflight: " + preflight);

        // ---- sampler ----
        var samples = new List<Sample>();
        bool running = true;
        var th = new Thread(delegate()
        {
            var sw = Stopwatch.StartNew();
            while (running)
            {
                POINT p; GetCursorPos(out p);
                samples.Add(new Sample { T = sw.ElapsedMilliseconds, X = p.X, Y = p.Y, Fg = GetForegroundWindow().ToInt64() });
                Thread.Sleep(2);
            }
        });
        th.IsBackground = true;
        th.Start();
        Thread.Sleep(preMs);

        // ---- inject ----
        long exAtInject = GetExStyle(target.Hwnd);
        bool naAtInject = (exAtInject & WS_EX_NOACTIVATE) != 0;
        log.Add("exStyle right before injection = 0x" + exAtInject.ToString("X") + " noActivate=" + naAtInject);

        IntPtr dev = CreateSyntheticPointerDevice(pointerType, 1, feedbackMode);
        string devNote = dev == IntPtr.Zero ? ("create-failed(err=" + Marshal.GetLastWin32Error() + ")") : "created";
        string injectDetail = "";
        if (dev != IntPtr.Zero)
        {
            uint frame = 1;
            for (int i = 0; i < clicks; i++)
            {
                var dn = Make(pointerType, tX, tY, frame++, POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT | POINTER_FLAG_DOWN | POINTER_FLAG_PRIMARY, true);
                bool okD = InjectSyntheticPointerInput(dev, ref dn, 1);
                Thread.Sleep(90);
                var up = Make(pointerType, tX, tY, frame++, POINTER_FLAG_INRANGE | POINTER_FLAG_UP, false);
                bool okU = InjectSyntheticPointerInput(dev, ref up, 1);
                Thread.Sleep(150);
                injectDetail += "click" + (i + 1) + ":down=" + okD + ",up=" + okU + ";";
            }
            DestroySyntheticPointerDevice(dev);
        }
        log.Add("device=" + devNote + " " + injectDetail + " at " + tX + "," + tY);

        Thread.Sleep(settleMs);
        running = false;
        th.Join(1500);

        string titleAfter = TitleOf(target.Hwnd);
        POINT c1; GetCursorPos(out c1);
        long fg2 = GetForegroundWindow().ToInt64();

        // ---- restore ----
        if (topApplied && !keepStyle)
        {
            // HWND_NOTOPMOST = -2
            SetWindowPos(target.Hwnd, new IntPtr(-2), 0, 0, 0, 0, 0x13 | 0x200);
            Thread.Sleep(200);
            log.Add("SetWindowPos(HWND_NOTOPMOST) restored, zIndex=" + ZIndexOf(target.Hwnd.ToInt64()));
        }

        long exAfter = GetExStyle(target.Hwnd);
        bool restored = false;
        if (applied && !keepStyle)
        {
            SetExStyle(target.Hwnd, exBefore);
            exAfter = GetExStyle(target.Hwnd);
            restored = (exAfter == exBefore);
            log.Add("restored GWL_EXSTYLE -> readback 0x" + exAfter.ToString("X") + " matches original=" + restored);
        }

        int minX = int.MaxValue, maxX = int.MinValue, minY = int.MaxValue, maxY = int.MinValue;
        var fgSeen = new Dictionary<long, int>();
        foreach (var s in samples)
        {
            if (s.X < minX) minX = s.X; if (s.X > maxX) maxX = s.X;
            if (s.Y < minY) minY = s.Y; if (s.Y > maxY) maxY = s.Y;
            if (!fgSeen.ContainsKey(s.Fg)) fgSeen[s.Fg] = 0;
            fgSeen[s.Fg]++;
        }
        long dx = samples.Count == 0 ? -1 : (maxX - minX);
        long dy = samples.Count == 0 ? -1 : (maxY - minY);
        bool fgStable = fgSeen.Count == 1;

        bool clickSeen = !string.Equals(titleBefore, titleAfter, StringComparison.OrdinalIgnoreCase);

        sb0.Append(",\"raised\":" + ((raise && raised) ? "true" : "false"));
        sb0.Append(",\"topmost\":{\"requested\":" + (topmost ? "true" : "false") + ",\"applied\":" + (topApplied ? "true" : "false")
                   + ",\"zStart\":" + zStart + ",\"zNow\":" + ZIndexOf(target.Hwnd.ToInt64())
                   + ",\"fgAfterSetup\":" + fgAfterSetup + "}");
        sb0.Append(",\"preflight\":" + preflight);
        sb0.Append(",\"mitigation\":{\"requested\":" + (setNoActivate ? "true" : "false")
                   + ",\"applied\":" + (applied ? "true" : "false")
                   + ",\"readbackOk\":" + (readbackOk ? "true" : "false")
                   + ",\"during\":" + exDuring + ",\"noActivateDuring\":" + ((exDuring & WS_EX_NOACTIVATE) != 0 ? "true" : "false")
                   + ",\"atInject\":" + exAtInject + ",\"noActivateAtInject\":" + (naAtInject ? "true" : "false")
                   + ",\"restored\":" + (restored ? "true" : "false")
                   + ",\"after\":" + exAfter + ",\"kept\":" + (keepStyle && applied ? "true" : "false") + "}");
        sb0.Append(",\"click\":{\"at\":[" + tX + "," + tY + "],\"clicks\":" + clicks
                   + ",\"pointerType\":" + pointerType + ",\"device\":\"" + Esc(devNote) + "\"}");
        sb0.Append(",\"park\":{\"note\":\"" + parkNote + "\",\"hwnd\":" + parked
                   + ",\"targetWasForeground\":" + (targetWasFg ? "true" : "false")
                   + ",\"conclusive\":" + (targetWasFg ? "false" : "true") + "}");
        sb0.Append(",\"title\":{\"before\":\"" + Esc(titleBefore) + "\",\"after\":\"" + Esc(titleAfter)
                   + "\",\"changed\":" + (clickSeen ? "true" : "false") + "}");
        sb0.Append(",\"cursor\":{\"x0\":" + c0.X + ",\"y0\":" + c0.Y + ",\"x1\":" + c1.X + ",\"y1\":" + c1.Y
                   + ",\"dx\":" + dx + ",\"dy\":" + dy + "}");
        sb0.Append(",\"fg\":{\"before\":" + fg0 + ",\"beforeTitle\":\"" + Esc(fg0t) + "\",\"beforeInject\":" + fg1
                   + ",\"after\":" + fg2 + ",\"stable\":" + (fgStable ? "true" : "false")
                   + ",\"distinctDuringRun\":" + fgSeen.Count + "}");
        sb0.Append(",\"samples\":" + samples.Count);
        sb0.Append(",\"sequence\":[");
        for (int i = 0; i < log.Count; i++) { if (i > 0) sb0.Append(","); sb0.Append("\"").Append(Esc(log[i])).Append("\""); }
        sb0.Append("]}");
        return sb0.ToString();
    }

    private static POINTER_TYPE_INFO Make(int pointerType, int x, int y, uint frame, uint flags, bool down)
    {
        var t = new POINTER_TYPE_INFO();
        t.type = (uint)pointerType;
        t.pen.pi.pointerType = (uint)pointerType;
        t.pen.pi.pointerId = 1;
        t.pen.pi.frameId = frame;
        t.pen.pi.pointerFlags = flags;
        t.pen.pi.pixX = x; t.pen.pi.pixY = y;
        t.pen.pi.pixRawX = x; t.pen.pi.pixRawY = y;
        t.pen.pi.dwTime = (uint)Environment.TickCount;
        t.pen.pi.ButtonChangeType = down ? 1 : 2;
        t.pen.penMask = PEN_MASK_PRESSURE;
        t.pen.pressure = down ? (uint)512 : 0;
        return t;
    }
}
'@

Add-Type -TypeDefinition $cs -Language CSharp

function Write-Utf8NoBom([string]$path, [string]$text) {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $text, $enc)
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

$json = [E4]::Run([long]$TargetHwnd, $TargetTitle, $ClickX, $ClickY, $Clicks,
                   $SetNoActivate.IsPresent, $KeepStyle.IsPresent, $ReadOnly.IsPresent, $Raise.IsPresent, $Topmost.IsPresent,
                   $NoPark.IsPresent, $ParkProc, $ParkClass, $ParkTitle,
                   $PreMs, $SettleMs, $PointerType, $FeedbackMode)

$o = $json | ConvertFrom-Json
if (-not $o.ok) { Write-Output ("FAILED: $json"); return }

if ($ReadOnly) {
    Write-Output ("target   : proc={0} class={1} hwnd={2} sameProcess={3}" -f $o.target.proc, $o.target.class, $o.target.hwnd, $o.target.sameProcess)
    Write-Output ("exStyle  : 0x{0:X}  WS_EX_NOACTIVATE={1}" -f $o.style.before, $o.style.noActivateBefore)
    Write-Output ("title    : {0}" -f $o.title)
    return
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$file = Join-Path $OutDir ("e4-result-$stamp.json")
Write-Utf8NoBom $file $json

Write-Output ("target       : proc={0} class={1} hwnd={2} sameProcess={3}" -f $o.target.proc, $o.target.class, $o.target.hwnd, $o.target.sameProcess)
Write-Output ("style        : before=0x{0:X} atInject=0x{1:X} noActivateAtInject={2} restored={3} after=0x{4:X}" -f `
    $o.style.before, $o.mitigation.atInject, $o.mitigation.noActivateAtInject, $o.mitigation.restored, $o.mitigation.after)
Write-Output ("topmost      : requested={0} applied={1} zStart={2} zNow={3} fgAfterSetup={4}" -f `
    $o.topmost.requested, $o.topmost.applied, $o.topmost.zStart, $o.topmost.zNow, $o.topmost.fgAfterSetup)
Write-Output ("click        : at={0} clicks={1} device={2}" -f ($o.click.at -join ','), $o.click.clicks, $o.click.device)
Write-Output ("park         : note={0} targetWasForeground={1} conclusive={2}" -f $o.park.note, $o.park.targetWasForeground, $o.park.conclusive)
Write-Output ("title        : '{0}'" -f $o.title.before)
Write-Output ("            -> '{0}'   changed={1}" -f $o.title.after, $o.title.changed)
Write-Output ("cursor       : dx={0} dy={1}   ({2},{3}) -> ({4},{5})" -f $o.cursor.dx, $o.cursor.dy, $o.cursor.x0, $o.cursor.y0, $o.cursor.x1, $o.cursor.y1)
Write-Output ("foreground   : stable={0} distinctDuringRun={1} beforeInject={2} after={3}" -f $o.fg.stable, $o.fg.distinctDuringRun, $o.fg.beforeInject, $o.fg.after)
Write-Output ("samples      : {0}" -f $o.samples)
Write-Output ("written: {0}" -f $file)
