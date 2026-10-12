# E2 - Background hotkey delivery via thread-level modifier spoofing
# ---------------------------------------------------------------------------
# Question (E2): can a hotkey (Ctrl+A) be delivered into a NON-foreground
# Chromium window by sharing the target's input queue and writing the modifier
# state, instead of injecting code?
#
#   AttachThreadInput(ourTid, targetTid, TRUE)
#   SetKeyboardState(... VK_CONTROL = 0x80 ...)
#   PostMessage(target, WM_KEYDOWN/UP, 'A')
#   restore original keyboard state, AttachThreadInput(..., FALSE)
#
# E1 showed that messages alone are dropped by Chromium in the background and
# that Chromium has no WM_GETTEXT readout. E2 therefore uses the *window title*
# as the readout channel: the target page sets document.title on key events and
# the browser process updates the window title even while unfocused.
#
# Readout legend:
#   E2-CTRLA-OK-n  -> key arrived WITH ctrl modifier  (E2 success)
#   E2-KEY-a       -> key arrived WITHOUT ctrl         (modifier spoof failed)
#   E2-IDLE        -> nothing arrived at all
#
# Safety: documented USER32 APIs only. No DLL injection, no global hooks, no
# SendInput, no cursor movement, no system setting changes. The original
# keyboard state is restored and the queue is detached on every path, and the
# run reports whether our own modifier state was left polluted.
#
# This file is deliberately 100% ASCII (PowerShell 5.1 decodes a BOM-less .ps1
# using the ANSI code page).

[CmdletBinding()]
param(
    [ValidateSet('list','run','probe')]
    [string]$Mode = 'run',

    [string]$TargetTitle = '',
    [string]$TargetClass = '',
    [string]$TargetProc = '',
    [int]$TargetHwnd = 0,

    # regex for descendant windows used as injection candidates
    [string]$ChildClass = '^Chrome_RenderWidgetHostHWND$',
    [int]$InjectHwnd = 0,

    # hotkey character: A = Ctrl+A (select all), C = Ctrl+C, V = Ctrl+V
    [ValidateSet('A','C','V')]
    [string]$Key = 'A',

    # skip AttachThreadInput + SetKeyboardState (plain message delivery control)
    [switch]$NoSpoof,
    # also post a real VK_CONTROL keydown/up pair around the key
    [switch]$AlsoCtrlKey,
    # also send the E1 activation sequence (WM_NCACTIVATE/WM_ACTIVATE/WM_SETFOCUS)
    # so the combined technique can be ruled in or out
    [switch]$WithActivationMsgs,

    [switch]$NoPark,
    [string]$ParkProc = '',
    [string]$ParkClass = '',
    [string]$ParkTitle = '',
    # control run: bring the target itself to the foreground
    [switch]$ParkSelf,

    [switch]$Snapshot,

    [int]$PreMs = 700,
    # how long the modifier state stays written before restoring
    [int]$HoldMs = 400,
    [int]$SettleMs = 700,

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

public static class E2
{
    private const uint WM_KEYDOWN = 0x0100;
    private const uint WM_KEYUP   = 0x0101;
    private const uint WM_GETTEXT = 0x000D;
    private const uint WM_NCACTIVATE = 0x0086;
    private const uint WM_ACTIVATE   = 0x0006;
    private const uint WM_SETFOCUS   = 0x0007;
    private const int  VK_CONTROL = 0x11;
    private const int  VK_LCONTROL = 0xA2;
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
    private static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageW(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")]
    private static extern bool SetKeyboardState(byte[] lpKeyState);
    [DllImport("user32.dll")]
    private static extern bool GetKeyboardState(byte[] lpKeyState);
    [DllImport("user32.dll")]
    private static extern short GetKeyState(int vKey);
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
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
            bmi.h.biWidth = w; bmi.h.biHeight = -h;
            bmi.h.biPlanes = 1; bmi.h.biBitCount = 32; bmi.h.biCompression = 0;
            GetDIBits(memDc, bmp, 0, (uint)h, bits, ref bmi, 0);
        }
        SelectObject(memDc, old);
        DeleteObject(bmp); DeleteDC(memDc); ReleaseDC(IntPtr.Zero, screenDc);
        if (!ok) { w = 0; h = 0; return null; }
        return bits;
    }

    private static string DiffJson(byte[] a, byte[] b, int w, int h)
    {
        if (a == null || b == null || a.Length != b.Length) return "{\"available\":false}";
        long changed = 0;
        for (int i = 0; i < a.Length; i += 4)
        {
            int d = Math.Abs(a[i] - b[i]) + Math.Abs(a[i + 1] - b[i + 1]) + Math.Abs(a[i + 2] - b[i + 2]);
            if (d > 30) changed++;
        }
        return "{\"available\":true,\"changedPixels\":" + changed + "}";
    }

    private static int KeyVk(string key)
    {
        switch (key) { case "A": return 0x41; case "C": return 0x43; case "V": return 0x56; default: return 0x41; }
    }

    public static string RunOnce(long targetHwnd, long injectHwnd, string key, bool spoof, bool alsoCtrlKey,
                                 bool withActivation,
                                 int preMs, int holdMs, int settleMs,
                                 bool parkSelf, bool noPark, string parkProc, string parkClass, string parkTitle,
                                 bool snapshot)
    {
        var log = new List<string>();

        WinInfo top = null;
        foreach (var w in TopLevel("", "", "")) if (w.Hwnd.ToInt64() == targetHwnd) { top = w; break; }
        if (top == null)
            return "{\"ok\":false,\"error\":\"target hwnd not found\",\"hwnd\":" + targetHwnd + "}";

        IntPtr ctl = injectHwnd != 0 ? new IntPtr(injectHwnd) : top.Hwnd;

        // ---- park ----
        long parked = 0; string parkNote = "not-requested";
        if (parkSelf)
        {
            SetForegroundWindow(top.Hwnd); Thread.Sleep(120);
            SwitchToThisWindow(top.Hwnd, true); Thread.Sleep(350);
            parked = top.Hwnd.ToInt64();
            parkNote = (GetForegroundWindow() == top.Hwnd) ? "self-ok" : "self-failed";
        }
        else if (!noPark && (!string.IsNullOrEmpty(parkProc) || !string.IsNullOrEmpty(parkClass) || !string.IsNullOrEmpty(parkTitle)))
        {
            WinInfo pw = null;
            foreach (var c in TopLevel(parkTitle, parkClass, parkProc)) { if (c.Hwnd != top.Hwnd) { pw = c; break; } }
            if (pw == null) parkNote = "no-park-window-match";
            else
            {
                SetForegroundWindow(pw.Hwnd); Thread.Sleep(120);
                SwitchToThisWindow(pw.Hwnd, true); Thread.Sleep(350);
                parked = pw.Hwnd.ToInt64();
                parkNote = (GetForegroundWindow() == pw.Hwnd) ? "ok" : "failed";
            }
        }

        POINT c0; GetCursorPos(out c0);
        IntPtr fgH0 = GetForegroundWindow();
        long fg0 = fgH0.ToInt64();
        string titleBefore = Title(top.Hwnd);
        int bw = 0, bh = 0;
        byte[] shot0 = snapshot ? Grab(top.Hwnd, out bw, out bh) : null;

        bool targetWasFg = (fg0 == top.Hwnd.ToInt64());
        uint tgtTid = 0; uint pid2;
        tgtTid = GetWindowThreadProcessId(top.Hwnd, out pid2);
        uint myTid = GetCurrentThreadId();

        timeBeginPeriod(1);
        _samples = new List<Sample>();
        _running = true;
        _sampler = new Thread(SamplerLoop) { IsBackground = true };
        _sampler.Start();
        Thread.Sleep(preMs);

        // ---- spoof + inject ----
        bool attached = false, setStateOk = false, ctrlSeenDuring = false;
        bool ctrlWasDownBefore = false;
        byte[] origState = null;
        try
        {
            if (spoof)
            {
                attached = AttachThreadInput(myTid, tgtTid, true);
                log.Add("AttachThreadInput(my=" + myTid + ", target=" + tgtTid + ") -> " + attached);
                Thread.Sleep(60);

                origState = new byte[256];
                GetKeyboardState(origState);
                ctrlWasDownBefore = (origState[VK_CONTROL] & 0x80) != 0;

                var ks = (byte[])origState.Clone();
                ks[VK_CONTROL] = 0x80;
                ks[VK_LCONTROL] = 0x80;
                setStateOk = SetKeyboardState(ks);
                Thread.Sleep(50);
                ctrlSeenDuring = (GetKeyState(VK_CONTROL) & 0x8000) != 0;
                log.Add("SetKeyboardState(ctrl down) -> " + setStateOk + ", GetKeyState(VK_CONTROL) down=" + ctrlSeenDuring);
            }

            int vk = KeyVk(key);
            if (withActivation)
            {
                log.Add("WM_NCACTIVATE(top,TRUE) -> " + SendMessageW(top.Hwnd, WM_NCACTIVATE, (IntPtr)1, IntPtr.Zero).ToInt64());
                log.Add("WM_ACTIVATE(top,WA_ACTIVE) -> " + SendMessageW(top.Hwnd, WM_ACTIVATE, (IntPtr)1, IntPtr.Zero).ToInt64());
                log.Add("WM_SETFOCUS(ctl) -> " + SendMessageW(ctl, WM_SETFOCUS, IntPtr.Zero, IntPtr.Zero).ToInt64());
                Thread.Sleep(60);
            }
            if (alsoCtrlKey) PostMessageW(ctl, WM_KEYDOWN, (IntPtr)VK_CONTROL, IntPtr.Zero);
            PostMessageW(ctl, WM_KEYDOWN, (IntPtr)vk, IntPtr.Zero);
            Thread.Sleep(60);
            PostMessageW(ctl, WM_KEYUP, (IntPtr)vk, IntPtr.Zero);
            if (alsoCtrlKey) PostMessageW(ctl, WM_KEYUP, (IntPtr)VK_CONTROL, IntPtr.Zero);
            log.Add("PostMessage " + (alsoCtrlKey ? "VK_CONTROL + " : "") + key + " (vk=0x" + vk.ToString("X2") + ") to hwnd=" + ctl.ToInt64());

            Thread.Sleep(holdMs);
        }
        finally
        {
            if (spoof)
            {
                if (origState != null) SetKeyboardState(origState);
                if (attached) AttachThreadInput(myTid, tgtTid, false);
                log.Add("restored keyboard state, AttachThreadInput(FALSE)");
            }
        }

        Thread.Sleep(settleMs);
        _running = false;
        _sampler.Join(2000);
        timeEndPeriod(1);

        string titleAfter = Title(top.Hwnd);
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

        // ---- pollution self-check, AFTER detach ----
        bool ctrlStillDown = (GetKeyState(VK_CONTROL) & 0x8000) != 0;
        bool ctrlPhysicallyDown = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
        bool polluted = ctrlStillDown && !ctrlPhysicallyDown;

        bool ctrlArrived = titleAfter.IndexOf("E2-CTRLA-OK", StringComparison.OrdinalIgnoreCase) >= 0
                           && titleAfter != titleBefore;
        bool keyArrivedNoCtrl = titleAfter.IndexOf("E2-KEY-", StringComparison.OrdinalIgnoreCase) >= 0
                           && titleAfter != titleBefore;

        var sb = new StringBuilder();
        sb.Append("{\"ok\":true");
        sb.Append(",\"target\":{\"proc\":\"").Append(Esc(top.Proc)).Append("\",\"class\":\"").Append(Esc(top.Cls))
          .Append("\",\"hwnd\":" + top.Hwnd.ToInt64() + ",\"pid\":" + top.Pid + "}");
        sb.Append(",\"inject\":{\"hwnd\":" + ctl.ToInt64() + ",\"class\":\"").Append(Esc(Cls(ctl))).Append("\"}");
        sb.Append(",\"park\":{\"note\":\"").Append(Esc(parkNote)).Append("\",\"hwnd\":" + parked
          + ",\"targetWasForeground\":" + (targetWasFg ? "true" : "false")
          + ",\"conclusive\":" + (targetWasFg ? "false" : "true") + "}");
        sb.Append(",\"hotkey\":{\"key\":\"").Append(Esc(key)).Append("\",\"spoof\":" + (spoof ? "true" : "false")
          + ",\"alsoCtrlKey\":" + (alsoCtrlKey ? "true" : "false")
          + ",\"withActivation\":" + (withActivation ? "true" : "false")
          + ",\"attached\":" + (attached ? "true" : "false")
          + ",\"setKeyboardStateOk\":" + (setStateOk ? "true" : "false")
          + ",\"ctrlSeenDuring\":" + (ctrlSeenDuring ? "true" : "false") + "}");
        sb.Append(",\"title\":{\"before\":\"").Append(Esc(titleBefore)).Append("\",\"after\":\"").Append(Esc(titleAfter))
          .Append("\",\"changed\":" + (titleAfter != titleBefore ? "true" : "false") + "}");
        sb.Append(",\"verdict\":{\"ctrlArrived\":" + (ctrlArrived ? "true" : "false")
          + ",\"keyArrivedNoCtrl\":" + (keyArrivedNoCtrl ? "true" : "false") + "}");
        sb.Append(",\"cursor\":{\"dx\":" + dx + ",\"dy\":" + dy + "}");
        sb.Append(",\"fg\":{\"before\":" + fg0 + ",\"after\":" + fg1 + ",\"distinctDuringRun\":" + fgSeen.Count
          + ",\"stable\":" + (fgStable ? "true" : "false") + "}");
        sb.Append(",\"selfCheck\":{\"ctrlWasDownBefore\":" + (ctrlWasDownBefore ? "true" : "false")
          + ",\"ctrlStillDownAfter\":" + (ctrlStillDown ? "true" : "false")
          + ",\"ctrlPhysicallyDown\":" + (ctrlPhysicallyDown ? "true" : "false")
          + ",\"polluted\":" + (polluted ? "true" : "false") + "}");
        sb.Append(",\"snapshotDiff\":" + diffJson);
        sb.Append(",\"samples\":" + snap.Count);
        sb.Append(",\"sequence\":[");
        for (int i = 0; i < log.Count; i++) { if (i > 0) sb.Append(","); sb.Append("\"").Append(Esc(log[i])).Append("\""); }
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
            RECT rr; string rect = "?";
            if (GetWindowRect(w.Hwnd, out rr)) rect = rr.Left + "," + rr.Top + "," + rr.Right + "," + rr.Bottom;
            sb.Append("{\"hwnd\":" + w.Hwnd.ToInt64() + ",\"class\":\"" + Esc(w.Cls) + "\",\"proc\":\"" + Esc(w.Proc)
              + "\",\"pid\":" + w.Pid + ",\"title\":\"" + Esc(w.Title) + "\",\"rect\":\"" + rect + "\",\"children\":[");
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

function Show-Result($o, [string]$tag) {
    if (-not $o.ok) { Write-Output ("FAILED $tag : $($o | ConvertTo-Json -Compress)"); return }
    Write-Output ("{0} | spoof={1,-5} inject={2} ({3}) | park={4} fgIsTarget={5} | titleBefore='{6}' -> titleAfter='{7}' | ctrlArrived={8} keyNoCtrl={9} | cursor={10}x{11} fgStable={12} polluted={13} | snap={14}" -f `
        $tag, $o.hotkey.spoof, $o.inject.hwnd, $o.inject.class, $o.park.note, $o.park.targetWasForeground,
        $o.title.before, $o.title.after, $o.verdict.ctrlArrived, $o.verdict.keyArrivedNoCtrl,
        $o.cursor.dx, $o.cursor.dy, $o.fg.stable, $o.selfCheck.polluted, $o.snapshotDiff.changedPixels)
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

if ($Mode -eq 'list') {
    $json = [E2]::WindowListJson($TargetTitle, $TargetClass, $TargetProc, $ChildClass)
    Write-Utf8NoBom (Join-Path $OutDir 'windows.json') $json
    $obj = $json | ConvertFrom-Json
    Write-Output ("windows matched: {0}" -f $obj.count)
    foreach ($w in $obj.windows) {
        Write-Output ("hwnd={0,-10} proc={1,-14} class={2,-24} rect={3,-24} title='{4}'" -f $w.hwnd, $w.proc, $w.class, $w.rect, $w.title)
        foreach ($k in $w.children) { Write-Output ("    child hwnd={0,-10} class={1}" -f $k.hwnd, $k.class) }
    }
    Write-Output ("written: {0}" -f (Join-Path $OutDir 'windows.json'))
    return
}

$stamp0 = Get-Date -Format 'yyyyMMdd-HHmmss'

if ($Mode -eq 'run') {
    $json = [E2]::RunOnce([long]$TargetHwnd, [long]$InjectHwnd, $Key, (-not $NoSpoof.IsPresent), $AlsoCtrlKey.IsPresent,
                          $WithActivationMsgs.IsPresent,
                          $PreMs, $HoldMs, $SettleMs, $ParkSelf.IsPresent, $NoPark.IsPresent,
                          $ParkProc, $ParkClass, $ParkTitle, $Snapshot.IsPresent)
    $file = Join-Path $OutDir ("e2-result-$stamp0.json")
    Write-Utf8NoBom $file $json
    Show-Result ($json | ConvertFrom-Json) 'run'
    Write-Output ("written: {0}" -f $file)
    return
}

# ---- probe mode: try every plausible injection target on one window ----
$targets = [E2]::WindowListJson($TargetTitle, $TargetClass, $TargetProc, $ChildClass) | ConvertFrom-Json
if ($targets.count -eq 0) { Write-Output "no target window matched"; return }
if ($targets.count -gt 1) {
    Write-Output ("probe: {0} windows matched, using the first" -f $targets.count)
}
$win = $targets.windows[0]
Write-Output ("probe target: hwnd={0} class={1} title='{2}'" -f $win.hwnd, $win.class, $win.title)

$cands = New-Object System.Collections.ArrayList
[void]$cands.Add(@{ hwnd = [int64]$win.hwnd; cls = $win.class; tag = 'top-level' })
$i = 0
foreach ($k in $win.children) {
    $i++
    [void]$cands.Add(@{ hwnd = [int64]$k.hwnd; cls = $k.class; tag = ("child#$i") })
}

$results = New-Object System.Collections.ArrayList
foreach ($c in $cands) {
    foreach ($spoof in @($false, $true)) {
        $json = [E2]::RunOnce([long]$win.hwnd, [long]$c.hwnd, $Key, $spoof, $AlsoCtrlKey.IsPresent,
                              $WithActivationMsgs.IsPresent,
                              $PreMs, $HoldMs, $SettleMs, $ParkSelf.IsPresent, $NoPark.IsPresent,
                              $ParkProc, $ParkClass, $ParkTitle, $Snapshot.IsPresent)
        $o = $json | ConvertFrom-Json
        $tag = "{0}/{1}{2}" -f $c.tag, ($(if ($spoof) { 'spoof' } else { 'plain' })), ($(if ($WithActivationMsgs.IsPresent) { '+act' } else { '' }))
        Show-Result $o $tag
        [void]$results.Add(@{ cand = $c.tag; hwnd = $c.hwnd; spoof = $spoof; json = $json })
    }
}

$file = Join-Path $OutDir ("e2-probe-$stamp0.json")
Write-Utf8NoBom $file (($results | ConvertTo-Json -Depth 8 -Compress))
Write-Output ("written: {0}  (per-candidate JSONs inlined)" -f $file)
