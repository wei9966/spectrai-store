# E3 probe - display topology and synthetic-pen API availability
# Read-only: enumerates monitors, adapters and checks whether the synthetic
# pointer API is exported by user32. Changes nothing.
# 100% ASCII on purpose (PowerShell 5.1 decodes BOM-less .ps1 as ANSI).

[CmdletBinding()]
param(
    [string]$OutDir = ''
)
if ([string]::IsNullOrEmpty($OutDir)) { $OutDir = $PSScriptRoot }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

$cs = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class DispProbe
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorProc cb, IntPtr data);
    private delegate bool MonitorProc(IntPtr hMon, IntPtr hdc, ref RECT r, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfoW(IntPtr hMon, ref MONITORINFO mi);
    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr CreateSyntheticPointerDevice(int pointerType, uint maxCount, int mode);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern void DestroySyntheticPointerDevice(IntPtr dev);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool InjectSyntheticPointerInput(IntPtr dev, IntPtr info, uint count);

    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    private static extern IntPtr GetModuleHandleA(string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    private static extern IntPtr GetProcAddress(IntPtr mod, string name);

    public class Mon { public IntPtr H; public int L, T, R, B, WL, WT, WR, WB; public bool Primary; }

    public static List<Mon> Monitors()
    {
        var res = new List<Mon>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr h, IntPtr hdc, ref RECT r, IntPtr d)
        {
            var mi = new MONITORINFO();
            mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            bool ok = GetMonitorInfoW(h, ref mi);
            res.Add(new Mon
            {
                H = h,
                L = r.Left, T = r.Top, R = r.Right, B = r.Bottom,
                WL = ok ? mi.rcWork.Left : 0, WT = ok ? mi.rcWork.Top : 0,
                WR = ok ? mi.rcWork.Right : 0, WB = ok ? mi.rcWork.Bottom : 0,
                Primary = ok && (mi.dwFlags & 1) != 0
            });
            return true;
        }, IntPtr.Zero);
        return res;
    }

    // null = not exported by this build of user32
    public static bool? HasApi(string name)
    {
        IntPtr u = GetModuleHandleA("user32.dll");
        if (u == IntPtr.Zero) return null;
        return GetProcAddress(u, name) != IntPtr.Zero;
    }

    // create + destroy only; no input is injected.
    // Sweeps (pointerType, feedbackMode) because the documented enum values for
    // POINTER_FEEDBACK_MODE are reported inconsistently across references.
    public static string ProbeDevice(int type, int mode)
    {
        try
        {
            IntPtr d = CreateSyntheticPointerDevice(type, 1, mode);
            if (d == IntPtr.Zero)
                return "{\"created\":false,\"win32Error\":" + Marshal.GetLastWin32Error() + "}";
            DestroySyntheticPointerDevice(d);
            return "{\"created\":true}";
        }
        catch (Exception e) { return "{\"created\":false,\"exception\":\"" + e.GetType().Name + "\"}"; }
    }
}
'@

Add-Type -TypeDefinition $cs -Language CSharp

function Write-Utf8NoBom([string]$path, [string]$text) {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $text, $enc)
}

$mons = [DispProbe]::Monitors()
Write-Output ("monitors: {0}" -f $mons.Count)
foreach ($m in $mons) {
    Write-Output ("  hmon={0} monitor=[{1},{2} - {3},{4}] size={5}x{6} work=[{7},{8} - {9},{10}] primary={11}" -f `
        $m.H, $m.L, $m.T, $m.R, $m.B, ($m.R - $m.L), ($m.B - $m.T), $m.WL, $m.WT, $m.WR, $m.WB, $m.Primary)
}

Write-Output ""
Write-Output ("user32!CreateSyntheticPointerDevice exported : {0}" -f [DispProbe]::HasApi('CreateSyntheticPointerDevice'))
Write-Output ("user32!InjectSyntheticPointerInput exported   : {0}" -f [DispProbe]::HasApi('InjectSyntheticPointerInput'))
Write-Output ("CreateSyntheticPointerDevice sweep (pointerType 2=TOUCH 3=PEN 4=MOUSE x mode 0..3):")
foreach ($t in 2, 3, 4) {
    foreach ($m in 0, 1, 2, 3) {
        Write-Output ("  type={0} mode={1} -> {2}" -f $t, $m, [DispProbe]::ProbeDevice($t, $m))
    }
}

Write-Output ""
Write-Output "display adapters (Win32_VideoController):"
try {
    Get-CimInstance Win32_VideoController -ErrorAction Stop |
        ForEach-Object { Write-Output ("  name='{0}' status={1} pnp='{2}'" -f $_.Name, $_.Status, $_.PNPDeviceID) }
} catch { Write-Output ("  <failed: {0}>" -f $_.Exception.Message) }

Write-Output ""
Write-Output "monitor devices (Get-PnpDevice -Class Monitor):"
try {
    Get-PnpDevice -Class Monitor -ErrorAction Stop |
        ForEach-Object { Write-Output ("  name='{0}' status={1} instance='{2}'" -f $_.FriendlyName, $_.Status, $_.InstanceId) }
} catch { Write-Output ("  <failed: {0}>" -f $_.Exception.Message) }

Write-Output ""
Write-Output "system DPI awareness / metrics:"
Add-Type -AssemblyName System.Windows.Forms
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    Write-Output ("  screen '{0}' bounds={1} primary={2}" -f $s.DeviceName, $s.Bounds, $s.Primary)
}
