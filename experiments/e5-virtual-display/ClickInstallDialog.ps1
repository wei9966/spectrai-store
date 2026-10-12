# E5 helper - click "install" on the driver security dialog FROM AN ELEVATED PROCESS.
#
# Why this is needed: the dialog is owned by an elevated rundll32. A normal
# integrity process cannot drive it - synthetic input is refused by UIPI
# (injection is only permitted towards equal-or-lower integrity targets), and
# window messages are blocked outright. From an elevated process BM_CLICK is
# allowed, and the button captions can also be read (GetWindowText works at
# equal integrity), so we can pick the right button by TEXT instead of by guess.
#
# The label to match is built from code points, so this file stays 100% ASCII
# (PowerShell 5.1 decodes a BOM-less .ps1 as ANSI).

[CmdletBinding()]
param(
    [int]$Rounds = 40,
    [int]$SleepMs = 2000,
    [string]$Log = 'F:\e5vdd\click-log.txt',
    [string]$InstallLog = 'F:\e5vdd\install-log.txt'
)

$ErrorActionPreference = 'Continue'

function Say([string]$m) {
    $line = ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m)
    Write-Host $line
    try { Add-Content -Path $Log -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue } catch { }
}

$wid = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = (New-Object Security.Principal.WindowsPrincipal($wid)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Say ("elevated = " + $admin)
if (-not $admin) { Say 'ABORT: not elevated'; exit 10 }

$cs = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class Sec
{
    private delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr h);

    private const uint BM_CLICK = 0x00F5;
    private const uint WM_COMMAND = 0x0111;

    private static string Txt(IntPtr h)
    {
        var sb = new StringBuilder(512); GetWindowTextW(h, sb, sb.Capacity); return sb.ToString();
    }
    private static string Cls(IntPtr h)
    {
        var sb = new StringBuilder(256); GetClassNameW(h, sb, sb.Capacity); return sb.ToString();
    }

    // Built from code points so the source file needs no non-ASCII bytes.
    // 0x5B89 0x88C5 = "an zhuang" (install); a leading 0x4E0D ("not") marks the
    // cancel variant, so StartsWith() separates the two cleanly.
    public static string InstallLabel()
    {
        return char.ConvertFromUtf32(0x5B89) + char.ConvertFromUtf32(0x88C5);
    }

    public static string ReportAll()
    {
        var sb = new StringBuilder();
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            if (Cls(h) != "#32770") return true;
            sb.Append("dialog hwnd=" + h.ToInt64() + " title='" + Txt(h) + "' buttons:");
            EnumChildWindows(h, delegate(IntPtr k, IntPtr ll)
            {
                if (Cls(k) != "Button") return true;
                sb.Append(" [id=" + GetDlgCtrlID(k) + " '" + Txt(k) + "']");
                return true;
            }, IntPtr.Zero);
            sb.Append(" | ");
            return true;
        }, IntPtr.Zero);
        return sb.ToString();
    }

    // Returns the caption of the button that was clicked, or "" if none matched.
    public static string ClickInstall()
    {
        string want = InstallLabel();
        string clicked = "";
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            if (!IsWindowVisible(h)) return true;
            if (Cls(h) != "#32770") return true;
            bool done = false;
            EnumChildWindows(h, delegate(IntPtr k, IntPtr ll)
            {
                if (Cls(k) != "Button") return true;
                string t = Txt(k);
                if (t.StartsWith(want))
                {
                    SendMessageW(k, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
                    // belt and braces: also tell the parent the control was clicked
                    PostMessageW(h, WM_COMMAND, new IntPtr(GetDlgCtrlID(k)), k);
                    clicked = t;
                    done = true;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            return !done;
        }, IntPtr.Zero);
        return clicked;
    }
}
'@

Add-Type -TypeDefinition $cs -Language CSharp

Say ("looking for the install button (label starts with " + [Sec]::InstallLabel() + ")")
Say ("dialogs seen: " + [Sec]::ReportAll())

for ($i = 1; $i -le $Rounds; $i++) {
    if (Test-Path $InstallLog) {
        $done = Select-String -Path $InstallLog -Pattern 'install done' -Quiet -ErrorAction SilentlyContinue
        if ($done) { Say "install log reports DONE, stopping"; break }
    }
    $clicked = [Sec]::ClickInstall()
    if ($clicked -ne '') { Say ("round " + $i + ": CLICKED '" + $clicked + "'") }
    else { Say ("round " + $i + ": no matching dialog") }
    Start-Sleep -Milliseconds $SleepMs
}

Say ("final dialogs: " + [Sec]::ReportAll())
Say "click helper done"
exit 0
