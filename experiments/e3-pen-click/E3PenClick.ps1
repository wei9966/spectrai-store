# E3 - Synthetic pen click: does it hit, without moving the cursor or stealing focus?
# ---------------------------------------------------------------------------
# Scope of this script (E3, first half):
#   - create a WITNESS window (owned by this process) whose window TITLE is the
#     readout: hit count + received coordinates. The title is updated through
#     SetWindowText, which works regardless of focus, so no bitmap reading is
#     needed (E1 taught us bitmaps lie for inactive windows).
#   - inject a click with CreateSyntheticPointerDevice(PT_PEN) +
#     InjectSyntheticPointerInput. No SendInput, no mouse_event, no cursor move.
#   - measure: did the witness receive the click, at which coordinates, did the
#     system cursor move, did the foreground window change.
#
# NOT in scope here: installing an IddCx virtual display driver. This machine
# already has two real monitors, so cross-monitor routing is measured on the
# real secondary monitor instead. A virtual (invisible) display is a separate,
# system-level change and is reported, not performed.
#
# Known-good parameter values found by probing this machine:
#   pointerType 3 = PT_PEN (2 = PT_TOUCH also works, 4 = PT_MOUSE always fails)
#   feedback mode 1/2/3 work, 0 is rejected with ERROR_INVALID_PARAMETER (87)
#
# 100% ASCII on purpose (PowerShell 5.1 decodes a BOM-less .ps1 as ANSI).

[CmdletBinding()]
param(
    [ValidateSet('run')]
    [string]$Mode = 'run',

    # witness window rectangle, in virtual-screen pixel coordinates
    [int]$X = 100,
    [int]$Y = 100,
    [int]$W = 700,
    [int]$H = 400,

    # click point, in virtual-screen pixel coordinates.
    # -1 means "centre of the witness window".
    [int]$ClickX = -1,
    [int]$ClickY = -1,

    [int]$Clicks = 1,

    # create the synthetic device with PT_PEN (3) or PT_TOUCH (2)
    [ValidateSet(2,3)]
    [int]$PointerType = 3,

    # 1 = POINTER_FEEDBACK_DEFAULT, 2 = INDIRECT, 3 = NONE
    [ValidateSet(1,2,3)]
    [int]$FeedbackMode = 1,

    # park the foreground on another window before clicking (background target)
    [switch]$NoPark,
    [string]$ParkProc = '',
    [string]$ParkClass = '',
    [string]$ParkTitle = '',

    # create the witness with WS_EX_NOACTIVATE, the standard mitigation for
    # "the click activated the target window"
    [switch]$NoActivate,
    # create it WITHOUT the style and add WS_EX_NOACTIVATE afterwards, to tell
    # "style must be set at creation" apart from "the app re-activates itself"
    [switch]$AddStyleLater,

    # keep the witness window after the run (default: destroy it)
    [switch]$KeepWindow,

    [int]$SettleMs = 600,

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

public static class E3
{
    // ---- window ----
    private delegate IntPtr WndProcD(IntPtr h, uint msg, IntPtr w, IntPtr l);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WNDCLASSEX
    {
        public int cbSize; public uint style; public WndProcD lpfnWndProc;
        public int cbClsExtra; public int cbWndExtra; public IntPtr hInstance;
        public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszMenuName;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszClassName;
        public IntPtr hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int ptX, ptY; }
    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int L, T, R, B; }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern ushort RegisterClassExW(ref WNDCLASSEX wc);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowExW(uint exStyle, string cls, string title, uint style,
        int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport("user32.dll")] private static extern IntPtr DefWindowProcW(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool SetWindowTextW(IntPtr h, string s);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] private static extern bool UpdateWindow(IntPtr h);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] private static extern bool PeekMessageW(out MSG m, IntPtr h, uint min, uint max, uint remove);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG m);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessageW(ref MSG m);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] private static extern void SwitchToThisWindow(IntPtr h, bool altTab);
    [DllImport("user32.dll")] private static extern bool GetPointerInfo(uint id, ref POINTER_INFO pi);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("kernel32.dll")] private static extern IntPtr GetModuleHandleW(string name);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr64(IntPtr h, int i);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] private static extern IntPtr SetWindowLongPtr64(IntPtr h, int i, IntPtr v);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong32(IntPtr h, int i);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] private static extern int SetWindowLong32(IntPtr h, int i, int v);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool AttachThreadInput(uint a, uint b, bool f);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr h);

    // ---- synthetic pointer ----
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr CreateSyntheticPointerDevice(int pointerType, uint maxCount, int mode);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool InjectSyntheticPointerInput(IntPtr dev, ref POINTER_TYPE_INFO info, uint count);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern void DestroySyntheticPointerDevice(IntPtr dev);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINTER_INFO
    {
        public uint pointerType;
        public uint pointerId;
        public uint frameId;
        public uint pointerFlags;
        public IntPtr sourceDevice;
        public IntPtr hwndTarget;
        public int ptPixelLocationX, ptPixelLocationY;
        public int ptHimetricLocationX, ptHimetricLocationY;
        public int ptPixelLocationRawX, ptPixelLocationRawY;
        public int ptHimetricLocationRawX, ptHimetricLocationRawY;
        public uint dwTime;
        public uint historyCount;
        public int InputData;
        public uint dwKeyStates;
        public ulong PerformanceCount;
        public int ButtonChangeType;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PEN_INFO
    {
        public POINTER_INFO pointerInfo;
        public uint penMask;
        public uint pressure;
        public uint rotation;
        public int tiltX, tiltY;
    }

    // The C union is sized by TOUCH_INFO (the bigger member). We only ever fill
    // penInfo, but we over-allocate so the API never reads past our struct.
    [StructLayout(LayoutKind.Sequential)]
    public struct POINTER_TYPE_INFO
    {
        public uint type;
        public PEN_INFO penInfo;
        public ulong pad0, pad1, pad2, pad3, pad4, pad5, pad6, pad7;
    }

    private const uint PT_TOUCH = 2, PT_PEN = 3;
    private const uint POINTER_FLAG_INRANGE = 0x00000002;
    private const uint POINTER_FLAG_INCONTACT = 0x00000004;
    private const uint POINTER_FLAG_PRIMARY = 0x00002000;
    private const uint POINTER_FLAG_DOWN = 0x00010000;
    private const uint POINTER_FLAG_UP = 0x00040000;
    private const uint PEN_MASK_PRESSURE = 0x00000001;

    private const uint WM_DESTROY = 0x0002;
    private const uint WM_LBUTTONDOWN = 0x0201;
    private const uint WM_LBUTTONUP = 0x0202;
    private const uint WM_LBUTTONDBLCLK = 0x0203;
    private const uint WM_RBUTTONDOWN = 0x0204;
    private const uint WM_POINTERDOWN = 0x0246;
    private const uint WM_POINTERUP = 0x0247;
    private const uint WM_POINTERUPDATE = 0x0245;

    private static IntPtr _hwnd = IntPtr.Zero;
    private static int _btnDown = 0, _btnUp = 0, _dbl = 0, _penDown = 0, _penUp = 0, _ptrUpdate = 0;
    private static string _pts = "";


    private static string Title(IntPtr h)
    {
        var sb = new StringBuilder(512); GetWindowTextW(h, sb, sb.Capacity); return sb.ToString();
    }

    private static void Refresh()
    {
        if (_hwnd == IntPtr.Zero) return;
        string t = "E3 down=" + _btnDown + " up=" + _btnUp + " dbl=" + _dbl +
                   " penDN=" + _penDown + " penUP=" + _penUp + " penMV=" + _ptrUpdate +
                   " pts[" + _pts + "]";
        SetWindowTextW(_hwnd, t);
    }

    private static IntPtr WndProc(IntPtr h, uint msg, IntPtr w, IntPtr l)
    {
        switch (msg)
        {
            case WM_LBUTTONDOWN:
                _btnDown++;
                _pts += ((short)(l.ToInt64() & 0xFFFF)) + ":" + ((short)((l.ToInt64() >> 16) & 0xFFFF)) + ";";
                Refresh();
                return IntPtr.Zero;
            case WM_LBUTTONUP:
                _btnUp++; Refresh();
                return IntPtr.Zero;
            case WM_LBUTTONDBLCLK:
                _dbl++; Refresh();
                return IntPtr.Zero;
            case WM_POINTERDOWN:
                _penDown++;
                {
                    long lp = l.ToInt64();
                    int lx = (short)(lp & 0xFFFF), ly = (short)((lp >> 16) & 0xFFFF);
                    string piece = "L" + lx + ":" + ly;
                    var pi = new POINTER_INFO();
                    if (GetPointerInfo((uint)w.ToInt64(), ref pi))
                        piece += "/P" + pi.ptPixelLocationX + ":" + pi.ptPixelLocationY;
                    _pts += piece + ";";
                }
                Refresh();
                return IntPtr.Zero;
            case WM_POINTERUP:
                _penUp++; Refresh();
                return IntPtr.Zero;
            case WM_POINTERUPDATE:
                _ptrUpdate++; Refresh();
                return IntPtr.Zero;
            case WM_DESTROY:
                return IntPtr.Zero;
        }
        return DefWindowProcW(h, msg, w, l);
    }

    private static void Pump(int ms)
    {
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < ms)
        {
            MSG m;
            while (PeekMessageW(out m, IntPtr.Zero, 0, 0, 1))
            {
                TranslateMessage(ref m);
                DispatchMessageW(ref m);
            }
            Thread.Sleep(4);
        }
    }

    private const int GWL_EXSTYLE = -20;
    private const long WS_EX_NOACTIVATE = 0x08000000L;

    private static long GetExStyle(IntPtr h)
    {
        if (IntPtr.Size == 8) return GetWindowLongPtr64(h, GWL_EXSTYLE).ToInt64();
        return (uint)GetWindowLong32(h, GWL_EXSTYLE);
    }
    private static void SetExStyle(IntPtr h, long v)
    {
        if (IntPtr.Size == 8) SetWindowLongPtr64(h, GWL_EXSTYLE, new IntPtr(v));
        else SetWindowLong32(h, GWL_EXSTYLE, (int)v);
    }

    private static void SetDpiAware()
    {
        // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
        try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { }
        try { SetProcessDPIAware(); } catch { }
    }

    public class Sample { public long T; public int X, Y; public long Fg; }

    public static string Run(int x, int y, int w, int h, int clickX, int clickY, int clicks,
                            int pointerType, int feedbackMode,
                            bool noPark, string parkProc, string parkClass, string parkTitle,
                            bool noActivate, bool addStyleLater, bool keepWindow, int settleMs)
    {
        SetDpiAware();
        var log = new List<string>();
        _btnDown = _btnUp = _dbl = _penDown = _penUp = _ptrUpdate = 0;
        _pts = "";

        // ---- witness window ----
        var wc = new WNDCLASSEX();
        wc.cbSize = Marshal.SizeOf(typeof(WNDCLASSEX));
        wc.style = 0;
        wc.lpfnWndProc = WndProc;
        wc.hInstance = GetModuleHandleW(null);
        wc.hbrBackground = new IntPtr(16); // COLOR_WINDOW+1
        wc.lpszClassName = "E3PENWITNESS_" + GetCurrentThreadId();
        ushort atom = RegisterClassExW(ref wc);
        int clsErr = Marshal.GetLastWin32Error();

        uint exStyle = noActivate ? 0x08000000u /*WS_EX_NOACTIVATE*/ : 0u;
        IntPtr hwnd = CreateWindowExW(exStyle, wc.lpszClassName, "E3 witness init",
            /*WS_OVERLAPPEDWINDOW*/ 0x00CF0000, x, y, w, h, IntPtr.Zero, IntPtr.Zero, wc.hInstance, IntPtr.Zero);
        int createErr = Marshal.GetLastWin32Error();
        if (hwnd == IntPtr.Zero)
            return "{\"ok\":false,\"error\":\"CreateWindowExW failed\",\"err\":" + createErr + ",\"classErr\":" + clsErr + "}";
        _hwnd = hwnd;
        long exApplied = 0; bool styleReadback = false;
        if (addStyleLater)
        {
            long before = GetExStyle(hwnd);
            SetExStyle(hwnd, before | WS_EX_NOACTIVATE);
            exApplied = GetExStyle(hwnd);
            styleReadback = ((exApplied & WS_EX_NOACTIVATE) != 0);
            log.Add("created WITHOUT style (0x" + before.ToString("X") + "), added later -> readback 0x" + exApplied.ToString("X") + " ok=" + styleReadback);
        }
        Refresh();

        RECT wr; GetWindowRect(hwnd, out wr);
        RECT cr; GetClientRect(hwnd, out cr);

        POINT c0; GetCursorPos(out c0);
        long fg0 = GetForegroundWindow().ToInt64();
        string fg0t = Title(GetForegroundWindow());

        // foreground of the witness right after showing it
        ShowWindow(hwnd, 5 /*SW_SHOW*/);
        UpdateWindow(hwnd);
        Pump(250);
        long fgAfterShow = GetForegroundWindow().ToInt64();
        log.Add("witness shown: fg after show = " + fgAfterShow + " (witness hwnd=" + hwnd.ToInt64() + ")");

        // ---- optional park so the witness is genuinely background ----
        string parkNote = "not-requested"; long parked = 0;
        if (!noPark && (!string.IsNullOrEmpty(parkProc) || !string.IsNullOrEmpty(parkClass) || !string.IsNullOrEmpty(parkTitle)))
        {
            WinInfo pw = FindFirst(parkTitle, parkClass, parkProc, hwnd);
            if (pw == null) parkNote = "no-park-window-match";
            else
            {
                SetForegroundWindow(pw.Hwnd); Pump(120);
                SwitchToThisWindow(pw.Hwnd, true); Pump(400);
                parked = pw.Hwnd.ToInt64();
                parkNote = (GetForegroundWindow() == pw.Hwnd) ? "ok" : "failed";
            }
        }

        long fg1 = GetForegroundWindow().ToInt64();
        bool witnessWasFg = (fg1 == hwnd.ToInt64());
        log.Add("before inject: fg=" + fg1 + " witnessIsFg=" + witnessWasFg + " park=" + parkNote);

        // ---- target point ----
        int tX = clickX, tY = clickY;
        if (tX < 0 || tY < 0) { tX = (wr.L + wr.R) / 2; tY = (wr.T + wr.B) / 2; }
        log.Add("window rect=" + wr.L + "," + wr.T + "," + wr.R + "," + wr.B + " client=" + cr.R + "x" + cr.B + " clickAt=" + tX + "," + tY);

        // ---- sampler ----
        var samples = new List<Sample>();
        bool running = true;
        var sampler = new Thread(delegate()
        {
            var sw = Stopwatch.StartNew();
            while (running)
            {
                POINT p; GetCursorPos(out p);
                samples.Add(new Sample { T = sw.ElapsedMilliseconds, X = p.X, Y = p.Y, Fg = GetForegroundWindow().ToInt64() });
                Thread.Sleep(2);
            }
        });
        sampler.IsBackground = true;
        sampler.Start();

        // ---- synthetic pointer device ----
        IntPtr dev = CreateSyntheticPointerDevice(pointerType, 1, feedbackMode);
        int devErr = Marshal.GetLastWin32Error();
        string devNote = dev == IntPtr.Zero ? ("create-failed(err=" + devErr + ")") : "created";
        log.Add("CreateSyntheticPointerDevice(type=" + pointerType + ",mode=" + feedbackMode + ") -> " + devNote);

        string injectDetail = "";
        if (dev != IntPtr.Zero)
        {
            uint frame = 1;
            for (int i = 0; i < clicks; i++)
            {
                var down = MakeInfo(pointerType, tX, tY, frame++, POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT | POINTER_FLAG_DOWN | POINTER_FLAG_PRIMARY, true);
                bool okD = InjectSyntheticPointerInput(dev, ref down, 1);
                int eD = Marshal.GetLastWin32Error();
                Pump(80);
                var up = MakeInfo(pointerType, tX, tY, frame++, POINTER_FLAG_INRANGE | POINTER_FLAG_UP, false);
                bool okU = InjectSyntheticPointerInput(dev, ref up, 1);
                int eU = Marshal.GetLastWin32Error();
                Pump(120);
                injectDetail += "click" + (i + 1) + ":down=" + okD + "(e" + eD + "),up=" + okU + "(e" + eU + ");";
            }
            log.Add(injectDetail);
            DestroySyntheticPointerDevice(dev);
        }

        Pump(settleMs);
        running = false;
        sampler.Join(1000);

        POINT c1; GetCursorPos(out c1);
        long fg2 = GetForegroundWindow().ToInt64();
        string titleAfter = Title(hwnd);
        _hwnd = IntPtr.Zero;

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

        int closedErr = 0;
        if (!keepWindow) { DestroyWindow(hwnd); closedErr = Marshal.GetLastWin32Error(); }

        bool hit = _btnDown > 0 || _penDown > 0;

        var sb = new StringBuilder();
        sb.Append("{\"ok\":true");
        sb.Append(",\"config\":{\"witness\":[" + x + "," + y + "," + w + "," + h + "]");
        sb.Append(",\"windowRect\":[" + wr.L + "," + wr.T + "," + wr.R + "," + wr.B + "]");
        sb.Append(",\"clientSize\":[" + cr.R + "," + cr.B + "]");
        sb.Append(",\"clickAt\":[" + tX + "," + tY + "],\"clicks\":" + clicks);
        sb.Append(",\"pointerType\":" + pointerType + ",\"feedbackMode\":" + feedbackMode
                  + ",\"exStyle\":\"" + (noActivate ? "WS_EX_NOACTIVATE@create" : (addStyleLater ? ("WS_EX_NOACTIVATE@later(ok=" + styleReadback + ")") : "0")) + "\"}");
        sb.Append(",\"device\":\"" + devNote + "\",\"inject\":\"" + Esc(injectDetail) + "\"");
        sb.Append(",\"park\":{\"note\":\"" + parkNote + "\",\"hwnd\":" + parked
                  + ",\"witnessWasForeground\":" + (witnessWasFg ? "true" : "false")
                  + ",\"conclusive\":" + (witnessWasFg ? "false" : "true") + "}");
        sb.Append(",\"witness\":{\"down\":" + _btnDown + ",\"up\":" + _btnUp + ",\"dbl\":" + _dbl
                  + ",\"penDown\":" + _penDown + ",\"penUp\":" + _penUp + ",\"penMove\":" + _ptrUpdate
                  + ",\"pts\":\"" + Esc(_pts) + "\",\"hit\":" + (hit ? "true" : "false")
                  + ",\"titleAfter\":\"" + Esc(titleAfter) + "\"}");
        sb.Append(",\"cursor\":{\"x0\":" + c0.X + ",\"y0\":" + c0.Y + ",\"x1\":" + c1.X + ",\"y1\":" + c1.Y
                  + ",\"dx\":" + dx + ",\"dy\":" + dy + "}");
        sb.Append(",\"fg\":{\"beforePark\":" + fg0 + ",\"afterShow\":" + fgAfterShow + ",\"beforeInject\":" + fg1
                  + ",\"after\":" + fg2 + ",\"stable\":" + (fgStable ? "true" : "false")
                  + ",\"distinctDuringRun\":" + fgSeen.Count + ",\"beforeTitle\":\"" + Esc(fg0t) + "\"}");
        sb.Append(",\"samples\":" + samples.Count);
        sb.Append(",\"sequence\":[");
        for (int i = 0; i < log.Count; i++) { if (i > 0) sb.Append(","); sb.Append("\"").Append(Esc(log[i])).Append("\""); }
        sb.Append("]}");
        return sb.ToString();
    }

    private static POINTER_TYPE_INFO MakeInfo(int pointerType, int x, int y, uint frame, uint flags, bool down)
    {
        var t = new POINTER_TYPE_INFO();
        t.type = (uint)pointerType;
        t.penInfo.pointerInfo.pointerType = (uint)pointerType;
        t.penInfo.pointerInfo.pointerId = 1;
        t.penInfo.pointerInfo.frameId = frame;
        t.penInfo.pointerInfo.pointerFlags = flags;
        t.penInfo.pointerInfo.ptPixelLocationX = x;
        t.penInfo.pointerInfo.ptPixelLocationY = y;
        t.penInfo.pointerInfo.ptPixelLocationRawX = x;
        t.penInfo.pointerInfo.ptPixelLocationRawY = y;
        t.penInfo.pointerInfo.dwTime = (uint)Environment.TickCount;
        t.penInfo.pointerInfo.ButtonChangeType = down ? 1 : 2;
        t.penInfo.penMask = PEN_MASK_PRESSURE;
        t.penInfo.pressure = down ? (uint)512 : 0;
        return t;
    }

    public class WinInfo { public IntPtr Hwnd; public string Title; public string Cls; public uint Pid; public string Proc; }

    private delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr h, StringBuilder sb, int max);

    private static WinInfo FindFirst(string titleRegex, string classRegex, string procRegex, IntPtr exclude)
    {
        WinInfo found = null;
        var tr = Rx(titleRegex); var cr = Rx(classRegex); var pr = Rx(procRegex);
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            if (h == exclude || !IsWindowVisible(h)) return true;
            var sb = new StringBuilder(256); GetWindowTextW(h, sb, sb.Capacity); string t = sb.ToString();
            var cb = new StringBuilder(256); GetClassNameW(h, cb, cb.Capacity); string c = cb.ToString();
            if (tr != null && !tr.IsMatch(t)) return true;
            if (cr != null && !cr.IsMatch(c)) return true;
            uint pid; GetWindowThreadProcessId(h, out pid);
            string p = "?";
            try { p = Process.GetProcessById((int)pid).ProcessName; } catch { }
            if (pr != null && !pr.IsMatch(p)) return true;
            found = new WinInfo { Hwnd = h, Title = t, Cls = c, Pid = pid, Proc = p };
            return false;
        }, IntPtr.Zero);
        return found;
    }

    private static System.Text.RegularExpressions.Regex Rx(string p)
    {
        return string.IsNullOrEmpty(p) ? null
            : new System.Text.RegularExpressions.Regex(p, System.Text.RegularExpressions.RegexOptions.IgnoreCase);
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

    public static string SizeInfo()
    {
        return "{\"POINTER_INFO\":" + Marshal.SizeOf(typeof(POINTER_INFO))
             + ",\"PEN_INFO\":" + Marshal.SizeOf(typeof(PEN_INFO))
             + ",\"POINTER_TYPE_INFO\":" + Marshal.SizeOf(typeof(POINTER_TYPE_INFO)) + "}";
    }
}
'@

Add-Type -TypeDefinition $cs -Language CSharp

function Write-Utf8NoBom([string]$path, [string]$text) {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $text, $enc)
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

$json = [E3]::Run($X, $Y, $W, $H, $ClickX, $ClickY, $Clicks, $PointerType, $FeedbackMode,
                   $NoPark.IsPresent, $ParkProc, $ParkClass, $ParkTitle,
                   $NoActivate.IsPresent, $AddStyleLater.IsPresent, $KeepWindow.IsPresent, $SettleMs)

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$file = Join-Path $OutDir ("e3-result-$stamp.json")
Write-Utf8NoBom $file $json

$o = $json | ConvertFrom-Json
if (-not $o.ok) {
    Write-Output ("FAILED: {0}" -f $json)
} else {
    Write-Output ("witness      : rect={0} client={1}" -f ($o.config.windowRect -join ','), ($o.config.clientSize -join 'x'))
    Write-Output ("clickAt      : {0}   clicks={1}  type={2} mode={3}" -f ($o.config.clickAt -join ','), $o.config.clicks, $o.config.pointerType, $o.config.feedbackMode)
    Write-Output ("device       : {0}   exStyle={1}" -f $o.device, $o.config.exStyle)
    Write-Output ("inject       : {0}" -f $o.inject)
    Write-Output ("park         : note={0} witnessWasForeground={1} conclusive={2}" -f $o.park.note, $o.park.witnessWasForeground, $o.park.conclusive)
    Write-Output ("witness hits : hit={0}  down={1} up={2} dbl={3}  penDN={4} penUP={5} penMV={6}" -f $o.witness.hit, $o.witness.down, $o.witness.up, $o.witness.dbl, $o.witness.penDown, $o.witness.penUp, $o.witness.penMove)
    Write-Output ("witness pts  : {0}" -f $o.witness.pts)
    Write-Output ("cursor       : dx={0} dy={1}   ({2},{3}) -> ({4},{5})" -f $o.cursor.dx, $o.cursor.dy, $o.cursor.x0, $o.cursor.y0, $o.cursor.x1, $o.cursor.y1)
    Write-Output ("foreground   : stable={0} distinctDuringRun={1} beforeInject={2} after={3}" -f $o.fg.stable, $o.fg.distinctDuringRun, $o.fg.beforeInject, $o.fg.after)
    Write-Output ("samples      : {0}" -f $o.samples)
}
Write-Output ("written: {0}" -f $file)
