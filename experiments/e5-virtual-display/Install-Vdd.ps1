# E5 - install the IddCx virtual display driver (MUST run elevated)
# ---------------------------------------------------------------------------
# Installs the signed Virtual Display Driver staged by the caller:
#   1. pnputil /add-driver  MttVDD.inf /install     -> stage into driver store
#   2. devcon install MttVDD.inf Root\MttVDD        -> create the root device
#   3. report before/after display inventory + rollback commands
#
# Deliberately does NOT:
#   - reboot (devcon is called without -r)
#   - install the bundled virtual AUDIO driver
#   - delete or modify any existing device/driver
#   - run the 171 MB GUI control app
#
# Everything is appended to a log file, because an elevated process launched
# via Start-Process -Verb RunAs has no usable stdout for the caller.
#
# 100% ASCII on purpose (PowerShell 5.1 decodes a BOM-less .ps1 as ANSI).

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SrcDir,
    [Parameter(Mandatory = $true)][string]$Devcon,
    [Parameter(Mandatory = $true)][string]$LogPath
)

$ErrorActionPreference = 'Continue'

function Say([string]$m) {
    $line = ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m)
    Write-Host $line
    try { Add-Content -Path $LogPath -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue } catch { }
}

Say "=== E5 VDD install start ==="
Say ("ps version : " + $PSVersionTable.PSVersion)

# ---- 0. elevation gate ----
$wid = [Security.Principal.WindowsIdentity]::GetCurrent()
$wpr = New-Object Security.Principal.WindowsPrincipal($wid)
$isAdmin = $wpr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Say ("user       : " + $wid.Name)
Say ("elevated   : " + $isAdmin)
if (-not $isAdmin) { Say "ABORT: not elevated, refusing to continue"; exit 10 }

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

$inf = Join-Path $SrcDir 'MttVDD.inf'
$dll = Join-Path $SrcDir 'MttVDD.dll'
$cat = Join-Path $SrcDir 'mttvdd.cat'
Say ("src dir    : " + $SrcDir)
Say ("inf        : " + $inf + "  exists=" + (Test-Path $inf))
Say ("dll        : " + $dll + "  exists=" + (Test-Path $dll))
Say ("cat        : " + $cat + "  exists=" + (Test-Path $cat))
Say ("devcon     : " + $Devcon + "  exists=" + (Test-Path $Devcon))
if (-not (Test-Path $inf) -or -not (Test-Path $Devcon)) { Say "ABORT: staged files missing"; exit 11 }

function Snapshot([string]$tag) {
    Say ("--- $tag ---")
    try {
        $adapters = @(Get-CimInstance Win32_VideoController -ErrorAction Stop)
        Say ("video controllers : " + $adapters.Count)
        foreach ($a in $adapters) { Say ("   " + $a.Name + "  [" + $a.Status + "]") }
    } catch { Say ("   video controller enum failed: " + $_.Exception.Message) }

    try {
        $screens = @([System.Windows.Forms.Screen]::AllScreens)
        Say ("screens           : " + $screens.Count)
        foreach ($s in $screens) { Say ("   " + $s.DeviceName + " bounds=" + $s.Bounds + " primary=" + $s.Primary) }
    } catch { Say ("   screen enum failed: " + $_.Exception.Message) }

    try {
        $disp = @(Get-PnpDevice -Class Display -ErrorAction Stop)
        Say ("display class devs: " + $disp.Count)
        foreach ($d in $disp) { Say ("   " + $d.Status + "  " + $d.FriendlyName + "  " + $d.InstanceId + "  problem=" + $d.Problem) }
    } catch { Say ("   pnp enum failed: " + $_.Exception.Message) }
}

Snapshot 'BEFORE'

# ---- 1. stage the driver into the driver store ----
Say "--- pnputil /add-driver ---"
$pnputilOut = & pnputil.exe /add-driver $inf /install 2>&1
$pnputilExit = $LASTEXITCODE
foreach ($l in $pnputilOut) { Say ("   " + $l) }
Say ("pnputil exit = " + $pnputilExit)

# ---- 2. create the root-enumerated device node ----
Say "--- devcon install (no -r: never auto-reboot) ---"
Push-Location $SrcDir
$devconOut = & $Devcon install $inf 'Root\MttVDD' 2>&1
$devconExit = $LASTEXITCODE
Pop-Location
foreach ($l in $devconOut) { Say ("   " + $l) }
Say ("devcon exit  = " + $devconExit)

# ---- 3. let PnP settle, then re-inspect ----
for ($i = 1; $i -le 6; $i++) {
    Start-Sleep -Seconds 2
    $hit = @(Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -like '*MttVDD*' -or $_.InstanceId -like '*MttVDD*' })
    Say ("settle " + $i + "/6: MttVDD devices = " + $hit.Count)
    if ($hit.Count -gt 0) { break }
}

Snapshot 'AFTER'

# ---- 4. rollback recipe (printed, not executed) ----
Say "--- rollback recipe (NOT executed) ---"
try {
    $mine = @(Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like '*MttVDD*' })
    foreach ($d in $mine) {
        Say ("   pnputil /remove-device `"" + $d.InstanceId + "`"")
    }
} catch { }
try {
    $drv = & pnputil.exe /enum-drivers 2>&1 | Select-String -Pattern 'MttVDD' -Context 6,0
    foreach ($l in $drv) { Say ("   driver-store hit: " + $l.Line.Trim()) }
    Say "   then: pnputil /delete-driver <oemNN.inf> /uninstall"
} catch { }

Say "=== E5 VDD install done ==="
exit 0
