# E6 control target - a plain Win32 (WinForms) button, to compare with Chromium.
# Title carries the click count, same readout idea as the HTML page.
# Launched in its own process so it is a genuinely foreign window.
# 100% ASCII on purpose.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'E6WF-0'
$form.Width = 420
$form.Height = 300
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(3900, 60)

$btn = New-Object System.Windows.Forms.Button
$btn.Text = 'E6WFButton'
$btn.Location = New-Object System.Drawing.Point(60, 60)
$btn.Size = New-Object System.Drawing.Size(200, 50)
$btn.Name = 'e6wfbtn'

$chk = New-Object System.Windows.Forms.CheckBox
$chk.Text = 'E6WFCheck'
$chk.Location = New-Object System.Drawing.Point(60, 130)
$chk.Size = New-Object System.Drawing.Size(200, 30)
$chk.Name = 'e6wfchk'

$script:n = 0
$btn.Add_Click({ $script:n++; $form.Text = 'E6WF-' + $script:n })
$chk.Add_CheckedChanged({ $form.Text = 'E6WF-' + $script:n + '-' + $chk.Checked })

$form.Controls.Add($btn)
$form.Controls.Add($chk)
[void]$form.ShowDialog()
