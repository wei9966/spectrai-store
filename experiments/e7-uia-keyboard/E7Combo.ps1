# E7 - "UIA locate + keyboard input" combo
# ---------------------------------------------------------------------------
# E2 proved background keyboard delivery works and does NOT steal the
# foreground. E6 proved UIA *actions* do steal it. The open question is how to
# COMBINE them for the product case: "put text into a specific control without
# ever taking the foreground".
#
# The unknown that decides the design: does UIA SetFocus() steal the foreground?
#   - if NO  -> UIA can locate AND focus, then keyboard types; fully clean path
#   - if YES -> UIA may only be used read-only (locate/verify), and focus must be
#               moved with the keyboard itself (Tab), which is what this script
#               also tests
#
# The script records the foreground AFTER EACH STAGE, so we can attribute any
# foreground change to a specific step rather than guessing from an aggregate.
#
# Readout: the page's window title
#   E7 F:<focusedElementId> T1:<len> T2:<len> B:<btnClicks>
#
# 100% ASCII on purpose (PowerShell 5.1 decodes a BOM-less .ps1 as ANSI).

[CmdletBinding()]
param(
    [string]$TargetTitle = 'E7-',
    [int]$TargetHwnd = 0,

    # which child window receives the posted keys; 0 = auto (first RenderWidget)
    [int]$InjectHwnd = 0,

    # list every candidate child window and report which one accepts input
    [switch]$ProbeWidgets,

    # UIA: locate by Name and call SetFocus() before typing (the thing we test)
    [string]$FocusElement = '',

    # send a Tab keydown/keyup before typing (keyboard-driven focus move)
    [switch]$SendTab,

    # text to deliver with WM_CHAR (one message per character)
    [string]$Text = '',
    # how to deliver each character: char only (E1/E2 default), keydown only,
    # or both. E1 found keydown alone loses case but still inserts.
    [ValidateSet('char', 'keydown', 'both')]
    [string]$KeyMode = 'char',

    [switch]$NoPark,
    [string]$ParkProc = 'SpectrAI',
    [string]$ParkClass = '',

    [int]$StepSettleMs = 350,
    [int]$PerCharMs = 40,
    [int]$SettleMs = 800,

    [string]$OutDir = ''
)

if ([string]::IsNullOrEmpty($OutDir)) { $OutDir = $PSScriptRoot }
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$NameProperty = [System.Windows.Automation.AutomationElement]::NameProperty
$ScopeDesc = [System.Windows.Automation.TreeScope]::Descendants

$cs = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class W7
{
    private delegate bool EnumProc(IntPtr h, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] private static extern void SwitchToThisWindow(IntPtr h, bool altTab);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool AttachThreadInput(uint a, uint b, bool f);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr h);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);

    private const uint WM_KEYDOWN = 0x0100;
    private const uint WM_KEYUP = 0x0101;
    private const uint WM_CHAR = 0x0102;

    public static string TitleOf(IntPtr h)
    {
        var sb = new StringBuilder(512); GetWindowTextW(h, sb, sb.Capacity); return sb.ToString();
    }
    private static string ClsOf(IntPtr h)
    {
        var sb = new StringBuilder(256); GetClassNameW(h, sb, sb.Capacity); return sb.ToString();
    }

    public class Win { public IntPtr H; public string Title, Cls, Proc; public uint Pid; public RECT Rc; }

    public static List<Win> Tops()
    {
        var res = new List<Win>();
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            uint pid; GetWindowThreadProcessId(h, out pid);
            string p = "?";
            try { p = Process.GetProcessById((int)pid).ProcessName; } catch { }
            var w = new Win { H = h, Title = TitleOf(h), Cls = ClsOf(h), Pid = pid, Proc = p };
            GetWindowRect(h, out w.Rc);
            res.Add(w);
            return true;
        }, IntPtr.Zero);
        return res;
    }

    public static List<Win> Kids(IntPtr root)
    {
        var res = new List<Win>();
        EnumChildWindows(root, delegate(IntPtr h, IntPtr l)
        {
            uint pid; GetWindowThreadProcessId(h, out pid);
            var w = new Win { H = h, Title = TitleOf(h), Cls = ClsOf(h), Pid = pid };
            GetWindowRect(h, out w.Rc);
            res.Add(w);
            return true;
        }, IntPtr.Zero);
        return res;
    }

    // ---- key delivery (the E1/E2 proven path) ----
    public static string SendChar(IntPtr h, int ch)
    {
        bool ok = PostMessageW(h, WM_CHAR, new IntPtr(ch), new IntPtr(1));
        return ok ? "ok" : ("fail" + Marshal.GetLastWin32Error());
    }

    // keydown carries a virtual-key code; for plain ASCII letters the VK equals
    // the uppercase character. Used to compare against the WM_CHAR path.
    public static string SendKeyDown(IntPtr h, int ch)
    {
        int vk = char.ToUpperInvariant((char)ch);
        bool a = PostMessageW(h, WM_KEYDOWN, new IntPtr(vk), new IntPtr(1));
        Thread.Sleep(20);
        bool b = PostMessageW(h, WM_KEYUP, new IntPtr(vk), new IntPtr(unchecked((long)0xC0000001)));
        return (a && b) ? "ok" : "fail";
    }

    public static string SendTab(IntPtr h)
    {
        bool a = PostMessageW(h, WM_KEYDOWN, new IntPtr(0x09), new IntPtr(1));
        Thread.Sleep(30);
        bool b = PostMessageW(h, WM_KEYUP, new IntPtr(0x09), new IntPtr(unchecked((long)0xC0000001)));
        return (a ? "down-ok" : "down-fail") + "/" + (b ? "up-ok" : "up-fail");
    }

    public static long Fg() { return GetForegroundWindow().ToInt64(); }
    public static string CursorJson()
    {
        POINT p; GetCursorPos(out p);
        return "[" + p.X + "," + p.Y + "]";
    }

    public class Sample { public int X, Y; public long Fg; }
    private static List<Sample> _s = new List<Sample>();
    private static volatile bool _run;
    private static Thread _th;
    private static readonly object _lk = new object();

    public static void StartSampler()
    {
        _s = new List<Sample>(); _run = true;
        _th = new Thread(delegate()
        {
            while (_run)
            {
                POINT p; GetCursorPos(out p);
                lock (_lk) _s.Add(new Sample { X = p.X, Y = p.Y, Fg = GetForegroundWindow().ToInt64() });
                Thread.Sleep(2);
            }
        });
        _th.IsBackground = true; _th.Start();
    }

    public static string StopSampler()
    {
        _run = false;
        if (_th != null) _th.Join(1500);
        var snap = new List<Sample>();
        lock (_lk) snap.AddRange(_s);
        if (snap.Count == 0) return "{\"samples\":0,\"cursorDx\":-1,\"cursorDy\":-1,\"fgDistinct\":-1,\"fgStable\":false}";
        int minX = int.MaxValue, maxX = int.MinValue, minY = int.MaxValue, maxY = int.MinValue;
        var seen = new Dictionary<long, int>();
        foreach (var s in snap)
        {
            if (s.X < minX) minX = s.X; if (s.X > maxX) maxX = s.X;
            if (s.Y < minY) minY = s.Y; if (s.Y > maxY) maxY = s.Y;
            if (!seen.ContainsKey(s.Fg)) seen[s.Fg] = 0;
            seen[s.Fg]++;
        }
        return "{\"samples\":" + snap.Count + ",\"cursorDx\":" + (maxX - minX) + ",\"cursorDy\":" + (maxY - minY)
             + ",\"fgDistinct\":" + seen.Count + ",\"fgStable\":" + (seen.Count == 1 ? "true" : "false") + "}";
    }

    public static string Park(string proc, string cls, IntPtr exclude)
    {
        Win found = null;
        foreach (var w in Tops())
        {
            if (w.H == exclude) continue;
            if (!string.IsNullOrEmpty(proc) && w.Proc.IndexOf(proc, StringComparison.OrdinalIgnoreCase) < 0) continue;
            if (!string.IsNullOrEmpty(cls) && w.Cls.IndexOf(cls, StringComparison.OrdinalIgnoreCase) < 0) continue;
            found = w; break;
        }
        if (found == null) return "{\"note\":\"no-match\"}";
        SetForegroundWindow(found.H); Thread.Sleep(150);
        SwitchToThisWindow(found.H, true); Thread.Sleep(400);
        string note = (GetForegroundWindow() == found.H) ? "ok" : "failed";
        if (note == "failed")
        {
            IntPtr cur = GetForegroundWindow();
            uint j; uint ft = GetWindowThreadProcessId(cur, out j);
            uint my = GetCurrentThreadId();
            if (AttachThreadInput(my, ft, true))
            {
                SetForegroundWindow(found.H); BringWindowToTop(found.H);
                Thread.Sleep(300); AttachThreadInput(my, ft, false);
            }
            Thread.Sleep(200);
            note = (GetForegroundWindow() == found.H) ? "ok-via-attach" : "failed";
        }
        return "{\"note\":\"" + note + "\",\"hwnd\":" + found.H.ToInt64() + ",\"proc\":\"" + Esc(found.Proc) + "\",\"title\":\"" + Esc(found.Title) + "\"}";
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
}
'@
Add-Type -TypeDefinition $cs -Language CSharp

function Write-Utf8NoBom([string]$path, [string]$text) {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $text, $enc)
}
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

# ---- locate target ----
$target = $null
foreach ($w in [W7]::Tops()) {
    if ($TargetHwnd -ne 0) { if ($w.H.ToInt64() -eq $TargetHwnd) { $target = $w; break } }
    else { if ($w.Title -like ('*' + $TargetTitle + '*')) { $target = $w; break } }
}
if ($null -eq $target) { Write-Output ("no window matched '" + $TargetTitle + "'"); return }

Write-Output ("target     : hwnd={0} proc={1} class={2}" -f $target.H.ToInt64(), $target.Proc, $target.Cls)
Write-Output ("title      : '{0}'" -f $target.Title)

# ---- candidate child widgets ----
$kids = [W7]::Kids($target.H)
$cands = @()
foreach ($k in $kids) { if ($k.Cls -like '*Chrome_RenderWidgetHostHWND*') { $cands += $k } }
Write-Output ("child wins : {0} total, {1} RenderWidgetHost" -f $kids.Count, $cands.Count)

if ($ProbeWidgets) {
    Write-Output "--- probing which RenderWidgetHost accepts posted keys ---"
    foreach ($c in $cands) {
        $before = [W7]::TitleOf($target.H)
        $r = [W7]::SendChar($c.H, [int][char]'P')
        Start-Sleep -Milliseconds 500
        $after = [W7]::TitleOf($target.H)
        Write-Output ("  hwnd={0,-10} rect=[{1},{2},{3},{4}] send={5} changed={6}" -f `
            $c.H.ToInt64(), $c.Rc.L, $c.Rc.T, $c.Rc.R, $c.Rc.B, $r, ($before -ne $after))
        if ($before -ne $after) { Write-Output ("      before='{0}' after='{1}'" -f $before, $after) }
    }
    Write-Output "(probe chars are injected and will pollute the counters)"
    return
}

# ---- choose the injection hwnd ----
$ctl = $null
if ($InjectHwnd -ne 0) {
    foreach ($k in $kids) { if ($k.H.ToInt64() -eq $InjectHwnd) { $ctl = $k; break } }
    if ($null -eq $ctl) { Write-Output ("inject hwnd {0} is not a child of the target" -f $InjectHwnd); return }
} else {
    if ($cands.Count -eq 0) { Write-Output "no RenderWidgetHost child found"; return }
    # all RenderWidgetHost children accept posted keys here, so prefer the one
    # that actually covers the page content (largest area) rather than the first
    $best = $cands[0]; $bestArea = 0
    foreach ($c in $cands) {
        $a = ($c.Rc.R - $c.Rc.L) * ($c.Rc.B - $c.Rc.T)
        if ($a -gt $bestArea) { $bestArea = $a; $best = $c }
    }
    $ctl = $best
}
Write-Output ("inject     : hwnd={0} rect=[{1},{2},{3},{4}]" -f $ctl.H.ToInt64(), $ctl.Rc.L, $ctl.Rc.T, $ctl.Rc.R, $ctl.Rc.B)

$winEl = [System.Windows.Automation.AutomationElement]::FromHandle($target.H)

# ---- park ----
$parkJson = '{"note":"not-requested"}'
if (-not $NoPark) { $parkJson = [W7]::Park($ParkProc, $ParkClass, $target.H) }
$park = $parkJson | ConvertFrom-Json

$title0 = [W7]::TitleOf($target.H)
$fgPark = [W7]::Fg()
$cursor0 = [W7]::CursorJson()
Write-Output ("park       : note={0}" -f $park.note)
Write-Output ("STAGE park : fg={0} title='{1}'" -f $fgPark, $title0)

[W7]::StartSampler() | Out-Null

# ---- STAGE 1: UIA locate (read-only) + optional SetFocus ----
$ctName = ''
$elFound = $false
$focusNote = 'not-requested'
$fgAfterFocus = $fgPark
$titleAfterFocus = $title0

if (-not [string]::IsNullOrEmpty($FocusElement)) {
    $byName = New-Object System.Windows.Automation.PropertyCondition($NameProperty, $FocusElement)
    $el = $winEl.FindFirst($ScopeDesc, $byName)
    if ($null -eq $el) {
        foreach ($e in $winEl.FindAll($ScopeDesc, [System.Windows.Automation.Condition]::TrueCondition)) {
            if ($e.Current.Name -and $e.Current.Name.IndexOf($FocusElement, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $el = $e; break }
        }
    }
    if ($null -eq $el) { $focusNote = 'element-not-found' }
    else {
        $elFound = $true
        $ctName = $el.Current.ControlType.ProgrammaticName.Replace('ControlType.', '')
        Write-Output ("uia locate : type={0} name='{1}' id='{2}'" -f $ctName, $el.Current.Name, $el.Current.AutomationId)
        try {
            $el.SetFocus()
            $focusNote = 'setfocus-ok'
        } catch {
            $focusNote = 'setfocus-failed:' + $_.Exception.GetType().Name
        }
        Start-Sleep -Milliseconds $StepSettleMs
        $fgAfterFocus = [W7]::Fg()
        $titleAfterFocus = [W7]::TitleOf($target.H)
        Write-Output ("STAGE focus: note={0} fg={1} title='{2}'" -f $focusNote, $fgAfterFocus, $titleAfterFocus)
    }
} else {
    $fgAfterFocus = [W7]::Fg()
    $titleAfterFocus = $title0
    Write-Output ("STAGE focus: skipped (no -FocusElement)")
}

# ---- STAGE 2: optional Tab ----
$tabNote = 'not-requested'
$fgAfterTab = $fgAfterFocus
$titleAfterTab = $titleAfterFocus
if ($SendTab) {
    $tabNote = [W7]::SendTab($ctl.H)
    Start-Sleep -Milliseconds $StepSettleMs
    $fgAfterTab = [W7]::Fg()
    $titleAfterTab = [W7]::TitleOf($target.H)
    Write-Output ("STAGE tab  : send={0} fg={1} title='{2}'" -f $tabNote, $fgAfterTab, $titleAfterTab)
} else {
    Write-Output "STAGE tab  : skipped"
}

# ---- STAGE 3: type text with WM_CHAR ----
$sent = 0
$fgAfterText = $fgAfterTab
$titleAfterText = $titleAfterTab
if (-not [string]::IsNullOrEmpty($Text)) {
    foreach ($ch in $Text.ToCharArray()) {
        $okThis = $false
        if ($KeyMode -eq 'char' -or $KeyMode -eq 'both') {
            if (([W7]::SendChar($ctl.H, [int]$ch)) -eq 'ok') { $okThis = $true }
            Start-Sleep -Milliseconds $PerCharMs
        }
        if ($KeyMode -eq 'keydown' -or $KeyMode -eq 'both') {
            if (([W7]::SendKeyDown($ctl.H, [int]$ch)) -eq 'ok') { $okThis = $true }
            Start-Sleep -Milliseconds $PerCharMs
        }
        if ($okThis) { $sent++ }
    }
    Start-Sleep -Milliseconds $SettleMs
    $fgAfterText = [W7]::Fg()
    $titleAfterText = [W7]::TitleOf($target.H)
    Write-Output ("STAGE text : keyMode={0} sent={1}/{2} fg={3} title='{4}'" -f $KeyMode, $sent, $Text.Length, $fgAfterText, $titleAfterText)
} else {
    Write-Output "STAGE text : skipped"
}

# ---- wrap up ----
Start-Sleep -Milliseconds $SettleMs
$sampleJson = [W7]::StopSampler()
$s = $sampleJson | ConvertFrom-Json
$cursor1 = [W7]::CursorJson()

$fields = $s.PSObject.Properties.Name
$fgStable = $false; if ($fields -contains 'fgStable') { $fgStable = [bool]$s.fgStable }
$fgDistinct = -1; if ($fields -contains 'fgDistinct') { $fgDistinct = [int]$s.fgDistinct }
$curDx = -1; $curDy = -1
if ($fields -contains 'cursorDx') { $curDx = [int]$s.cursorDx; $curDy = [int]$s.cursorDy }

Write-Output ("cursor     : dx={0} dy={1}  {2} -> {3}" -f $curDx, $curDy, $cursor0, $cursor1)
Write-Output ("foreground : stable={0} distinctDuringRun={1}" -f $fgStable, $fgDistinct)

$json = @{
    target = @{ hwnd = $target.H.ToInt64(); proc = $target.Proc; cls = $target.Cls }
    inject = @{ hwnd = $ctl.H.ToInt64(); rect = @($ctl.Rc.L, $ctl.Rc.T, $ctl.Rc.R, $ctl.Rc.B) }
    park   = @{ note = $park.note }
    stages = @{
        park      = @{ fg = $fgPark; title = $title0 }
        focus     = @{ note = $focusNote; found = $elFound; type = $ctName; fg = $fgAfterFocus; title = $titleAfterFocus }
        tab       = @{ note = $tabNote; fg = $fgAfterTab; title = $titleAfterTab }
        text      = @{ sent = $sent; wanted = $Text.Length; keyMode = $KeyMode; fg = $fgAfterText; title = $titleAfterText }
    }
    foreground = @{ stable = $fgStable; distinctDuringRun = $fgDistinct }
    cursor     = @{ dx = $curDx; dy = $curDy; from = $cursor0; to = $cursor1 }
    samples    = $s.samples
} | ConvertTo-Json -Depth 8 -Compress

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$file = Join-Path $OutDir ("e7-result-$stamp.json")
Write-Utf8NoBom $file $json
Write-Output ("written: {0}" -f $file)
