# E5 helper - inspect (and optionally click) the driver-install security dialog
# ---------------------------------------------------------------------------
# A non-WHQL driver install raises a "Windows Security" dialog owned by an
# ELEVATED rundll32. UIPI blocks a non-elevated process from SendMessage /
# BM_CLICK to it, but *synthetic input is not blocked* - so we read the button
# rectangles and click with the synthetic pen device (same mechanism as E3).
#
# Mode list : enumerate candidate dialogs + their child buttons (rect + text)
# Mode click: synthetic-pen click the centre of button #N of dialog #D
#
# 100% ASCII on purpose.

[CmdletBinding()]
param(
    [ValidateSet('list','click')]
    [string]$Mode = 'list',

    # dialog index from 'list' output (0-based)
    [int]$DialogIndex = 0,
    # button index from 'list' output (0-based)
    [int]$ButtonIndex = 0,

    [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'

$cs = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class Dlg
{
    private delegate bool EnumProc(IntPtr h, IntPtr l);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int L, T, R, B; }

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")]
    private static extern IntPtr SendMessageStr(IntPtr h, uint msg, IntPtr w, StringBuilder l);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr CreateSyntheticPointerDevice(int t, uint max, int mode);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool InjectSyntheticPointerInput(IntPtr d, ref PTI info, uint count);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern void DestroySyntheticPointerDevice(IntPtr d);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();

    [StructLayout(LayoutKind.Sequential)]
    public struct PI
    {
        public uint pointerType, pointerId, frameId, pointerFlags;
        public IntPtr sourceDevice, hwndTarget;
        public int pixX, pixY, himX, himY, pixRawX, pixRawY, himRawX, himRawY;
        public uint dwTime, historyCount; public int InputData; public uint dwKeyStates;
        public ulong PerformanceCount; public int ButtonChangeType;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PEN { public PI pi; public uint penMask, pressure, rotation; public int tiltX, tiltY; }
    [StructLayout(LayoutKind.Sequential)]
    public struct PTI { public uint type; public PEN pen; public ulong p0, p1, p2, p3, p4, p5, p6, p7; }

    private const uint FLAG_INRANGE = 0x2, FLAG_INCONTACT = 0x4, FLAG_PRIMARY = 0x2000, FLAG_DOWN = 0x10000, FLAG_UP = 0x40000;
    private const uint PEN_MASK_PRESSURE = 0x1;

    public class Win
    {
        public IntPtr H;
        public string Title, Cls, Proc;
        public uint Pid;
        public RECT Rc;
        public List<Win> Kids = new List<Win>();
    }

    private static string Txt(IntPtr h, int max)
    {
        var sb = new StringBuilder(max);
        GetWindowTextW(h, sb, sb.Capacity);
        return sb.ToString();
    }
    private static string Cls(IntPtr h)
    {
        var sb = new StringBuilder(256); GetClassNameW(h, sb, sb.Capacity); return sb.ToString();
    }
    // WM_GETTEXT is marshalled by the OS; may be refused across integrity levels
    private static string CtrlText(IntPtr h)
    {
        try
        {
            var sb = new StringBuilder(512);
            SendMessageStr(h, 0x000D /*WM_GETTEXT*/, new IntPtr(511), sb);
            return sb.ToString();
        }
        catch { return ""; }
    }

    public static List<Win> Dialogs()
    {
        var res = new List<Win>();
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            string c = Cls(h);
            if (c != "#32770") return true;               // only dialog boxes
            string t = Txt(h, 512);
            uint pid; GetWindowThreadProcessId(h, out pid);
            string p = "?";
            try { p = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { }
            var w = new Win { H = h, Title = t, Cls = c, Pid = pid, Proc = p };
            GetWindowRect(h, out w.Rc);
            EnumChildWindows(h, delegate(IntPtr k, IntPtr ll)
            {
                if (!IsWindowVisible(k)) return true;
                var kw = new Win { H = k, Title = Txt(k, 256), Cls = Cls(k), Pid = pid, Proc = p };
                string ct = CtrlText(k);
                if (!string.IsNullOrEmpty(ct)) kw.Title = ct;
                GetWindowRect(k, out kw.Rc);
                w.Kids.Add(kw);
                return true;
            }, IntPtr.Zero);
            res.Add(w);
            return true;
        }, IntPtr.Zero);
        return res;
    }

    public static string ClickAt(int x, int y, int pointerType, int feedbackMode)
    {
        try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { }
        try { SetProcessDPIAware(); } catch { }
        IntPtr d = CreateSyntheticPointerDevice(pointerType, 1, feedbackMode);
        if (d == IntPtr.Zero) return "{\"ok\":false,\"error\":\"device\",\"err\":" + Marshal.GetLastWin32Error() + "}";
        uint f = 1;
        var dn = M(pointerType, x, y, f++, FLAG_INRANGE | FLAG_INCONTACT | FLAG_DOWN | FLAG_PRIMARY, true);
        bool a = InjectSyntheticPointerInput(d, ref dn, 1);
        Thread.Sleep(90);
        var up = M(pointerType, x, y, f++, FLAG_INRANGE | FLAG_UP, false);
        bool b = InjectSyntheticPointerInput(d, ref up, 1);
        Thread.Sleep(150);
        DestroySyntheticPointerDevice(d);
        return "{\"ok\":true,\"down\":" + (a ? "true" : "false") + ",\"up\":" + (b ? "true" : "false") + ",\"at\":[" + x + "," + y + "]}";
    }

    private static PTI M(int t, int x, int y, uint frame, uint flags, bool down)
    {
        var o = new PTI();
        o.type = (uint)t;
        o.pen.pi.pointerType = (uint)t; o.pen.pi.pointerId = 1; o.pen.pi.frameId = frame;
        o.pen.pi.pointerFlags = flags;
        o.pen.pi.pixX = x; o.pen.pi.pixY = y; o.pen.pi.pixRawX = x; o.pen.pi.pixRawY = y;
        o.pen.pi.dwTime = (uint)Environment.TickCount;
        o.pen.pi.ButtonChangeType = down ? 1 : 2;
        o.pen.penMask = PEN_MASK_PRESSURE; o.pen.pressure = down ? (uint)512 : 0;
        return o;
    }

    public static string Esc(string s)
    {
        if (s == null) return "";
        var sb = new StringBuilder();
        foreach (char ch in s)
        {
            if (ch == '"' || ch == '\\') sb.Append('\\').Append(ch);
            else if (ch < 0x20) sb.Append('?');
            else sb.Append(ch);
        }
        return sb.ToString();
    }
}
'@

Add-Type -TypeDefinition $cs -Language CSharp

function Write-Utf8NoBom([string]$path, [string]$text) {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $text, $enc)
}

$dialogs = [Dlg]::Dialogs()

if ($Mode -eq 'list') {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append("{""dialogCount"":" + $dialogs.Count + ",""dialogs"":[")
    for ($i = 0; $i -lt $dialogs.Count; $i++) {
        $d = $dialogs[$i]
        if ($i -gt 0) { [void]$sb.Append(",") }
        [void]$sb.Append("{""index"":" + $i + ",""hwnd"":" + $d.H.ToInt64() + ",""proc"":""" + [Dlg]::Esc($d.Proc) + """,""pid"":" + $d.Pid)
        [void]$sb.Append(",""title"":""" + [Dlg]::Esc($d.Title) + """,""rect"":[" + $d.Rc.L + "," + $d.Rc.T + "," + $d.Rc.R + "," + $d.Rc.B + "],""buttons"":[")
        for ($k = 0; $k -lt $d.Kids.Count; $k++) {
            $b = $d.Kids[$k]
            if ($k -gt 0) { [void]$sb.Append(",") }
            [void]$sb.Append("{""index"":" + $k + ",""hwnd"":" + $b.H.ToInt64() + ",""class"":""" + [Dlg]::Esc($b.Cls) + """,""text"":""" + [Dlg]::Esc($b.Title) + """,""rect"":[" + $b.Rc.L + "," + $b.Rc.T + "," + $b.Rc.R + "," + $b.Rc.B + "]}")
        }
        [void]$sb.Append("]}")
    }
    [void]$sb.Append("]}")
    $json = $sb.ToString()
    if ($OutFile) { Write-Utf8NoBom $OutFile $json }
    Write-Output ("dialogs: {0}" -f $dialogs.Count)
    for ($i = 0; $i -lt $dialogs.Count; $i++) {
        $d = $dialogs[$i]
        Write-Output ("  [{0}] proc={1} pid={2} hwnd={3} rect={4},{5},{6},{7} titleLen={8}" -f $i, $d.Proc, $d.Pid, $d.H.ToInt64(), $d.Rc.L, $d.Rc.T, $d.Rc.R, $d.Rc.B, $d.Title.Length)
        for ($k = 0; $k -lt $d.Kids.Count; $k++) {
            $b = $d.Kids[$k]
            Write-Output ("      btn[{0}] class={1} textLen={2} rect={3},{4},{5},{6}" -f $k, $b.Cls, $b.Title.Length, $b.Rc.L, $b.Rc.T, $b.Rc.R, $b.Rc.B)
        }
    }
    if ($OutFile) { Write-Output ("written: " + $OutFile) }
    return
}

# ---- click mode ----
if ($DialogIndex -ge $dialogs.Count) { Write-Output ("dialog index out of range (count=" + $dialogs.Count + ")"); return }
$d = $dialogs[$DialogIndex]
if ($ButtonIndex -ge $d.Kids.Count) { Write-Output ("button index out of range (count=" + $d.Kids.Count + ")"); return }
$b = $d.Kids[$ButtonIndex]
$cx = [int](($b.Rc.L + $b.Rc.R) / 2)
$cy = [int](($b.Rc.T + $b.Rc.B) / 2)
$json = [Dlg]::ClickAt($cx, $cy, 3, 1)
if ($OutFile) { Write-Utf8NoBom $OutFile $json }
Write-Output ("clicked button[{0}] textLen={1} at {2},{3} -> {4}" -f $ButtonIndex, $b.Title.Length, $cx, $cy, $json)
