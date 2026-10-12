# E1 - Focus spoofing / background typing feasibility probe  (v2)
# ---------------------------------------------------------------------------
# Question (E1): can text be delivered into a NON-foreground window's input
# control using messages only, while the user's foreground window and the
# mouse cursor stay untouched?
#
# Method: pure message spoofing. No DLL injection, no global hooks, no
# AttachThreadInput, no SendInput, no cursor movement.
#
#   optional activation sequence (default ON):
#       top-level : WM_NCACTIVATE(TRUE) + WM_ACTIVATE(WA_ACTIVE)
#       input ctl : WM_SETFOCUS
#   char delivery (see -CharMode):
#       char    : WM_CHAR only                <- correct for standard controls
#       keydown : WM_KEYDOWN only             <- target does TranslateMessage
#       both    : WM_KEYDOWN + WM_CHAR        <- v1 behaviour, double-inserts
#
# Measurements:
#   - cursor position + GetForegroundWindow sampled every ~1 ms
#     (timeBeginPeriod(1) is raised only for the duration of the run)
#   - control text before / after via WM_GETTEXT (marshalled => cross-process)
#   - optional PrintWindow bitmap diff of the target window, which is the
#     only readout available for Chromium/Electron content (no WM_GETTEXT)
#
# Success criteria (E1):
#   text arrived AND foreground unchanged for every sample
#   AND max cursor displacement == 0
#
# Usage:
#   ... -Mode list -TargetProc 'notepad|SodaMusic|SpectrAI'
#   ... -Mode run  -TargetProc notepad -ChildClass '^Edit$'
#   ... -Mode run  -TargetProc SodaMusic -ChildClass '^Chrome_RenderWidgetHostHWND$' -Snapshot
#
# This file is deliberately 100% ASCII: PowerShell 5.1 decodes a BOM-less
# .ps1 using the ANSI code page, so non-ASCII literals here would corrupt
# parsing. Window titles (which may be CJK) are only written to a UTF-8 JSON
# file, never kept as script source.

[CmdletBinding()]
param(
    [ValidateSet('list','run')]
    [string]$Mode = 'run',

    [string]$TargetTitle = '',
    [string]$TargetClass = '',
    [string]$TargetProc = '',

    # regex matched against descendant class names -> the input control
    [string]$ChildClass = '^(Edit|RichEdit|Chrome_RenderWidgetHostHWND)$',

    # prefer this child class when several descendants match
    [string]$PreferChild = 'Chrome_RenderWidgetHostHWND',

    # select the target by exact top-level hwnd (avoids passing CJK titles on
    # the command line, where PowerShell 5.1 would mangle them)
    [int]$TargetHwnd = 0,

    # post directly to this exact child hwnd (disambiguates when several
    # descendants share the same class, e.g. multiple RenderWidgetHostHWNDs)
    [int]$InjectHwnd = 0,

    # 'child' posts to the matched descendant control; 'self' posts to the
    # top-level window itself (newer Chromium hosts the render widget there)
    [ValidateSet('child','self')]
    [string]$InjectTo = 'child',

    [string]$Text = 'E1-FOCUS-SPOOF-TEST-0123456789',

    [ValidateSet('char','keydown','both')]
    [string]$CharMode = 'char',

    # bring a DIFFERENT window to the foreground before the run, so the target
    # is genuinely a background window. Verified via GetForegroundWindow; if the
    # park fails the run is marked inconclusive instead of silently measuring
    # an already-foreground target.
    [switch]$NoPark,
    [string]$ParkProc = '',
    [string]$ParkClass = '',
    [string]$ParkTitle = '',

    # control run: deliberately bring the TARGET itself to the foreground, so the
    # same injection path can be compared foreground vs background
    [switch]$ParkSelf,

    [switch]$NoSpoof,
    [switch]$Snapshot,

    [int]$PreMs = 800,
    [int]$PerCharMs = 12,
    [int]$SettleMs = 500,

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

public static class E1
{
    private const uint WM_KEYDOWN       = 0x0100;
    private const uint WM_CHAR          = 0x0102;
    private const uint WM_GETTEXTLENGTH = 0x000E;
    private const uint WM_GETTEXT       = 0x000D;
    private const uint WM_NCACTIVATE    = 0x0086;
    private const uint WM_ACTIVATE      = 0x0006;
    private const uint WM_SETFOCUS      = 0x0007;
    private const uint PW_RENDERFULLCONTENT = 0x00000002;

    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageW(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")]
    private static extern IntPtr SendMessageStr(IntPtr hWnd, uint msg, IntPtr w, StringBuilder l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern short VkKeyScanW(char c);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);
    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
    [DllImport("gdi32.dll")]
    private static extern IntPtr SelectObject(IntPtr hdc, IntPtr h);
    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr h);
    [DllImport("gdi32.dll")]
    private static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")]
    private static extern int GetDIBits(IntPtr hdc, IntPtr hbm, uint start, uint lines, byte[] bits, ref BITMAPINFO bmi, uint usage);
    [DllImport("winmm.dll")]
    private static extern uint timeBeginPeriod(uint ms);
    [DllImport("winmm.dll")]
    private static extern uint timeEndPeriod(uint ms);
    [DllImport("user32.dll")]
    private static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern IntPtr SetActiveWindow(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFOHEADER
    {
        public uint biSize; public int biWidth; public int biHeight;
        public ushort biPlanes; public ushort biBitCount; public uint biCompression;
        public uint biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter;
        public uint biClrUsed; public uint biClrImportant;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFO { public BITMAPINFOHEADER h; public uint c1; public uint c2; public uint c3; }

    private static string Title(IntPtr h)
    {
        var sb = new StringBuilder(512); GetWindowTextW(h, sb, sb.Capacity); return sb.ToString();
    }
    private static string Cls(IntPtr h)
    {
        var sb = new StringBuilder(256); GetClassNameW(h, sb, sb.Capacity); return sb.ToString();
    }
    private static string ProcName(uint pid)
    {
        try { return Process.GetProcessById((int)pid).ProcessName; } catch { return "?"; }
    }
    private static string ControlText(IntPtr h)
    {
        int len = (int)SendMessageW(h, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero);
        if (len <= 0) return "";
        var sb = new StringBuilder(len + 2);
        SendMessageStr(h, WM_GETTEXT, (IntPtr)(len + 1), sb);
        return sb.ToString();
    }

    public class WinInfo
    {
        public IntPtr Hwnd; public string Title; public string Cls; public uint Pid; public string Proc;
    }

    private static System.Text.RegularExpressions.Regex Rx(string p)
    {
        return string.IsNullOrEmpty(p) ? null
            : new System.Text.RegularExpressions.Regex(p, System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    }

    public static List<WinInfo> TopLevel(string titleRegex, string classRegex, string procRegex)
    {
        var res = new List<WinInfo>();
        var tr = Rx(titleRegex); var cr = Rx(classRegex); var pr = Rx(procRegex);
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            string t = Title(h), c = Cls(h);
            if (tr != null && !tr.IsMatch(t)) return true;
            if (cr != null && !cr.IsMatch(c)) return true;
            uint pid; GetWindowThreadProcessId(h, out pid);
            string p = ProcName(pid);
            if (pr != null && !pr.IsMatch(p)) return true;
            res.Add(new WinInfo { Hwnd = h, Title = t, Cls = c, Pid = pid, Proc = p });
            return true;
        }, IntPtr.Zero);
        return res;
    }

    public static List<WinInfo> Children(IntPtr root, string classRegex)
    {
        var res = new List<WinInfo>();
        var cr = Rx(classRegex);
        EnumChildWindows(root, delegate(IntPtr h, IntPtr l)
        {
            string c = Cls(h);
            if (cr == null || cr.IsMatch(c))
            {
                uint pid; GetWindowThreadProcessId(h, out pid);
                res.Add(new WinInfo { Hwnd = h, Title = Title(h), Cls = c, Pid = pid, Proc = ProcName(pid) });
            }
            return true;
        }, IntPtr.Zero);
        return res;
    }

    // ---------------- sampling ----------------

    private class Sample { public long T; public int X; public int Y; public long Fg; }
    private static List<Sample> _samples = new List<Sample>();
    private static volatile bool _running;
    private static Thread _sampler;
    private static readonly object _lock = new object();

    private static void SamplerLoop()
    {
        var sw = Stopwatch.StartNew();
        while (_running)
        {
            POINT p; GetCursorPos(out p);
            var s = new Sample { T = sw.ElapsedMilliseconds, X = p.X, Y = p.Y, Fg = GetForegroundWindow().ToInt64() };
            lock (_lock) { _samples.Add(s); }
            Thread.Sleep(1);
        }
    }

    public static string Esc(string s)
    {
        if (s == null) return "";
        var sb = new StringBuilder();
        foreach (char c in s)
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\t') sb.Append("\\t");
            else if (c < 0x20) sb.Append('?');
            else sb.Append(c);
        }
        return sb.ToString();
    }

    // ---------------- bitmap diff (Chromium readout) ----------------

    private static byte[] Grab(IntPtr hwnd, out int w, out int h)
    {
        w = 0; h = 0;
        RECT r;
        if (!GetWindowRect(hwnd, out r)) return null;
        w = r.Right - r.Left; h = r.Bottom - r.Top;
        if (w <= 0 || h <= 0 || w > 8000 || h > 8000) { w = 0; h = 0; return null; }
        IntPtr screenDc = GetDC(IntPtr.Zero);
        IntPtr memDc = CreateCompatibleDC(screenDc);
        IntPtr bmp = CreateCompatibleBitmap(screenDc, w, h);
        IntPtr old = SelectObject(memDc, bmp);
        bool ok = PrintWindow(hwnd, memDc, PW_RENDERFULLCONTENT);
        var bits = new byte[w * h * 4];
        if (ok)
        {
            var bmi = new BITMAPINFO();
            bmi.h.biSize = (uint)Marshal.SizeOf(typeof(BITMAPINFOHEADER));
            bmi.h.biWidth = w; bmi.h.biHeight = -h;   // top-down
            bmi.h.biPlanes = 1; bmi.h.biBitCount = 32; bmi.h.biCompression = 0;
            GetDIBits(memDc, bmp, 0, (uint)h, bits, ref bmi, 0);
        }
        SelectObject(memDc, old);
        DeleteObject(bmp);
        DeleteDC(memDc);
        ReleaseDC(IntPtr.Zero, screenDc);
        if (!ok) { w = 0; h = 0; return null; }
        return bits;
    }

    private static string DiffJson(byte[] a, byte[] b, int w, int h)
    {
        if (a == null || b == null || a.Length != b.Length)
            return "{\"available\":false}";
        long changed = 0;
        int x0 = int.MaxValue, y0 = int.MaxValue, x1 = -1, y1 = -1;
        for (int y = 0; y < h; y++)
        {
            for (int x = 0; x < w; x++)
            {
                int i = (y * w + x) * 4;
                int d = Math.Abs(a[i] - b[i]) + Math.Abs(a[i + 1] - b[i + 1]) + Math.Abs(a[i + 2] - b[i + 2]);
                if (d > 30)
                {
                    changed++;
                    if (x < x0) x0 = x; if (x > x1) x1 = x;
                    if (y < y0) y0 = y; if (y > y1) y1 = y;
                }
            }
        }
        var sb = new StringBuilder();
        sb.Append("{\"available\":true,\"w\":" + w + ",\"h\":" + h + ",\"changedPixels\":" + changed
                  + ",\"changedRatio\":" + Math.Round((double)changed / (w * (double)h), 6).ToString(System.Globalization.CultureInfo.InvariantCulture));
        if (x1 >= 0) sb.Append(",\"box\":{\"x\":" + x0 + ",\"y\":" + y0 + ",\"x2\":" + x1 + ",\"y2\":" + y1 + "}");
        sb.Append("}");
        return sb.ToString();
    }

    // ---------------- main ----------------

    public static string Run(string titleRegex, string classRegex, string procRegex, string childRegex,
                             string preferChild, string text, string charMode,
                             int preMs, int perCharMs, int settleMs, bool noSpoof, bool snapshot,
                             bool noPark, string parkProc, string parkClass, string parkTitle,
                             long targetHwnd, string injectTo, bool parkSelf, long injectHwnd)
    {
        var log = new List<string>();

        WinInfo top = null; List<WinInfo> cands = new List<WinInfo>(); WinInfo chosen = null;

        if (targetHwnd != 0)
        {
            foreach (var w in TopLevel("", "", ""))
                if (w.Hwnd.ToInt64() == targetHwnd) { top = w; break; }
            if (top == null)
                return "{\"ok\":false,\"error\":\"hwnd not found among visible top-level windows\",\"hwnd\":" + targetHwnd + "}";
            cands = Children(top.Hwnd, childRegex);
            if (injectHwnd != 0)
            {
                IntPtr ih = new IntPtr(injectHwnd);
                chosen = new WinInfo { Hwnd = ih, Cls = Cls(ih), Title = Title(ih), Pid = top.Pid, Proc = top.Proc };
                cands.Insert(0, chosen);
            }
            else if (injectTo == "self")
            {
                chosen = new WinInfo { Hwnd = top.Hwnd, Title = top.Title, Cls = top.Cls, Pid = top.Pid, Proc = top.Proc };
                cands.Insert(0, chosen);
            }
            else if (cands.Count > 0)
            {
                chosen = cands[0];
                var pr0 = Rx(preferChild);
                if (pr0 != null) foreach (var c in cands) { if (pr0.IsMatch(c.Cls)) { chosen = c; break; } }
            }
            else return "{\"ok\":false,\"error\":\"no descendant input control matched\"}";
        }
        else
        {
            var tops = TopLevel(titleRegex, classRegex, procRegex);
            if (tops.Count == 0)
                return "{\"ok\":false,\"error\":\"target top-level window not found\"}";
            foreach (var w in tops)
            {
                var ch = Children(w.Hwnd, childRegex);
                if (ch.Count > 0) { top = w; cands = ch; break; }
            }
            if (top == null) { top = tops[0]; cands = Children(top.Hwnd, childRegex); }
            if (cands.Count == 0)
                return "{\"ok\":false,\"error\":\"no descendant input control matched\",\"topClass\":\"" + Esc(top.Cls) + "\"}";
            chosen = cands[0];
            var pr = Rx(preferChild);
            if (pr != null)
                foreach (var c in cands) { if (pr.IsMatch(c.Cls)) { chosen = c; break; } }
        }

        IntPtr ctl = chosen.Hwnd;

        // ---- park: move the foreground away from the target ----
        long parked = 0; string parkNote = "not-requested";
        if (parkSelf)
        {
            SetForegroundWindow(top.Hwnd);
            Thread.Sleep(120);
            SwitchToThisWindow(top.Hwnd, true);
            Thread.Sleep(350);
            parked = top.Hwnd.ToInt64();
            parkNote = (GetForegroundWindow() == top.Hwnd) ? "self-ok" : "self-failed";
        }
        else if (!noPark && (!string.IsNullOrEmpty(parkProc) || !string.IsNullOrEmpty(parkClass) || !string.IsNullOrEmpty(parkTitle)))
        {
            var parks = TopLevel(parkTitle, parkClass, parkProc);
            WinInfo pw = null;
            foreach (var c in parks) { if (c.Hwnd != top.Hwnd) { pw = c; break; } }
            if (pw == null) { parkNote = "no-park-window-match"; }
            else
            {
                SetForegroundWindow(pw.Hwnd);
                Thread.Sleep(120);
                if (GetForegroundWindow() != pw.Hwnd)
                {
                    BringWindowToTop(pw.Hwnd);
                    SwitchToThisWindow(pw.Hwnd, true);
                    Thread.Sleep(120);
                }
                SwitchToThisWindow(pw.Hwnd, true);
                Thread.Sleep(350);
                parked = pw.Hwnd.ToInt64();
                parkNote = (GetForegroundWindow() == pw.Hwnd) ? "ok" : "failed";
            }
        }

        POINT c0; GetCursorPos(out c0);
        IntPtr fgH0 = GetForegroundWindow();
        long fg0 = fgH0.ToInt64();
        string fg0t = Title(fgH0);
        string before = ControlText(ctl);
        bool readoutAvailable = chosen.Cls.IndexOf("Chrome", StringComparison.OrdinalIgnoreCase) < 0;

        int bw = 0, bh = 0;
        byte[] shot0 = snapshot ? Grab(top.Hwnd, out bw, out bh) : null;

        timeBeginPeriod(1);
        _samples = new List<Sample>();
        _running = true;
        _sampler = new Thread(SamplerLoop) { IsBackground = true };
        _sampler.Start();

        Thread.Sleep(preMs);

        if (!noSpoof)
        {
            log.Add("WM_NCACTIVATE(top,TRUE) -> " + SendMessageW(top.Hwnd, WM_NCACTIVATE, (IntPtr)1, IntPtr.Zero).ToInt64());
            log.Add("WM_ACTIVATE(top,WA_ACTIVE) -> " + SendMessageW(top.Hwnd, WM_ACTIVATE, (IntPtr)1, IntPtr.Zero).ToInt64());
            log.Add("WM_SETFOCUS(ctl) -> " + SendMessageW(ctl, WM_SETFOCUS, IntPtr.Zero, IntPtr.Zero).ToInt64());
        }

        int sent = 0;
        foreach (char c in text)
        {
            if (charMode == "char" || charMode == "both")
                PostMessageW(ctl, WM_CHAR, (IntPtr)c, IntPtr.Zero);
            if (charMode == "keydown" || charMode == "both")
            {
                short vk = VkKeyScanW(c);
                PostMessageW(ctl, WM_KEYDOWN, (IntPtr)(vk & 0xFF), IntPtr.Zero);
            }
            sent++;
            if (perCharMs > 0) Thread.Sleep(perCharMs);
        }

        Thread.Sleep(settleMs);
        _running = false;
        _sampler.Join(2000);
        timeEndPeriod(1);

        string after = ControlText(ctl);
        POINT c1; GetCursorPos(out c1);
        long fg1 = GetForegroundWindow().ToInt64();
        string diffJson = "{\"available\":false}";
        if (snapshot)
        {
            int aw = 0, ah = 0;
            byte[] shot1 = Grab(top.Hwnd, out aw, out ah);
            if (aw == bw && ah == bh) diffJson = DiffJson(shot0, shot1, bw, bh);
        }

        int minX = int.MaxValue, maxX = int.MinValue, minY = int.MaxValue, maxY = int.MinValue;
        var fgSeen = new Dictionary<long, int>();
        var snap = new List<Sample>();
        lock (_lock) { snap.AddRange(_samples); }
        foreach (var s in snap)
        {
            if (s.X < minX) minX = s.X; if (s.X > maxX) maxX = s.X;
            if (s.Y < minY) minY = s.Y; if (s.Y > maxY) maxY = s.Y;
            if (!fgSeen.ContainsKey(s.Fg)) fgSeen[s.Fg] = 0;
            fgSeen[s.Fg]++;
        }
        long dx = (maxX == int.MinValue) ? -1 : (maxX - minX);
        long dy = (maxY == int.MinValue) ? -1 : (maxY - minY);
        bool fgStable = (fgSeen.Count == 1 && fgSeen.ContainsKey(fg0));

        string arrived = (after.Length > before.Length) ? after.Substring(before.Length) : "";
        bool textArrived = (after.Length == before.Length + text.Length && arrived == text);
        bool textPartial = (after.Length > before.Length && !textArrived);

        long minT = long.MaxValue, maxT = long.MinValue;
        foreach (var s in snap) { if (s.T < minT) minT = s.T; if (s.T > maxT) maxT = s.T; }

        var sb = new StringBuilder();
        sb.Append("{\"ok\":true");
        sb.Append(",\"target\":{\"title\":\"").Append(Esc(top.Title)).Append("\",\"class\":\"").Append(Esc(top.Cls))
          .Append("\",\"proc\":\"").Append(Esc(top.Proc)).Append("\",\"pid\":" + top.Pid + ",\"hwnd\":" + top.Hwnd.ToInt64()).Append("}");
        sb.Append(",\"control\":{\"class\":\"").Append(Esc(chosen.Cls)).Append("\",\"hwnd\":" + ctl.ToInt64()).Append(",\"candidates\":" + cands.Count + "}");
        bool targetWasFg = (fg0 == top.Hwnd.ToInt64());
        sb.Append(",\"park\":{\"note\":\"").Append(Esc(parkNote)).Append("\",\"hwnd\":" + parked
                  + ",\"targetWasForeground\":" + (targetWasFg ? "true" : "false")
                  + ",\"conclusive\":" + (targetWasFg ? "false" : "true") + "}");
        sb.Append(",\"payload\":\"").Append(Esc(text)).Append("\",\"charsSent\":" + sent + ",\"charMode\":\"" + Esc(charMode) + "\"");
        sb.Append(",\"readout\":{\"wmGetText\":").Append(readoutAvailable ? "true" : "false")
          .Append(",\"beforeLen\":" + before.Length + ",\"afterLen\":" + after.Length + "}");
        sb.Append(",\"arrivedText\":\"").Append(Esc(arrived.Length > 200 ? arrived.Substring(0, 200) : arrived)).Append("\"");
        sb.Append(",\"textArrived\":" + (textArrived ? "true" : "false"));
        sb.Append(",\"textPartial\":" + (textPartial ? "true" : "false"));
        sb.Append(",\"snapshotDiff\":" + diffJson);
        sb.Append(",\"cursor\":{\"x0\":" + c0.X + ",\"y0\":" + c0.Y + ",\"x1\":" + c1.X + ",\"y1\":" + c1.Y + ",\"dx\":" + dx + ",\"dy\":" + dy + "}");
        sb.Append(",\"fg\":{\"before\":" + fg0 + ",\"after\":" + fg1 + ",\"beforeTitle\":\"").Append(Esc(fg0t))
          .Append("\",\"distinctDuringRun\":" + fgSeen.Count + ",\"stable\":" + (fgStable ? "true" : "false") + "}");
        sb.Append(",\"samples\":" + snap.Count + ",\"sampleSpanMs\":[" + (minT == long.MaxValue ? 0 : minT) + "," + (maxT == long.MinValue ? 0 : maxT) + "]");
        sb.Append(",\"spoofed\":" + (noSpoof ? "false" : "true"));
        sb.Append(",\"sequence\":[");
        for (int i = 0; i < log.Count; i++) { if (i > 0) sb.Append(","); sb.Append("\"").Append(Esc(log[i])).Append("\""); }
        sb.Append("],\"samplesDetail\":[");
        for (int i = 0; i < snap.Count; i++)
        {
            if (i > 0) sb.Append(",");
            sb.Append("{\"t\":" + snap[i].T + ",\"x\":" + snap[i].X + ",\"y\":" + snap[i].Y + ",\"fg\":" + snap[i].Fg + "}");
        }
        sb.Append("]}");
        return sb.ToString();
    }

    public static string WindowListJson(string titleRegex, string classRegex, string procRegex, string childRegex)
    {
        var sb = new StringBuilder();
        var tops = TopLevel(titleRegex, classRegex, procRegex);
        sb.Append("{\"count\":" + tops.Count + ",\"windows\":[");
        for (int i = 0; i < tops.Count; i++)
        {
            var w = tops[i];
            if (i > 0) sb.Append(",");
            sb.Append("{\"hwnd\":" + w.Hwnd.ToInt64() + ",\"class\":\"" + Esc(w.Cls) + "\",\"proc\":\"" + Esc(w.Proc)
              + "\",\"pid\":" + w.Pid + ",\"title\":\"" + Esc(w.Title) + "\",\"rect\":\"");
            RECT rr;
            if (GetWindowRect(w.Hwnd, out rr))
                sb.Append(rr.Left + "," + rr.Top + "," + rr.Right + "," + rr.Bottom + "\"");
            else sb.Append("?\"");
            sb.Append(",\"children\":[");
            var kids = Children(w.Hwnd, childRegex);
            for (int k = 0; k < kids.Count; k++)
            {
                if (k > 0) sb.Append(",");
                sb.Append("{\"hwnd\":" + kids[k].Hwnd.ToInt64() + ",\"class\":\"" + Esc(kids[k].Cls) + "\"}");
            }
            sb.Append("]}");
        }
        sb.Append("]}");
        return sb.ToString();
    }
}
'@

Add-Type -TypeDefinition $cs -Language CSharp

function Write-Utf8NoBom([string]$path, [string]$text) {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $text, $enc)
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

if ($Mode -eq 'list') {
    $json = [E1]::WindowListJson($TargetTitle, $TargetClass, $TargetProc, $ChildClass)
    $file = Join-Path $OutDir 'windows.json'
    Write-Utf8NoBom $file $json
    $obj = $json | ConvertFrom-Json
    Write-Output ("windows matched: {0}" -f $obj.count)
    foreach ($w in $obj.windows) {
        Write-Output ("hwnd={0,-10} proc={1,-20} class={2,-32} titleLen={3,-4} children={4}" -f $w.hwnd, $w.proc, $w.class, $w.title.Length, $w.children.Count)
        foreach ($k in $w.children) { Write-Output ("    child hwnd={0,-10} class={1}" -f $k.hwnd, $k.class) }
    }
    Write-Output ("written: {0}" -f $file)
    return
}

$json = [E1]::Run($TargetTitle, $TargetClass, $TargetProc, $ChildClass, $PreferChild, $Text, $CharMode,
                  $PreMs, $PerCharMs, $SettleMs, $NoSpoof.IsPresent, $Snapshot.IsPresent,
                  $NoPark.IsPresent, $ParkProc, $ParkClass, $ParkTitle,
                  [long]$TargetHwnd, $InjectTo, $ParkSelf.IsPresent, [long]$InjectHwnd)

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$file = Join-Path $OutDir ("e1-result-$stamp.json")
Write-Utf8NoBom $file $json

$o = $json | ConvertFrom-Json
if (-not $o.ok) {
    Write-Output ("FAILED: {0}" -f $json)
} else {
    Write-Output ("target       : proc={0} class={1} titleLen={2}" -f $o.target.proc, $o.target.class, $o.target.title.Length)
    Write-Output ("park         : note={0} targetWasForeground={1} conclusive={2}" -f $o.park.note, $o.park.targetWasForeground, $o.park.conclusive)
    Write-Output ("control      : class={0} candidates={1}" -f $o.control.class, $o.control.candidates)
    Write-Output ("charMode     : {0}  charsSent={1}" -f $o.charMode, $o.charsSent)
    Write-Output ("readout      : wmGetText={0} beforeLen={1} afterLen={2}" -f $o.readout.wmGetText, $o.readout.beforeLen, $o.readout.afterLen)
    Write-Output ("textArrived  : {0}  partial={1}" -f $o.textArrived, $o.textPartial)
    Write-Output ("snapshotDiff : {0}" -f ($o.snapshotDiff | ConvertTo-Json -Compress))
    Write-Output ("cursor       : dx={0} dy={1}   ({2},{3}) -> ({4},{5})" -f $o.cursor.dx, $o.cursor.dy, $o.cursor.x0, $o.cursor.y0, $o.cursor.x1, $o.cursor.y1)
    Write-Output ("foreground   : stable={0} distinctDuringRun={1} before={2}" -f $o.fg.stable, $o.fg.distinctDuringRun, $o.fg.before)
    Write-Output ("samples      : {0} span={1}ms  spoofed={2}" -f $o.samples, ($o.sampleSpanMs -join '-'), $o.spoofed)
    Write-Output ("arrivedText  : {0}" -f $o.arrivedText)
}
Write-Output ("written: {0}" -f $file)
