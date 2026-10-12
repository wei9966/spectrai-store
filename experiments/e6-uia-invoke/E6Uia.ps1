# E6 - UI Automation as a non-activating click channel
# ---------------------------------------------------------------------------
# Question: E4 showed that a synthetic pen click on a real Chromium window
# ALWAYS steals the foreground, and WS_EX_NOACTIVATE does not stop it. Can the
# UI Automation layer drive the same controls WITHOUT activating the window?
#
# This script does two things:
#   -Mode dump : find the target window and list its accessibility tree
#                (Name / ControlType / AutomationId / ClassName) so we know
#                what is addressable at the UI layer
#   -Mode run  : invoke/toggle/set-value on an element by Name and measure
#                whether the foreground window, the cursor, and the page state
#                changed (page state is read from the window title, same trick
#                as E2/E4)
#
# Windows-side measurement is raw USER32 (foreground + cursor sampling); the
# automation itself is System.Windows.Automation.
#
# 100% ASCII on purpose (PowerShell 5.1 decodes a BOM-less .ps1 as ANSI).

[CmdletBinding()]
param(
    [ValidateSet('dump', 'run', 'list')]
    [string]$Mode = 'dump',

    # target window: exact hwnd, else class substring, else title regex
    [int]$TargetHwnd = 0,
    [string]$TargetClass = '',
    [string]$TargetTitle = 'E6-',

    # element to act on, matched by its UIA Name (exact, then contains)
    [string]$Element = '',
    # which control pattern to use. 'auto' picks the first one that works.
    [ValidateSet('none', 'auto', 'invoke', 'toggle', 'valueset', 'focus', 'click')]
    [string]$Action = 'auto',
    [string]$Value = '',

    # park the foreground elsewhere so the target starts in the background
    [switch]$NoPark,
    [string]$ParkProc = '',
    [string]$ParkClass = '',

    # how long to wait after the action before reading the result
    [int]$SettleMs = 900,

    # dump: max elements to print
    [int]$MaxDump = 120,

    [string]$OutDir = ''
)

if ([string]::IsNullOrEmpty($OutDir)) { $OutDir = $PSScriptRoot }
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# NOTE: PowerShell cannot do static member access on a *variable* holding a type
# ("$AE::NameProperty" is a syntax error), and $TRUE is a readonly builtin.
# So hoist the values we need into plain variables with distinct names.
$NameProperty = [System.Windows.Automation.AutomationElement]::NameProperty
$ScopeDesc = [System.Windows.Automation.TreeScope]::Descendants
$ScopeKids = [System.Windows.Automation.TreeScope]::Children
$AnyCond = [System.Windows.Automation.Condition]::TrueCondition

# ---------------------------------------------------------------------------
# raw Win32 side: window enumeration, foreground, cursor, sampling
# ---------------------------------------------------------------------------
$cs = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class W6
{
    private delegate bool EnumProc(IntPtr h, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr l);
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

    public class Sample { public long T; public int X, Y; public long Fg; }

    private static List<Sample> _s = new List<Sample>();
    private static volatile bool _run;
    private static Thread _th;
    private static readonly object _lk = new object();

    public static void StartSampler()
    {
        _s = new List<Sample>(); _run = true;
        _th = new Thread(delegate()
        {
            var sw = Stopwatch.StartNew();
            while (_run)
            {
                POINT p; GetCursorPos(out p);
                lock (_lk) _s.Add(new Sample { T = sw.ElapsedMilliseconds, X = p.X, Y = p.Y, Fg = GetForegroundWindow().ToInt64() });
                Thread.Sleep(2);
            }
        });
        _th.IsBackground = true; _th.Start();
    }

    public static string StopSampler(long fgBefore)
    {
        _run = false;
        if (_th != null) _th.Join(1500);
        var snap = new List<Sample>();
        lock (_lk) snap.AddRange(_s);
        if (snap.Count == 0) return "{\"samples\":0}";
        int minX = int.MaxValue, maxX = int.MinValue, minY = int.MaxValue, maxY = int.MinValue;
        var seen = new Dictionary<long, int>();
        foreach (var s in snap)
        {
            if (s.X < minX) minX = s.X; if (s.X > maxX) maxX = s.X;
            if (s.Y < minY) minY = s.Y; if (s.Y > maxY) maxY = s.Y;
            if (!seen.ContainsKey(s.Fg)) seen[s.Fg] = 0;
            seen[s.Fg]++;
        }
        bool stable = (seen.Count == 1);
        return "{\"samples\":" + snap.Count + ",\"cursorDx\":" + (maxX - minX) + ",\"cursorDy\":" + (maxY - minY)
             + ",\"fgDistinct\":" + seen.Count + ",\"fgStable\":" + (stable ? "true" : "false") + "}";
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
        return "{\"note\":\"" + note + "\",\"hwnd\":" + found.H.ToInt64() + ",\"proc\":\"" + found.Proc + "\",\"title\":\"" + Esc(found.Title) + "\"}";
    }

    public static long Fg() { return GetForegroundWindow().ToInt64(); }

    public static string CursorJson()
    {
        POINT p; GetCursorPos(out p);
        return "[" + p.X + "," + p.Y + "]";
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

# ---------------------------------------------------------------------------
# locate the target window
# ---------------------------------------------------------------------------
$regex = $null
if (-not [string]::IsNullOrEmpty($TargetTitle)) {
    $regex = New-Object System.Text.RegularExpressions.Regex($TargetTitle, 'IgnoreCase')
}
$target = $null
foreach ($w in [W6]::Tops()) {
    if ($TargetHwnd -ne 0) {
        if ($w.H.ToInt64() -ne $TargetHwnd) { continue }
    } else {
        if (-not [string]::IsNullOrEmpty($TargetClass) -and $w.Cls -notlike ('*' + $TargetClass + '*')) { continue }
        if ($null -ne $regex -and -not $regex.IsMatch($w.Title)) { continue }
    }
    $target = $w; break
}

if ($Mode -eq 'list') {
    foreach ($w in [W6]::Tops()) {
        Write-Output ("hwnd={0,-10} proc={1,-14} class={2,-24} rect=[{3},{4},{5},{6}] titleLen={7}" -f `
            $w.H.ToInt64(), $w.Proc, $w.Cls, $w.Rc.L, $w.Rc.T, $w.Rc.R, $w.Rc.B, $w.Title.Length)
    }
    return
}

if ($null -eq $target) {
    Write-Output ("no window matched (hwnd=" + $TargetHwnd + " class='" + $TargetClass + "' title='" + $TargetTitle + "')")
    return
}

Write-Output ("target     : hwnd={0} proc={1} class={2} title='{3}'" -f $target.H.ToInt64(), $target.Proc, $target.Cls, $target.Title)
Write-Output ("rect       : [{0},{1} - {2},{3}]" -f $target.Rc.L, $target.Rc.T, $target.Rc.R, $target.Rc.B)

$winEl = [System.Windows.Automation.AutomationElement]::FromHandle($target.H)
if ($null -eq $winEl) { Write-Output 'UIA FromHandle returned null'; return }

# ---------------------------------------------------------------------------
# dump
# ---------------------------------------------------------------------------
if ($Mode -eq 'dump') {
    Write-Output ("UIA window : name='{0}' class='{1}'" -f $winEl.Current.Name, $winEl.Current.ClassName)
    $all = $winEl.FindAll($ScopeDesc, $AnyCond)
    Write-Output ("descendants: {0}" -f $all.Count)
    $n = 0
    foreach ($e in $all) {
        $n++
        if ($n -gt $MaxDump) { Write-Output ("  ... truncated at " + $MaxDump); break }
        $nm = $e.Current.Name
        $aid = $e.Current.AutomationId
        if ($nm -or $aid) {
            $ctp = $e.Current.ControlType.ProgrammaticName.Replace('ControlType.', '')
            Write-Output ("  [{0,-14}] name='{1}' id='{2}' class='{3}'" -f $ctp, $nm, $aid, $e.Current.ClassName)
        }
    }
    return
}

# ---------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------
if ([string]::IsNullOrEmpty($Element)) { Write-Output '-Element is required in run mode'; return }

$parkJson = '{"note":"not-requested"}'
if (-not $NoPark -and ((-not [string]::IsNullOrEmpty($ParkProc)) -or (-not [string]::IsNullOrEmpty($ParkClass)))) {
    $parkJson = [W6]::Park($ParkProc, $ParkClass, $target.H)
}
$park = $parkJson | ConvertFrom-Json

$titleBefore = [W6]::TitleOf($target.H)
$fg0 = [W6]::Fg()
$targetWasFg = ($fg0 -eq $target.H.ToInt64())
Write-Output ("park       : note={0} targetWasForeground={1}" -f $park.note, $targetWasFg)
Write-Output ("before     : fg={0} title='{1}'" -f $fg0, $titleBefore)

# find the element: exact Name first, then a case-insensitive contains pass
$byName = New-Object System.Windows.Automation.PropertyCondition($NameProperty, $Element)
$el = $winEl.FindFirst($ScopeDesc, $byName)
$matchKind = 'exact'
if ($null -eq $el) {
    $all = $winEl.FindAll($ScopeDesc, $AnyCond)
    foreach ($e in $all) {
        if ($e.Current.Name -and $e.Current.Name.IndexOf($Element, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $el = $e; break }
    }
    $matchKind = 'contains'
}
if ($null -eq $el) { Write-Output ("element not found: '" + $Element + "'"); return }

$ctName = $el.Current.ControlType.ProgrammaticName.Replace('ControlType.', '')
Write-Output ("element    : match={0} type={1} name='{2}' id='{3}'" -f $matchKind, $ctName, $el.Current.Name, $el.Current.AutomationId)
$rct = $el.Current.BoundingRectangle
Write-Output ("             bounds=[{0},{1} - {2},{3}] offscreen={4}" -f $rct.X, $rct.Y, $rct.Right, $rct.Bottom, $el.Current.IsOffscreen)

# Look patterns up by their well-known numeric IDs instead of naming the .NET
# types directly: LegacyIAccessiblePattern is not present in every build of the
# UIA client assembly, and a missing type aborts the whole script.
$patMap = [ordered]@{
    'InvokePattern'            = 10000
    'ValuePattern'             = 10002
    'SelectionItemPattern'     = 10010
    'TogglePattern'            = 10015
    'ScrollItemPattern'        = 10017
    'LegacyIAccessiblePattern' = 10018
}
$supported = @()
foreach ($k in $patMap.Keys) {
    try {
        $pat = [System.Windows.Automation.AutomationPattern]::LookupById($patMap[$k])
        if ($null -ne $pat) {
            $o = $el.GetCurrentPattern($pat)
            if ($null -ne $o) { $supported += $k }
        }
    } catch { }
}
Write-Output ("patterns   : {0}" -f (($supported | Sort-Object) -join ', '))

[W6]::StartSampler() | Out-Null
$actionUsed = 'none'; $actionError = ''; $done = $false

if ($Action -eq 'invoke' -or $Action -eq 'auto') {
    try {
        $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $p.Invoke(); $actionUsed = 'InvokePattern'; $done = $true
    } catch { $actionError = $_.Exception.GetType().Name + ': ' + $_.Exception.Message }
}
if (-not $done -and ($Action -eq 'toggle' -or $Action -eq 'auto')) {
    try {
        $p = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        $p.Toggle(); $actionUsed = 'TogglePattern'; $done = $true
    } catch { $actionError = $_.Exception.GetType().Name + ': ' + $_.Exception.Message }
}
if (-not $done -and ($Action -eq 'valueset' -or $Action -eq 'auto')) {
    try {
        $p = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $p.SetValue($Value); $actionUsed = 'ValuePattern.SetValue'; $done = $true
    } catch { $actionError = $_.Exception.GetType().Name + ': ' + $_.Exception.Message }
}
if (-not $done -and $Action -eq 'focus') {
    try { $el.SetFocus(); $actionUsed = 'SetFocus'; $done = $true }
    catch { $actionError = $_.Exception.GetType().Name + ': ' + $_.Exception.Message }
}
if (-not $done -and $Action -eq 'click') {
    try {
        $legacy = [System.Windows.Automation.AutomationPattern]::LookupById(10018)
        $p = $el.GetCurrentPattern($legacy)
        $p.DoDefaultAction(); $actionUsed = 'LegacyIAccessible.DoDefaultAction'; $done = $true
    } catch { $actionError = $_.Exception.GetType().Name + ': ' + $_.Exception.Message }
}

Write-Output ("action     : used={0} ok={1} error='{2}'" -f $actionUsed, $done, $actionError)

Start-Sleep -Milliseconds $SettleMs
$sampleJson = [W6]::StopSampler($fg0)
$s = $sampleJson | ConvertFrom-Json

$titleAfter = [W6]::TitleOf($target.H)
$fg1 = [W6]::Fg()

$fields = $s.PSObject.Properties.Name
$fgStable = $false; if ($fields -contains 'fgStable') { $fgStable = [bool]$s.fgStable }
$fgDistinct = -1; if ($fields -contains 'fgDistinct') { $fgDistinct = [int]$s.fgDistinct }
$curDx = -1; $curDy = -1
if ($fields -contains 'cursorDx') { $curDx = [int]$s.cursorDx; $curDy = [int]$s.cursorDy }
$nsamp = 0; if ($fields -contains 'samples') { $nsamp = [int]$s.samples }
$changed = ($titleBefore -ne $titleAfter)

$json = @{
    target  = @{ hwnd = $target.H.ToInt64(); proc = $target.Proc; cls = $target.Cls }
    park    = @{ note = $park.note; targetWasForeground = $targetWasFg; conclusive = (-not $targetWasFg) }
    element = @{ match = $matchKind; type = $ctName; name = $el.Current.Name; id = $el.Current.AutomationId; patterns = $supported }
    action  = @{ used = $actionUsed; ok = $done; error = $actionError; value = $Value }
    title   = @{ before = $titleBefore; after = $titleAfter; changed = $changed }
    cursor  = @{ dx = $curDx; dy = $curDy }
    fg      = @{ before = $fg0; after = $fg1; stable = $fgStable; distinctDuringRun = $fgDistinct }
    samples = $nsamp
} | ConvertTo-Json -Depth 8 -Compress

Write-Output ("after      : fg={0} title='{1}' changed={2}" -f $fg1, $titleAfter, $changed)
Write-Output ("cursor     : dx={0} dy={1}" -f $curDx, $curDy)
Write-Output ("foreground : stable={0} distinctDuringRun={1} ({2} -> {3})" -f $fgStable, $fgDistinct, $fg0, $fg1)
Write-Output ("samples    : {0}" -f $nsamp)

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$file = Join-Path $OutDir ("e6-result-$stamp.json")
Write-Utf8NoBom $file $json
Write-Output ("written: {0}" -f $file)
