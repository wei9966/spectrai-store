# E5 recon - privileges, existing display drivers, driver-store state.
# Read-only except 'net session' which only probes for admin rights.
# 100% ASCII on purpose (PS 5.1 decodes BOM-less .ps1 as ANSI).

[CmdletBinding()]
param([string]$OutDir = '')
if ([string]::IsNullOrEmpty($OutDir)) { $OutDir = $PSScriptRoot }

Write-Output "=== privileges ==="
try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object Security.Principal.WindowsPrincipal($id)
    Write-Output ("user      : {0}" -f $id.Name)
    Write-Output ("isAdmin   : {0}" -f $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
    Write-Output ("integrity : {0}" -f $id.ImpersonationLevel)
} catch { Write-Output ("<failed: {0}>" -f $_.Exception.Message) }

Write-Output ""
Write-Output "=== OS ==="
try {
    $os = Get-CimInstance Win32_OperatingSystem
    Write-Output ("caption   : {0}" -f $os.Caption)
    Write-Output ("version   : {0} build {1}" -f $os.Version, $os.BuildNumber)
} catch { Write-Output ("<failed: {0}>" -f $_.Exception.Message) }

Write-Output ""
Write-Output "=== display class devices ==="
try {
    Get-PnpDevice -Class Display -ErrorAction Stop | Sort-Object InstanceId | ForEach-Object {
        Write-Output ("  {0,-12} {1,-8} {2}" -f $_.Status, $_.Class, $_.FriendlyName)
        Write-Output ("      instance={0}" -f $_.InstanceId)
        Write-Output ("      problem={0}  driver={1}" -f $_.Problem, $_.ProblemDescription)
    }
} catch { Write-Output ("  <failed: {0}>" -f $_.Exception.Message) }

Write-Output ""
Write-Output "=== monitor class devices (only OK ones matter) ==="
try {
    Get-PnpDevice -Class Monitor -ErrorAction Stop | Sort-Object InstanceId | ForEach-Object {
        Write-Output ("  {0,-8} {1}  instance={2}" -f $_.Status, $_.FriendlyName, $_.InstanceId)
    }
} catch { Write-Output ("  <failed: {0}>" -f $_.Exception.Message) }

Write-Output ""
Write-Output "=== driver store: anything IddCx-ish already staged ==="
try {
    pnputil /enum-drivers 2>&1 | Select-String -Pattern 'Published Name|Original Name|Provider Name|Class Name' -Context 0,0 |
        Select-Object -First 200 | ForEach-Object { $_.Line.Trim() }
} catch { Write-Output ("  <failed: {0}>" -f $_.Exception.Message) }

Write-Output ""
Write-Output "=== services that own the virtual display adapters ==="
foreach ($n in 'GameViewer','MuMuVMMSVC','nemu','SunloginClient','OrayService','ToDesk_Service') {
    try {
        $s = Get-Service -Name $n -ErrorAction Stop
        Write-Output ("  {0,-18} status={1} startType={2}" -f $s.Name, $s.Status, $s.StartType)
    } catch { Write-Output ("  {0,-18} <not installed>" -f $n) }
}

Write-Output ""
Write-Output "=== test signing / integrity state (bcdedit needs admin) ==="
try {
    $b = bcdedit /enum '{current}' 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Output ("  bcdedit exit={0} (probably not elevated)" -f $LASTEXITCODE) }
    else { $b | Select-String -Pattern 'testsigning|nointegritychecks|hypervisorlaunchtype' | ForEach-Object { "  " + $_.Line.Trim() } }
} catch { Write-Output ("  <failed: {0}>" -f $_.Exception.Message) }

Write-Output ""
Write-Output "=== display adapters seen by WMI (name + driver version) ==="
try {
    Get-CimInstance Win32_VideoController | ForEach-Object {
        Write-Output ("  name='{0}' driver='{1}' ver={2} status={3}" -f $_.Name, $_.InstalledDisplayDrivers, $_.DriverVersion, $_.Status)
    }
} catch { Write-Output ("  <failed: {0}>" -f $_.Exception.Message) }
