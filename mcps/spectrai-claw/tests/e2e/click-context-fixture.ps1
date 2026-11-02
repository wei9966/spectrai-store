# Safe test windows for click-context.test.mjs. Touches nothing but its own marker file.
# "ClawFixtureLogin" reproduces the field failure: a dialog owned by a hidden window, so its
# process has MainWindowHandle=0, and a Pane "button" with no UIA action patterns.
param([string]$Marker, [int]$Left = 80, [int]$Top = 80)
Add-Type -AssemblyName System.Windows.Forms

function Write-Marker([string]$text) { Add-Content -LiteralPath $Marker -Value $text -Encoding UTF8 }

function New-FixtureForm([string]$title, [int]$x, [int]$y) {
  $f = New-Object System.Windows.Forms.Form
  $f.Text = $title
  $f.StartPosition = 'Manual'
  $f.Location = New-Object System.Drawing.Point($x, $y)
  $f.Size = New-Object System.Drawing.Size(320, 200)
  $f.ShowInTaskbar = $false
  $b = New-Object System.Windows.Forms.Button
  $b.Name = "$($title)Button"; $b.Text = "$($title)Button"
  $b.Location = New-Object System.Drawing.Point(10, 10)
  $b.Size = New-Object System.Drawing.Size(280, 40)
  $b.Tag = $title
  $b.add_Click({ param($s, $e) Write-Marker "button:$($s.Tag)" })
  $f.Controls.Add($b)
  $p = New-Object System.Windows.Forms.Panel
  $p.AccessibleName = "$($title)Pane"
  $p.BackColor = [System.Drawing.Color]::LightSteelBlue
  $p.Location = New-Object System.Drawing.Point(10, 70)
  $p.Size = New-Object System.Drawing.Size(280, 60)
  $p.Tag = $title
  $p.add_Click({ param($s, $e) Write-Marker "pane:$($s.Tag)" })
  $f.Controls.Add($p)
  return $f
}

$owner = New-Object System.Windows.Forms.NativeWindow
$cp = New-Object System.Windows.Forms.CreateParams
$owner.CreateHandle($cp) # never shown

$login = New-FixtureForm 'ClawFixtureLogin' $Left $Top
$other = New-FixtureForm 'ClawFixtureOther' ($Left + 400) $Top
$login.Show($owner)
$other.Show($owner)

$p = Get-Process -Id $PID
$p.Refresh()
Write-Output "READY|$($login.Handle.ToInt64())|$($other.Handle.ToInt64())|$PID|$($p.MainWindowHandle.ToInt64())"
[Console]::Out.Flush()

# ponytail: self-destruct so an aborted test run cannot leave windows behind.
$t = New-Object System.Windows.Forms.Timer
$t.Interval = 120000
$t.add_Tick({ [System.Windows.Forms.Application]::Exit() })
$t.Start()
[System.Windows.Forms.Application]::Run()
