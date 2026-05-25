Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Computer Use Native Controls Demo'
$form.Name = 'computerUseNativeControlsDemo'
$form.StartPosition = 'CenterScreen'
$form.Width = 520
$form.Height = 360
$form.TopMost = $false

$title = New-Object System.Windows.Forms.Label
$title.Name = 'titleLabel'
$title.Text = 'Computer Use Native Controls Demo'
$title.AutoSize = $true
$title.Font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
$title.Location = New-Object System.Drawing.Point(24, 20)
$form.Controls.Add($title)

$nameLabel = New-Object System.Windows.Forms.Label
$nameLabel.Name = 'nameLabel'
$nameLabel.Text = 'Benchmark text:'
$nameLabel.AutoSize = $true
$nameLabel.Location = New-Object System.Drawing.Point(28, 76)
$form.Controls.Add($nameLabel)

$nameInput = New-Object System.Windows.Forms.TextBox
$nameInput.Name = 'nameInput'
$nameInput.Text = ''
$nameInput.Width = 300
$nameInput.Location = New-Object System.Drawing.Point(150, 72)
$form.Controls.Add($nameInput)

$enableCheckbox = New-Object System.Windows.Forms.CheckBox
$enableCheckbox.Name = 'enableCheckbox'
$enableCheckbox.Text = 'Enable semantic action'
$enableCheckbox.AutoSize = $true
$enableCheckbox.Location = New-Object System.Drawing.Point(150, 112)
$form.Controls.Add($enableCheckbox)

$choiceLabel = New-Object System.Windows.Forms.Label
$choiceLabel.Name = 'choiceLabel'
$choiceLabel.Text = 'Provider mode:'
$choiceLabel.AutoSize = $true
$choiceLabel.Location = New-Object System.Drawing.Point(28, 154)
$form.Controls.Add($choiceLabel)

$choiceCombo = New-Object System.Windows.Forms.ComboBox
$choiceCombo.Name = 'choiceCombo'
$choiceCombo.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
$choiceCombo.Items.Add('UIA semantic') | Out-Null
$choiceCombo.Items.Add('Vision fallback') | Out-Null
$choiceCombo.Items.Add('HID fallback') | Out-Null
$choiceCombo.SelectedIndex = 0
$choiceCombo.Width = 180
$choiceCombo.Location = New-Object System.Drawing.Point(150, 150)
$form.Controls.Add($choiceCombo)

$statusText = New-Object System.Windows.Forms.Label
$statusText.Name = 'statusText'
$statusText.Text = 'Ready'
$statusText.AutoSize = $true
$statusText.Location = New-Object System.Drawing.Point(150, 206)
$form.Controls.Add($statusText)

$applyButton = New-Object System.Windows.Forms.Button
$applyButton.Name = 'applyButton'
$applyButton.Text = 'Apply'
$applyButton.Width = 120
$applyButton.Height = 36
$applyButton.Location = New-Object System.Drawing.Point(150, 248)
$applyButton.Add_Click({
  $statusText.Text = 'Applied: ' + $nameInput.Text + ' / enabled=' + $enableCheckbox.Checked + ' / mode=' + $choiceCombo.Text
})
$form.Controls.Add($applyButton)

$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Name = 'closeButton'
$closeButton.Text = 'Close'
$closeButton.Width = 120
$closeButton.Height = 36
$closeButton.Location = New-Object System.Drawing.Point(292, 248)
$closeButton.Add_Click({ $form.Close() })
$form.Controls.Add($closeButton)

[void]$form.ShowDialog()
