/**
 * Desktop automation tools for SpectrAI Claw.
 * Uses PersistentShell for all PowerShell operations (single process, pre-loaded DLLs).
 * All coordinates are in logical pixels — NO DPI conversion needed for non-DPI-aware process.
 *
 * === TOOL PRIORITY GUIDE (embedded in tool descriptions for AI) ===
 *
 * CLICK WORKFLOW (most common):
 *   1. screenshot(annotate=true)     → See the full screen with numbered elements
 *   2. click_element(number)          → Click a numbered element (MOST PRECISE)
 *   3. zoom_screenshot(x,y,w,h)      → If target not annotated, zoom in for detail
 *   4. screenshot_click(percentX/Y)   → Fallback: click by position in screenshot
 *   5. mouse_click(x,y)              → Last resort: raw coordinate click
 *
 * OBSERVATION:
 *   - screenshot    → Full screen overview
 *   - zoom_screenshot → Detail view of specific area
 *   - get_screen_info → Resolution and DPI info
 *
 * INTERACTION:
 *   - click_element  → Best way to click (uses annotated element coordinates)
 *   - keyboard_type / keyboard_press / keyboard_hotkey → Text input and shortcuts
 *   - mouse_scroll   → Scroll content
 *
 * WINDOW MANAGEMENT:
 *   - window_list / window_focus / window_close
 *
 * ADVANCED (rarely needed):
 *   - uia_find_element / uia_get_tree → Direct UIA queries for native apps
 */
import { existsSync, mkdirSync } from 'fs';
import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { registerTool } from './registry.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// OCR worker script path (runs in separate STA process for WinRT async compatibility)
const OCR_WORKER_PS1 = join(__dirname, '..', 'scripts', 'ocr-worker.ps1');
import { shell } from '../helpers/PersistentShell.js';
import { PolicyEngine } from '../security/PolicyEngine.js';
const sn = PolicyEngine.sanitizeNumber.bind(PolicyEngine);
const sp = PolicyEngine.sanitizeForPowerShell.bind(PolicyEngine);
const screenshotMetaMap = new Map();
let lastScreenshotPath = '';
let lastAnnotatedPath = '';
export function registerDesktopTools() {
    // 1. screenshot — save to file, return path for AI to read natively
    // Grid labels show ABSOLUTE screen coordinates so AI can pass them directly to mouse_click.
    registerTool('screenshot', '★ STEP 1: Take a FULL screenshot at native resolution. Always start here.\n\n' +
        'Returns file path + auto-detected UI elements. Use Read tool to VIEW the image first — understand the full layout before acting.\n\n' +
        'WORKFLOW (follow strictly):\n' +
        '1. screenshot() → Read image → understand layout, identify target area\n' +
        '2. If target has a numbered marker → click_element(number) — DONE\n' +
        '3. If target is NOT annotated (icons, images, web app buttons) → zoom_screenshot(x,y,w,h) on that area → read grid coordinates → mouse_click(x,y)\n\n' +
        'IMPORTANT: The image is captured at NATIVE resolution for maximum clarity. Read the image carefully to identify exactly where your target is before zooming.', {
        type: 'object',
        properties: {
            x: { type: 'number', description: 'Left X coordinate (logical pixels)' },
            y: { type: 'number', description: 'Top Y coordinate (logical pixels)' },
            width: { type: 'number', description: 'Width of capture region (logical pixels)' },
            height: { type: 'number', description: 'Height of capture region (logical pixels)' },
            maxWidth: { type: 'number', description: 'Max output image width in pixels. Default: 0 (no scaling, native resolution). Set a value like 1568 to reduce file size.' },
            quality: { type: 'number', description: 'JPEG compression quality 1-100. Default: 95 (high quality for accurate AI analysis)' },
            savePath: { type: 'string', description: 'File path to save screenshot. Default: auto-generated temp file (.png)' },
            allScreens: { type: 'boolean', description: 'Capture all monitors as one image (virtual screen). Default: false' },
            monitor: { type: 'number', description: 'Monitor index (0-based). Default: 0 (primary). Ignored if allScreens=true' },
            grid: { type: 'boolean', description: 'Overlay coordinate grid. Default: false' },
            annotate: { type: 'boolean', description: 'Auto-detect interactive elements via UIA and draw numbered markers. Use click_element(number) to click. Default: true' },
        },
        additionalProperties: false,
    }, async (args) => {
        const quality = args.quality != null ? Math.max(1, Math.min(100, sn(args.quality))) : 95;
        const maxWidth = args.maxWidth != null ? sn(args.maxWidth) : 0;
        const allScreens = args.allScreens === true;
        const monitorIdx = args.monitor != null ? sn(args.monitor) : 0;
        const grid = args.grid === true;
        const annotate = args.annotate !== false; // default ON
        // Determine save path
        let outPath;
        if (args.savePath) {
            outPath = resolve(args.savePath);
            const dir = dirname(outPath);
            if (!existsSync(dir))
                mkdirSync(dir, { recursive: true });
        }
        else {
            outPath = ''; // Will be set by PowerShell
        }
        const saveLine = outPath
            ? `$outFile = '${sp(outPath.replace(/\\/g, '\\\\'))}'`
            : `$outFile = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "spectrai_ss_$(Get-Date -Format 'yyyyMMdd_HHmmss_fff').png")`;
        // Build capture region script
        let captureRegion;
        if (args.x != null || args.y != null || args.width != null || args.height != null) {
            const rx = args.x != null ? sn(args.x) : 0;
            const ry = args.y != null ? sn(args.y) : 0;
            captureRegion = `
$captureX = ${rx}
$captureY = ${ry}
$captureW = ${args.width != null ? sn(args.width) : 0}
$captureH = ${args.height != null ? sn(args.height) : 0}
if ($captureW -le 0) { $captureW = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width - $captureX }
if ($captureH -le 0) { $captureH = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height - $captureY }
`;
        }
        else if (allScreens) {
            captureRegion = `
$captureX = [System.Windows.Forms.SystemInformation]::VirtualScreen.X
$captureY = [System.Windows.Forms.SystemInformation]::VirtualScreen.Y
$captureW = [System.Windows.Forms.SystemInformation]::VirtualScreen.Width
$captureH = [System.Windows.Forms.SystemInformation]::VirtualScreen.Height
`;
        }
        else {
            captureRegion = `
$screens = [System.Windows.Forms.Screen]::AllScreens
$monIdx = ${monitorIdx}
if ($monIdx -ge $screens.Length) { $monIdx = 0 }
$mon = $screens[$monIdx]
$captureX = $mon.Bounds.X
$captureY = $mon.Bounds.Y
$captureW = $mon.Bounds.Width
$captureH = $mon.Bounds.Height
`;
        }
        const script = `
${captureRegion}
${saveLine}
$bmp = New-Object System.Drawing.Bitmap($captureW, $captureH)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($captureX, $captureY, 0, 0, (New-Object System.Drawing.Size($captureW, $captureH)))
$g.Dispose()
$maxW = ${maxWidth}
if ($maxW -gt 0 -and $bmp.Width -gt $maxW) {
    $ratio = $maxW / $bmp.Width
    $newW = [int]($bmp.Width * $ratio)
    $newH = [int]($bmp.Height * $ratio)
    $resized = New-Object System.Drawing.Bitmap($newW, $newH)
    $g2 = [System.Drawing.Graphics]::FromImage($resized)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g2.DrawImage($bmp, 0, 0, $newW, $newH)
    $g2.Dispose()
    $bmp.Dispose()
    $bmp = $resized
}
if (${grid ? '$true' : '$false'}) {
    $origW = $captureW
    $origH = $captureH
    $scaleRatio = $bmp.Width / $origW
    $gd = [System.Drawing.Graphics]::FromImage($bmp)
    $gd.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    # Adaptive grid step: smaller regions get finer grids
    $step = 100
    if ($origW -le 600 -or $origH -le 600) { $step = 50 }
    if ($origW -le 300 -or $origH -le 300) { $step = 25 }
    $gridPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(60, 0, 180, 255), 1)
    $majorPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(100, 0, 120, 255), 1)
    $fontSize = 9
    if ($step -le 50) { $fontSize = 8 }
    if ($step -le 25) { $fontSize = 7 }
    $font = New-Object System.Drawing.Font('Arial', $fontSize)
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, 0, 80, 220))
    $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(180, 255, 255, 255))
    # ABSOLUTE coordinates: add captureX/Y offset so labels match screen coordinates directly
    $startX = [int]([Math]::Ceiling($captureX / $step) * $step)
    for ($absX = $startX; $absX -lt ($captureX + $origW); $absX += $step) {
        $relX = $absX - $captureX
        $px = [int]($relX * $scaleRatio)
        $pen = if (($absX % ($step * 2)) -eq 0) { $majorPen } else { $gridPen }
        $gd.DrawLine($pen, $px, 0, $px, $bmp.Height)
        $lbl = "$absX"
        $sz = $gd.MeasureString($lbl, $font)
        $gd.FillRectangle($bgBrush, $px + 2, 2, $sz.Width, $sz.Height)
        $gd.DrawString($lbl, $font, $brush, ($px + 2), 2)
    }
    $startY = [int]([Math]::Ceiling($captureY / $step) * $step)
    for ($absY = $startY; $absY -lt ($captureY + $origH); $absY += $step) {
        $relY = $absY - $captureY
        $py = [int]($relY * $scaleRatio)
        $pen = if (($absY % ($step * 2)) -eq 0) { $majorPen } else { $gridPen }
        $gd.DrawLine($pen, 0, $py, $bmp.Width, $py)
        $lbl = "$absY"
        $sz = $gd.MeasureString($lbl, $font)
        $gd.FillRectangle($bgBrush, 2, $py + 2, $sz.Width, $sz.Height)
        $gd.DrawString($lbl, $font, $brush, 2, ($py + 2))
    }
    # Origin marker at top-left showing the absolute start coordinate
    $originLbl = "($captureX,$captureY)"
    $osz = $gd.MeasureString($originLbl, $font)
    $gd.FillRectangle($bgBrush, 0, 0, $osz.Width + 4, $osz.Height + 2)
    $gd.DrawString($originLbl, $font, $brush, 2, 1)
    $gridPen.Dispose(); $majorPen.Dispose(); $font.Dispose(); $brush.Dispose(); $bgBrush.Dispose(); $gd.Dispose()
}
if ($outFile -match '\\.png$') {
    $bmp.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)
} else {
    $encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]${quality})
    $bmp.Save($outFile, $global:jpegCodec, $encParams)
}
$info = Get-Item $outFile
$imgCheck = [System.Drawing.Image]::FromFile($outFile)
$imgW = $imgCheck.Width
$imgH = $imgCheck.Height
$imgCheck.Dispose()
$bmp.Dispose()
"$($outFile)|$($info.Length)|$($captureW)x$($captureH)|$($captureX)|$($captureY)|$($imgW)|$($imgH)"
`;
        const result = await shell.exec(script, 20000);
        if (result.exitCode !== 0) {
            return { isError: true, content: [{ type: 'text', text: `Screenshot failed: ${result.stderr}` }] };
        }
        const parts = result.stdout.trim().split('|');
        const filePath = parts[0];
        const fileSize = parts[1] || '?';
        const capturedSize = parts[2] || '?';
        const originX = parseInt(parts[3] || '0', 10);
        const originY = parseInt(parts[4] || '0', 10);
        const imageW = parseInt(parts[5] || '0', 10);
        const imageH = parseInt(parts[6] || '0', 10);
        const [capW, capH] = capturedSize.split('x').map(Number);
        // Store metadata for screenshot_click
        const meta = {
            captureX: originX, captureY: originY,
            captureW: capW || imageW, captureH: capH || imageH,
            imageW, imageH,
        };
        screenshotMetaMap.set(filePath, meta);
        lastScreenshotPath = filePath;
        // UIA annotation: detect interactive elements and draw numbered markers
        let elementListText = '';
        if (annotate) {
            try {
                const cw = meta.captureW, ch = meta.captureH;
                const cx = meta.captureX, cy = meta.captureY;
                const imgPathEscaped = sp(filePath.replace(/\\/g, '\\\\'));
                const annotateScript = `
$captureX = ${cx}; $captureY = ${cy}; $captureW = ${cw}; $captureH = ${ch}
$imgPath = '${imgPathEscaped}'

# ====== Phase 0: Force Chrome/Electron accessibility tree ======
$chromeForced = $false
try {
    $centerPt = New-Object System.Windows.Point(($captureX + $captureW/2), ($captureY + $captureH/2))
    $targetEl = [Windows.Automation.AutomationElement]::FromPoint($centerPt)
    $window = $null
    $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
    $cur = $targetEl
    while ($cur -ne $null -and $cur -ne [Windows.Automation.AutomationElement]::RootElement) {
        if ($cur.Current.ControlType -eq [Windows.Automation.ControlType]::Window) { $window = $cur; break }
        $cur = $walker.GetParent($cur)
    }
    if (-not $window) { $window = [Windows.Automation.AutomationElement]::RootElement }

    # Detect Chrome/Electron/Edge — check ClassName of the window
    $winClass = $window.Current.ClassName
    $isChromeApp = ($winClass -match 'Chrome_WidgetWin' -or $winClass -match 'Electron')
    if ($isChromeApp) {
        $winHandle = $window.Current.NativeWindowHandle
        if ($winHandle -ne 0) {
            $hwnd = [IntPtr]::new($winHandle)
            # Find Chrome_RenderWidgetHostHWND child and force IAccessible
            $found = [Win32]::FindChromeRenderWidget($hwnd)
            if ($found) {
                $forceResult = [Win32]::ForceAccessibility([Win32]::chromeRenderHwnd)
                $chromeForced = $forceResult
                if ($forceResult) {
                    Start-Sleep -Milliseconds 500  # Give Chrome time to build accessibility tree
                }
            }
        }
    }
} catch {
    Write-Output "CHROME_FORCE_ERR:$($_.Exception.Message)"
}

# ====== Phase 1: UIA element detection ======
$filtered = @()
$idx = 1
try {
    if (-not $window) {
        $centerPt = New-Object System.Windows.Point(($captureX + $captureW/2), ($captureY + $captureH/2))
        $targetEl = [Windows.Automation.AutomationElement]::FromPoint($centerPt)
        $window = $null
        $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
        $cur = $targetEl
        while ($cur -ne $null -and $cur -ne [Windows.Automation.AutomationElement]::RootElement) {
            if ($cur.Current.ControlType -eq [Windows.Automation.ControlType]::Window) { $window = $cur; break }
            $cur = $walker.GetParent($cur)
        }
        if (-not $window) { $window = [Windows.Automation.AutomationElement]::RootElement }
    }

    # If Chrome was forced, re-fetch the window element to get updated tree
    if ($chromeForced) {
        try {
            $window = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new($window.Current.NativeWindowHandle))
        } catch {}
    }

    $allEls = $window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
    $uiaTotal = 0
    foreach ($el in $allEls) {
        $uiaTotal++
        $rect = $el.Current.BoundingRectangle
        if ($rect.IsEmpty -or $rect.Width -le 2 -or $rect.Height -le 2) { continue }
        if ($rect.Width -gt $captureW -or $rect.Height -gt $captureH) { continue }
        $elCx = [int]($rect.X + $rect.Width / 2)
        $elCy = [int]($rect.Y + $rect.Height / 2)
        if ($elCx -lt $captureX -or $elCx -ge ($captureX + $captureW)) { continue }
        if ($elCy -lt $captureY -or $elCy -ge ($captureY + $captureH)) { continue }
        $name = $el.Current.Name
        $aid = $el.Current.AutomationId
        $ct = $el.Current.ControlType.ProgrammaticName
        # Accept elements with name, automationId, or actionable control types even without name
        $label = if ($name) { $name } elseif ($aid) { $aid } else { '' }
        $isClickable = ($ct -match 'Button|Hyperlink|MenuItem|TabItem|ListItem|CheckBox|RadioButton|ComboBox|Slider|Image')
        if (-not $label -and -not $isClickable) { continue }
        if (-not $label) { $label = $ct -replace 'ControlType\\.', '' }
        $filtered += @{N=$idx; Name=$label; CT=$ct; CX=$elCx; CY=$elCy; W=[int]$rect.Width; H=[int]$rect.Height; Src='UIA'}
        $idx++
        if ($idx -gt 80) { break }
    }
    Write-Output "UIA_STATS:total=$uiaTotal,filtered=$($filtered.Count),chromeForced=$chromeForced"
} catch {
    Write-Output "UIA_ERROR:$($_.Exception.Message)"
}

# ====== Phase 2: OCR fallback if UIA found few elements ======
# WinRT async requires STA thread. PersistentShell runs MTA (STA blocks ReadLine).
# Solution: run external ocr-worker.ps1 in a separate powershell.exe -STA process.
if ($filtered.Count -lt 10) {
    try {
        $ocrWorker = '${OCR_WORKER_PS1.replace(/\\/g, '\\\\')}'.Replace('\\\\','\\')
        $ocrImgPath = $imgPath.Replace('\\\\','\\')
        $ocrOut = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "spectrai_ocr_$(Get-Date -Format 'yyyyMMdd_HHmmss_fff').txt")

        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'powershell.exe'
        $psi.Arguments = '-NoProfile -STA -ExecutionPolicy Bypass -File "' + $ocrWorker + '" -ImgPath "' + $ocrImgPath + '" -CaptureX ' + $captureX + ' -CaptureY ' + $captureY + ' -CaptureW ' + $captureW + ' -CaptureH ' + $captureH + ' -OutFile "' + $ocrOut + '"'
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardError = $true
        $proc = [System.Diagnostics.Process]::Start($psi)
        $stderr = $proc.StandardError.ReadToEnd()
        $proc.WaitForExit(20000)
        if ($proc.ExitCode -ne 0) { Write-Output "OCR_PROC_ERR:exit=$($proc.ExitCode),stderr=$stderr" }

        $ocrExists = Test-Path $ocrOut
        $ocrSize = if ($ocrExists) { (Get-Item $ocrOut).Length } else { 0 }
        if ($ocrExists -and $ocrSize -gt 0) {
            $ocrLines = Get-Content $ocrOut -Encoding UTF8
            $ocrCount = 0
            foreach ($ol in $ocrLines) {
                $parts = $ol.Split('|')
                if ($parts.Count -ge 5) {
                    $filtered += @{N=$idx; Name=$parts[0]; CT='OCR.Text'; CX=[int]$parts[1]; CY=[int]$parts[2]; W=[int]$parts[3]; H=[int]$parts[4]; Src='OCR'}
                    $idx++
                    $ocrCount++
                    if ($idx -gt 80) { break }
                }
            }
            Write-Output "OCR_DEBUG:words=$ocrCount,lines=$($ocrLines.Count),size=$ocrSize"
        } else {
            Write-Output "OCR_DIAG:exists=$ocrExists,size=$ocrSize,exit=$($proc.ExitCode),stderr=$stderr,outpath=$ocrOut,imgpath=$imgPath,worker=$ocrWorker"
        }
        Remove-Item $ocrOut -ErrorAction SilentlyContinue
    } catch {
        Write-Output "OCR_ERROR:$($_.Exception.Message)"
    }
}

# ====== Phase 3: Draw annotations on image ======
if ($filtered.Count -gt 0) {
    # Load image via stream to avoid file locking (GDI+ locks file when loading from path)
    $fileBytes = [System.IO.File]::ReadAllBytes($imgPath)
    $ms = New-Object System.IO.MemoryStream(,$fileBytes)
    $bmp = [System.Drawing.Bitmap]::new($ms)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $font = New-Object System.Drawing.Font('Arial', 9, [System.Drawing.FontStyle]::Bold)
    $labelFont = New-Object System.Drawing.Font('Arial', 7)
    $redBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(230, 230, 30, 30))
    $greenBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(230, 30, 150, 30))
    $whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(180, 255, 255, 0), 2)
    $ocrPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(180, 0, 255, 100), 2)
    $scaleX = $bmp.Width / $captureW
    $scaleY = $bmp.Height / $captureH

    foreach ($el in $filtered) {
        $imgPx = [int](($el.CX - $captureX) * $scaleX)
        $imgPy = [int](($el.CY - $captureY) * $scaleY)
        $elImgW = [Math]::Max([int]($el.W * $scaleX), 20)
        $elImgH = [Math]::Max([int]($el.H * $scaleY), 20)
        $isOcr = $el.Src -eq 'OCR'
        $pen = if ($isOcr) { $ocrPen } else { $borderPen }
        $bg = if ($isOcr) { $greenBrush } else { $redBrush }

        # Bounding box
        $g.DrawRectangle($pen, ($imgPx - $elImgW/2), ($imgPy - $elImgH/2), $elImgW, $elImgH)
        # Number badge
        $r = 10
        $g.FillEllipse($bg, ($imgPx - $r), ($imgPy - $elImgH/2 - $r*2 - 2), ($r * 2), ($r * 2))
        $lbl = "$($el.N)"
        $sz = $g.MeasureString($lbl, $font)
        $g.DrawString($lbl, $font, $whiteBrush, ($imgPx - $sz.Width/2), ($imgPy - $elImgH/2 - $r*2 - 2 + ($r - $sz.Height/2)))
        # Name label
        $nameLbl = $el.Name
        if ($nameLbl.Length -gt 15) { $nameLbl = $nameLbl.Substring(0, 12) + '...' }
        $nsz = $g.MeasureString($nameLbl, $labelFont)
        $g.FillRectangle((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(180,0,0,0))), ($imgPx - $nsz.Width/2), ($imgPy + $elImgH/2 + 2), $nsz.Width, $nsz.Height)
        $g.DrawString($nameLbl, $labelFont, $whiteBrush, ($imgPx - $nsz.Width/2), ($imgPy + $elImgH/2 + 2))
    }
    $font.Dispose(); $labelFont.Dispose(); $redBrush.Dispose(); $greenBrush.Dispose()
    $whiteBrush.Dispose(); $borderPen.Dispose(); $ocrPen.Dispose(); $g.Dispose()
    $bmp.Save($imgPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $ms.Dispose()
}

# Output element list
foreach ($el in $filtered) { Write-Output "$($el.N)|$($el.Name)|$($el.CT)|$($el.CX)|$($el.CY)" }
`;
                const annotateResult = await shell.exec(annotateScript, 45000);
                const elements = [];
                const rawLines = annotateResult.stdout.trim().split('\n');
                const debugLines = [];
                for (const line of rawLines) {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('UIA_ERROR:') || trimmed.startsWith('UIA_STATS:') || trimmed.startsWith('CHROME_FORCE_ERR:') || trimmed.startsWith('OCR_ERROR:') || trimmed.startsWith('OCR_DEBUG:') || trimmed.startsWith('OCR_DIAG:') || trimmed.startsWith('OCR_PROC_ERR:')) {
                        debugLines.push(trimmed);
                        continue;
                    }
                    const p = trimmed.split('|');
                    if (p.length >= 5 && p[0] && p[3] && p[4]) {
                        elements.push({
                            number: parseInt(p[0], 10),
                            name: p[1] || '',
                            controlType: p[2] || '',
                            screenX: parseInt(p[3], 10),
                            screenY: parseInt(p[4], 10),
                        });
                    }
                }
                if (elements.length > 0) {
                    meta.elements = elements;
                    screenshotMetaMap.set(filePath, meta);
                    lastAnnotatedPath = filePath;
                }
                const uiaCount = elements.filter(e => !e.controlType.startsWith('OCR')).length;
                const ocrCount = elements.filter(e => e.controlType.startsWith('OCR')).length;
                const debugSuffix = debugLines.length > 0 ? `\n[debug: ${debugLines.join('; ')}]` : '';
                elementListText = elements.length > 0
                    ? `\n\nDetected ${uiaCount} UI elements + ${ocrCount} OCR texts (use click_element to click by number):\n` +
                        elements.map(e => `  [${e.number}] "${e.name}" (${e.controlType.replace('ControlType.', '')})`).join('\n') + debugSuffix
                    : `\n\nAnnotation: exitCode=${annotateResult.exitCode}, stdoutLen=${annotateResult.stdout.length}, rawLines=${rawLines.length}` +
                        (debugLines.length > 0 ? `\nInfo: ${debugLines.join('; ')}` : '') +
                        (annotateResult.stderr ? `\nStderr: ${annotateResult.stderr.substring(0, 300)}` : '');
            }
            catch (annotateErr) {
                const errMsg = annotateErr instanceof Error ? annotateErr.message : String(annotateErr);
                elementListText = `\n\nAnnotation exception: ${errMsg}`;
            }
        }
        return {
            content: [{
                    type: 'text',
                    text: [
                        `Screenshot saved: ${filePath}`,
                        `Capture region: origin=(${originX},${originY}), size=${capturedSize}, image=${imageW}x${imageH}, file=${fileSize} bytes`,
                        `NEXT: Use the Read tool to VIEW this image first. Understand the full layout.`,
                        annotate && meta.elements && meta.elements.length > 0
                            ? `Found ${meta.elements.length} annotated elements. Use click_element(number) for any numbered element. If your target is NOT numbered, use zoom_screenshot(x,y,w,h) on that area → read grid coordinates → mouse_click(x,y).`
                            : `No annotated elements found (common for web/Electron apps). Use zoom_screenshot(x,y,w,h) on the area of interest → read grid coordinates → mouse_click(x,y). Do NOT use screenshot_click.`,
                    ].join('\n') + elementListText,
                }],
        };
    }, { title: 'Screenshot', readOnlyHint: true, destructiveHint: false });
    // 1b. screenshot_click — click at image pixel position, auto-converts to screen coordinates
    registerTool('screenshot_click', '⚠️ LOW PRIORITY — avoid this tool. Use click_element(number) or mouse_click(x,y) instead.\n\n' +
        'This tool clicks by percentage position in the last screenshot. It is IMPRECISE and should only be used as a last resort.\n' +
        'Preferred workflow: screenshot → zoom_screenshot → read grid coordinates → mouse_click(x,y).\n\n' +
        'Modes: percentX+percentY (e.g. 90,50 = 90% from left, 50% from top) or imageX+imageY (pixel position).', {
        type: 'object',
        properties: {
            percentX: { type: 'number', description: 'X position as percentage of image width (0-100). E.g., 50 = center, 90 = near right edge. Recommended over imageX.' },
            percentY: { type: 'number', description: 'Y position as percentage of image height (0-100). E.g., 50 = center, 10 = near top.' },
            imageX: { type: 'number', description: 'X pixel position in the screenshot image (0 = left edge). Use percentX instead for better accuracy.' },
            imageY: { type: 'number', description: 'Y pixel position in the screenshot image (0 = top edge). Use percentY instead for better accuracy.' },
            screenshotPath: { type: 'string', description: 'Path to the screenshot file. If omitted, uses the most recent screenshot.' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button. Default: left' },
            clickType: { type: 'string', enum: ['single', 'double'], description: 'Click type. Default: single' },
        },
        additionalProperties: false,
    }, async (args) => {
        const ssPath = args.screenshotPath || lastScreenshotPath;
        if (!ssPath) {
            return { isError: true, content: [{ type: 'text', text: 'No screenshot taken yet. Take a screenshot first.' }] };
        }
        const meta = screenshotMetaMap.get(ssPath);
        if (!meta) {
            return { isError: true, content: [{ type: 'text', text: `No metadata found for screenshot: ${ssPath}. Take a new screenshot first.` }] };
        }
        // Support both percentage and pixel mode
        let imageX, imageY;
        if (args.percentX != null && args.percentY != null) {
            // Percentage mode: convert to pixel position
            imageX = Math.round((sn(args.percentX) / 100) * meta.imageW);
            imageY = Math.round((sn(args.percentY) / 100) * meta.imageH);
        }
        else if (args.imageX != null && args.imageY != null) {
            imageX = sn(args.imageX);
            imageY = sn(args.imageY);
        }
        else {
            return { isError: true, content: [{ type: 'text', text: 'Provide either percentX+percentY or imageX+imageY.' }] };
        }
        // Convert image pixel position → screen coordinate
        const screenX = Math.round(meta.captureX + (imageX / meta.imageW) * meta.captureW);
        const screenY = Math.round(meta.captureY + (imageY / meta.imageH) * meta.captureH);
        const button = (args.button === 'right' || args.button === 'middle') ? args.button : 'left';
        const clickType = args.clickType === 'double' ? 'double' : 'single';
        let clickFlags;
        switch (button) {
            case 'right':
                clickFlags = clickType === 'double' ? '0x0008;0x0010;0x0008;0x0010' : '0x0008;0x0010';
                break;
            case 'middle':
                clickFlags = clickType === 'double' ? '0x0020;0x0040;0x0020;0x0040' : '0x0020;0x0040';
                break;
            default:
                clickFlags = clickType === 'double' ? '0x0002;0x0004;0x0002;0x0004' : '0x0002;0x0004';
                break;
        }
        const events = clickFlags.split(';').map(f => `[Win32]::mouse_event(${f}, 0, 0, 0, [UIntPtr]::Zero)`).join('\n');
        const script = `
[Win32]::SetCursorPos(${screenX}, ${screenY})
Start-Sleep -Milliseconds 30
${events}
Start-Sleep -Milliseconds 200
# Capture a small region around click point to verify
$vSize = 200
$vx = [Math]::Max(0, ${screenX} - $vSize)
$vy = [Math]::Max(0, ${screenY} - $vSize)
$vw = $vSize * 2
$vh = $vSize * 2
$vBmp = New-Object System.Drawing.Bitmap($vw, $vh)
$vg = [System.Drawing.Graphics]::FromImage($vBmp)
$vg.CopyFromScreen($vx, $vy, 0, 0, (New-Object System.Drawing.Size($vw, $vh)))
# Draw crosshair at click position
$cx = ${screenX} - $vx
$cy = ${screenY} - $vy
$crossPen = New-Object System.Drawing.Pen([System.Drawing.Color]::Red, 3)
$vg.DrawLine($crossPen, ($cx - 20), $cy, ($cx + 20), $cy)
$vg.DrawLine($crossPen, $cx, ($cy - 20), $cx, ($cy + 20))
$vg.DrawEllipse($crossPen, ($cx - 12), ($cy - 12), 24, 24)
$crossPen.Dispose()
# Label with coordinates
$lFont = New-Object System.Drawing.Font('Arial', 10, [System.Drawing.FontStyle]::Bold)
$lBg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200,0,0,0))
$lFg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Yellow)
$label = "Click@(${screenX},${screenY})"
$lsz = $vg.MeasureString($label, $lFont)
$vg.FillRectangle($lBg, 4, 4, $lsz.Width + 4, $lsz.Height + 2)
$vg.DrawString($label, $lFont, $lFg, 6, 4)
$lFont.Dispose(); $lBg.Dispose(); $lFg.Dispose(); $vg.Dispose()
$vPath = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "spectrai_click_verify_$(Get-Date -Format 'yyyyMMdd_HHmmss_fff').png")
$vBmp.Save($vPath, [System.Drawing.Imaging.ImageFormat]::Png)
$vBmp.Dispose()
Write-Output "clicked|$vPath"
`;
        const result = await shell.exec(script, 8000);
        if (result.exitCode !== 0) {
            return { isError: true, content: [{ type: 'text', text: `Click failed: ${result.stderr}` }] };
        }
        const parts = result.stdout.trim().split('|');
        const verifyPath = parts[1] || '';
        const content = [{
                type: 'text',
                text: `Clicked ${button} at screen(${screenX},${screenY}) — mapped from image pixel(${imageX},${imageY}) in ${ssPath}\nCapture region: origin=(${meta.captureX},${meta.captureY}), image=${meta.imageW}x${meta.imageH}, screen=${meta.captureW}x${meta.captureH}\n\nVerification image saved to: ${verifyPath}\nThis image shows a 400x400 region centered on the click point with a RED crosshair marking the exact click position. Use Read tool to view it and confirm the click hit the right target.`,
            }];
        return { content };
    }, { title: 'Screenshot Click', destructiveHint: true });
    // 1c. click_element — click annotated element by number (100% precise)
    registerTool('click_element', '★ STEP 2 (BEST): Click an annotated element by its NUMBER from screenshot. This is the MOST PRECISE click method — uses exact element center coordinates, zero estimation.\n\nTake a screenshot first, then use the element number shown on the image.\nReturns verification screenshot showing exact click position with red crosshair.', {
        type: 'object',
        properties: {
            number: { type: 'number', description: 'Element number from the annotated screenshot (e.g., 1, 2, 3...)' },
            screenshotPath: { type: 'string', description: 'Path to annotated screenshot. Default: last annotated screenshot.' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button. Default: left' },
            clickType: { type: 'string', enum: ['single', 'double'], description: 'Click type. Default: single' },
        },
        required: ['number'],
        additionalProperties: false,
    }, async (args) => {
        const elemNum = sn(args.number);
        const ssPath = args.screenshotPath || lastAnnotatedPath;
        if (!ssPath) {
            return { isError: true, content: [{ type: 'text', text: 'No annotated screenshot available. Take a screenshot with annotate=true first.' }] };
        }
        const meta = screenshotMetaMap.get(ssPath);
        if (!meta || !meta.elements || meta.elements.length === 0) {
            return { isError: true, content: [{ type: 'text', text: `No annotated elements found for: ${ssPath}. Take a new screenshot with annotate=true.` }] };
        }
        const element = meta.elements.find(e => e.number === elemNum);
        if (!element) {
            const available = meta.elements.map(e => `[${e.number}] "${e.name}"`).join(', ');
            return { isError: true, content: [{ type: 'text', text: `Element #${elemNum} not found. Available: ${available}` }] };
        }
        const clickX = element.screenX;
        const clickY = element.screenY;
        const button = (args.button === 'right' || args.button === 'middle') ? args.button : 'left';
        const clickType = args.clickType === 'double' ? 'double' : 'single';
        let clickFlags;
        switch (button) {
            case 'right':
                clickFlags = clickType === 'double' ? '0x0008;0x0010;0x0008;0x0010' : '0x0008;0x0010';
                break;
            case 'middle':
                clickFlags = clickType === 'double' ? '0x0020;0x0040;0x0020;0x0040' : '0x0020;0x0040';
                break;
            default:
                clickFlags = clickType === 'double' ? '0x0002;0x0004;0x0002;0x0004' : '0x0002;0x0004';
                break;
        }
        const events = clickFlags.split(';').map(f => `[Win32]::mouse_event(${f}, 0, 0, 0, [UIntPtr]::Zero)`).join('\n');
        const script = `
[Win32]::SetCursorPos(${clickX}, ${clickY})
Start-Sleep -Milliseconds 30
${events}
Start-Sleep -Milliseconds 200
# Capture verification screenshot around click point
$vSize = 150
$vx = [Math]::Max(0, ${clickX} - $vSize)
$vy = [Math]::Max(0, ${clickY} - $vSize)
$vw = $vSize * 2
$vh = $vSize * 2
$vBmp = New-Object System.Drawing.Bitmap($vw, $vh)
$vg = [System.Drawing.Graphics]::FromImage($vBmp)
$vg.CopyFromScreen($vx, $vy, 0, 0, (New-Object System.Drawing.Size($vw, $vh)))
$cx = ${clickX} - $vx
$cy = ${clickY} - $vy
$crossPen = New-Object System.Drawing.Pen([System.Drawing.Color]::Red, 3)
$vg.DrawLine($crossPen, ($cx - 15), $cy, ($cx + 15), $cy)
$vg.DrawLine($crossPen, $cx, ($cy - 15), $cx, ($cy + 15))
$vg.DrawEllipse($crossPen, ($cx - 10), ($cy - 10), 20, 20)
$crossPen.Dispose()
$lFont = New-Object System.Drawing.Font('Arial', 9, [System.Drawing.FontStyle]::Bold)
$lBg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200,0,0,0))
$lFg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Yellow)
$label = "[${elemNum}] @(${clickX},${clickY})"
$lsz = $vg.MeasureString($label, $lFont)
$vg.FillRectangle($lBg, 4, 4, $lsz.Width + 4, $lsz.Height + 2)
$vg.DrawString($label, $lFont, $lFg, 6, 4)
$lFont.Dispose(); $lBg.Dispose(); $lFg.Dispose(); $vg.Dispose()
$vPath = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "spectrai_click_verify_$(Get-Date -Format 'yyyyMMdd_HHmmss_fff').png")
$vBmp.Save($vPath, [System.Drawing.Imaging.ImageFormat]::Png)
$vBmp.Dispose()
Write-Output "clicked|$vPath"
`;
        const result = await shell.exec(script, 8000);
        if (result.exitCode !== 0) {
            return { isError: true, content: [{ type: 'text', text: `Click failed: ${result.stderr}` }] };
        }
        const vParts = result.stdout.trim().split('|');
        const verifyImgPath = vParts[1] || '';
        return {
            content: [{
                    type: 'text',
                    text: `Clicked [${elemNum}] "${element.name}" at screen(${clickX},${clickY}) — ${button} ${clickType}\n\nVerification image: ${verifyImgPath}\nShows 300x300 region centered on click with RED crosshair. Use Read tool to confirm it hit the right target.`,
                }],
        };
    }, { title: 'Click Element', destructiveHint: true });
    // 2. get_screen_info
    registerTool('get_screen_info', 'Get screen resolution, DPI, and scale factor.', { type: 'object', properties: {}, additionalProperties: false }, async () => {
        const script = `
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$bounds = $screen.Bounds
$g = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
$dpiX = $g.DpiX
$dpiY = $g.DpiY
$g.Dispose()
@{
  Width = $bounds.Width
  Height = $bounds.Height
  DpiX = $dpiX
  DpiY = $dpiY
  ScaleFactor = $dpiX / 96.0
} | ConvertTo-Json
`;
        const result = await shell.exec(script);
        if (result.exitCode !== 0) {
            return { isError: true, content: [{ type: 'text', text: `Screen info failed: ${result.stderr}` }] };
        }
        return { content: [{ type: 'text', text: result.stdout.trim() }] };
    }, { title: 'Get Screen Info', readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    // 3. mouse_click — NO DPI conversion, coordinates used as-is (logical pixels)
    registerTool('mouse_click', '★ STEP 3: Click at exact screen coordinates. Best used AFTER zoom_screenshot.\n\n' +
        'Read the grid coordinate labels from the zoomed image, then pass those exact X,Y numbers here.\n' +
        'Returns a verification screenshot with red crosshair showing where the click landed.\n' +
        'Only click ONCE — many UI buttons toggle state (like/unlike), clicking twice cancels the action.', {
        type: 'object',
        properties: {
            x: { type: 'number', description: 'X coordinate (logical pixels)' },
            y: { type: 'number', description: 'Y coordinate (logical pixels)' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button' },
            clickType: { type: 'string', enum: ['single', 'double'], description: 'Click type' },
        },
        required: ['x', 'y'],
        additionalProperties: false,
    }, async (args) => {
        const px = sn(args.x);
        const py = sn(args.y);
        const button = (args.button === 'right' || args.button === 'middle') ? args.button : 'left';
        const clickType = args.clickType === 'double' ? 'double' : 'single';
        let flags;
        switch (button) {
            case 'right':
                flags = clickType === 'double' ? '0x0008;0x0010;0x0008;0x0010' : '0x0008;0x0010';
                break;
            case 'middle':
                flags = clickType === 'double' ? '0x0020;0x0040;0x0020;0x0040' : '0x0020;0x0040';
                break;
            default:
                flags = clickType === 'double' ? '0x0002;0x0004;0x0002;0x0004' : '0x0002;0x0004';
                break;
        }
        const events = flags.split(';').map(f => `[Win32]::mouse_event(${f}, 0, 0, 0, [UIntPtr]::Zero)`).join('\n');
        const script = `
[Win32]::SetCursorPos(${px}, ${py})
Start-Sleep -Milliseconds 30
${events}
Start-Sleep -Milliseconds 200
# Capture verification region around click
$vSize = 150
$vx = [Math]::Max(0, ${px} - $vSize)
$vy = [Math]::Max(0, ${py} - $vSize)
$vw = $vSize * 2; $vh = $vSize * 2
$vBmp = New-Object System.Drawing.Bitmap($vw, $vh)
$vg = [System.Drawing.Graphics]::FromImage($vBmp)
$vg.CopyFromScreen($vx, $vy, 0, 0, (New-Object System.Drawing.Size($vw, $vh)))
$cx = ${px} - $vx; $cy = ${py} - $vy
$crossPen = New-Object System.Drawing.Pen([System.Drawing.Color]::Red, 3)
$vg.DrawLine($crossPen, ($cx - 15), $cy, ($cx + 15), $cy)
$vg.DrawLine($crossPen, $cx, ($cy - 15), $cx, ($cy + 15))
$vg.DrawEllipse($crossPen, ($cx - 10), ($cy - 10), 20, 20)
$crossPen.Dispose()
$lFont = New-Object System.Drawing.Font('Arial', 9, [System.Drawing.FontStyle]::Bold)
$lBg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200,0,0,0))
$lFg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Yellow)
$label = "Click@(${px},${py})"
$lsz = $vg.MeasureString($label, $lFont)
$vg.FillRectangle($lBg, 4, 4, $lsz.Width + 4, $lsz.Height + 2)
$vg.DrawString($label, $lFont, $lFg, 6, 4)
$lFont.Dispose(); $lBg.Dispose(); $lFg.Dispose(); $vg.Dispose()
$vPath = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "spectrai_click_verify_$(Get-Date -Format 'yyyyMMdd_HHmmss_fff').png")
$vBmp.Save($vPath, [System.Drawing.Imaging.ImageFormat]::Png)
$vBmp.Dispose()
Write-Output "clicked|$vPath"
`;
        const result = await shell.exec(script, 8000);
        if (result.exitCode !== 0) {
            return { isError: true, content: [{ type: 'text', text: `Click failed: ${result.stderr}` }] };
        }
        const clickParts = result.stdout.trim().split('|');
        const verifyImg = clickParts[1] || '';
        return {
            content: [{
                    type: 'text',
                    text: `Clicked ${button} at screen(${px},${py})\n\nVerification image: ${verifyImg}\nShows 300x300 region centered on click with RED crosshair. Use Read tool to confirm the click hit the correct target.`,
                }],
        };
    }, { title: 'Mouse Click', destructiveHint: true });
    // 4. mouse_move
    registerTool('mouse_move', 'Move the mouse cursor to the specified coordinates (logical pixels).', {
        type: 'object',
        properties: {
            x: { type: 'number', description: 'X coordinate (logical pixels)' },
            y: { type: 'number', description: 'Y coordinate (logical pixels)' },
        },
        required: ['x', 'y'],
        additionalProperties: false,
    }, async (args) => {
        const px = sn(args.x);
        const py = sn(args.y);
        const script = `
[Win32]::SetCursorPos(${px}, ${py})
Write-Output "moved to ${px},${py}"
`;
        const result = await shell.exec(script, 5000);
        if (result.exitCode !== 0) {
            return { isError: true, content: [{ type: 'text', text: `Move failed: ${result.stderr}` }] };
        }
        return { content: [{ type: 'text', text: result.stdout.trim() }] };
    }, { title: 'Mouse Move', destructiveHint: false });
    // 5. mouse_scroll
    registerTool('mouse_scroll', 'Scroll the mouse wheel at the current or specified position.', {
        type: 'object',
        properties: {
            x: { type: 'number', description: 'X coordinate (optional, logical pixels)' },
            y: { type: 'number', description: 'Y coordinate (optional, logical pixels)' },
            delta: { type: 'number', description: 'Scroll amount (positive=up, negative=down)' },
        },
        required: ['delta'],
        additionalProperties: false,
    }, async (args) => {
        const delta = sn(args.delta) * 120;
        let moveCmd = '';
        if (args.x != null && args.y != null) {
            moveCmd = `[Win32]::SetCursorPos(${sn(args.x)}, ${sn(args.y)})\nStart-Sleep -Milliseconds 30`;
        }
        const script = `
${moveCmd}
[Win32]::mouse_event(0x0800, 0, 0, ${delta}, [UIntPtr]::Zero)
Write-Output "scrolled"
`;
        const result = await shell.exec(script, 5000);
        if (result.exitCode !== 0) {
            return { isError: true, content: [{ type: 'text', text: `Scroll failed: ${result.stderr}` }] };
        }
        return { content: [{ type: 'text', text: result.stdout.trim() }] };
    }, { title: 'Mouse Scroll', destructiveHint: false });
    // 6. keyboard_type
    registerTool('keyboard_type', 'Type text using the keyboard (supports Unicode).', {
        type: 'object',
        properties: {
            text: { type: 'string', description: 'Text to type' },
        },
        required: ['text'],
        additionalProperties: false,
    }, async (args) => {
        const text = args.text;
        const sanitized = sp(text);
        const sendKeySafe = sanitized.replace(/[+^%~(){}[\]]/g, '{$&}');
        const script = `
$wsh = New-Object -ComObject WScript.Shell
$wsh.SendKeys('${sendKeySafe}')
Write-Output "typed"
`;
        const result = await shell.exec(script, 5000);
        if (result.exitCode !== 0) {
            return { isError: true, content: [{ type: 'text', text: `Type failed: ${result.stderr}` }] };
        }
        return { content: [{ type: 'text', text: `typed ${text.length} chars` }] };
    }, { title: 'Keyboard Type', destructiveHint: true });
    // 7. keyboard_press
    registerTool('keyboard_press', 'Press a single key (e.g., Enter, Tab, Escape, F1-F12, Delete, etc.).', {
        type: 'object',
        properties: {
            key: { type: 'string', description: 'Key name (e.g., Enter, Tab, Escape, F1, Delete)' },
        },
        required: ['key'],
        additionalProperties: false,
    }, async (args) => {
        const key = args.key;
        const keyMap = {
            enter: '{ENTER}', tab: '{TAB}', escape: '{ESC}', esc: '{ESC}',
            backspace: '{BACKSPACE}', delete: '{DELETE}', del: '{DELETE}',
            home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
            up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
            space: ' ', insert: '{INSERT}',
            f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}',
            f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}',
            capslock: '{CAPSLOCK}', numlock: '{NUMLOCK}', scrolllock: '{SCROLLLOCK}',
            printscreen: '{PRTSC}', pause: '{BREAK}',
        };
        const sendKey = keyMap[key.toLowerCase()];
        if (!sendKey) {
            return { isError: true, content: [{ type: 'text', text: `Unknown key: ${key}` }] };
        }
        const script = `
$wsh = New-Object -ComObject WScript.Shell
$wsh.SendKeys('${sendKey}')
Write-Output "pressed"
`;
        const result = await shell.exec(script, 5000);
        if (result.exitCode !== 0) {
            return { isError: true, content: [{ type: 'text', text: `Key press failed: ${result.stderr}` }] };
        }
        return { content: [{ type: 'text', text: `pressed ${key}` }] };
    }, { title: 'Keyboard Press', destructiveHint: true });
    // 8. keyboard_hotkey
    registerTool('keyboard_hotkey', 'Press a keyboard shortcut/hotkey combination (e.g., Ctrl+C, Alt+F4, Ctrl+Shift+S).', {
        type: 'object',
        properties: {
            keys: {
                type: 'array',
                items: { type: 'string' },
                description: 'Array of key names to press together, e.g. ["ctrl", "c"]',
            },
        },
        required: ['keys'],
        additionalProperties: false,
    }, async (args) => {
        const keys = args.keys;
        let prefix = '';
        let mainKey = '';
        const modifierMap = { ctrl: '^', control: '^', shift: '+', alt: '%' };
        const keyMap = {
            enter: '{ENTER}', tab: '{TAB}', escape: '{ESC}', esc: '{ESC}',
            delete: '{DELETE}', backspace: '{BACKSPACE}',
            f1: '{F1}', f2: '{F2}', f3: '{F3}', f4: '{F4}', f5: '{F5}', f6: '{F6}',
            f7: '{F7}', f8: '{F8}', f9: '{F9}', f10: '{F10}', f11: '{F11}', f12: '{F12}',
            up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
            home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}',
            space: ' ', insert: '{INSERT}',
        };
        for (const k of keys) {
            const lower = k.toLowerCase();
            if (modifierMap[lower]) {
                prefix += modifierMap[lower];
            }
            else {
                mainKey = keyMap[lower] || lower;
            }
        }
        if (mainKey.length > 1 && !mainKey.startsWith('{')) {
            return { isError: true, content: [{ type: 'text', text: `Invalid key: ${mainKey}` }] };
        }
        const combo = `${prefix}${mainKey}`;
        const script = `
$wsh = New-Object -ComObject WScript.Shell
$wsh.SendKeys('${sp(combo)}')
Write-Output "hotkey"
`;
        const result = await shell.exec(script, 5000);
        if (result.exitCode !== 0) {
            return { isError: true, content: [{ type: 'text', text: `Hotkey failed: ${result.stderr}` }] };
        }
        return { content: [{ type: 'text', text: `hotkey ${keys.join('+')}` }] };
    }, { title: 'Keyboard Hotkey', destructiveHint: true });
    // 9. uia_find_element
    registerTool('uia_find_element', 'Advanced: Find UI elements by name/automationId/className via Windows UI Automation. Returns coordinates and state. Note: For Chrome/Electron web content, prefer screenshot + click_element instead.', {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Element name to search for' },
            automationId: { type: 'string', description: 'Automation ID to search for' },
            className: { type: 'string', description: 'Class name to search for' },
            processId: { type: 'number', description: 'Limit search to a specific process ID' },
        },
        additionalProperties: false,
    }, async (args) => {
        const conditions = [];
        const condVarNames = [];
        if (args.name) {
            conditions.push(`$nameCondition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, '${sp(args.name)}')`);
            condVarNames.push('$nameCondition');
        }
        if (args.automationId) {
            conditions.push(`$idCondition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::AutomationIdProperty, '${sp(args.automationId)}')`);
            condVarNames.push('$idCondition');
        }
        if (args.className) {
            conditions.push(`$classCondition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ClassNameProperty, '${sp(args.className)}')`);
            condVarNames.push('$classCondition');
        }
        if (conditions.length === 0) {
            return { isError: true, content: [{ type: 'text', text: 'At least one search criterion required (name, automationId, or className)' }] };
        }
        const finalCondition = condVarNames.length === 1
            ? condVarNames[0]
            : `New-Object Windows.Automation.AndCondition(${condVarNames.join(', ')})`;
        const pid = args.processId != null ? sn(args.processId) : null;
        const pidFilter = pid != null ? `if ($item.ProcessId -eq ${pid}) { $results += $item }` : '$results += $item';
        const script = `
${conditions.join('\n')}
$condition = ${finalCondition}
$root = [Windows.Automation.AutomationElement]::RootElement
$elements = $root.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)
$results = @()
foreach ($el in $elements) {
  $rect = $el.Current.BoundingRectangle
  $item = @{
    Name = $el.Current.Name
    AutomationId = $el.Current.AutomationId
    ClassName = $el.Current.ClassName
    ControlType = $el.Current.ControlType.ProgrammaticName
    ProcessId = $el.Current.ProcessId
    BoundingRectangle = @{ X = $rect.X; Y = $rect.Y; Width = $rect.Width; Height = $rect.Height }
    IsEnabled = $el.Current.IsEnabled
  }
  ${pidFilter}
}
$results | ConvertTo-Json -Depth 3
`;
        const result = await shell.exec(script, 15000);
        if (result.exitCode !== 0) {
            return { isError: true, content: [{ type: 'text', text: `UIA find failed: ${result.stderr}` }] };
        }
        return { content: [{ type: 'text', text: result.stdout.trim() || '[]' }] };
    }, { title: 'UIA Find Element', readOnlyHint: true });
    // 10. uia_get_tree
    registerTool('uia_get_tree', 'Advanced: Get the full UI element tree for a window via UIA. Useful for understanding native app layout. For web apps, screenshot annotation is more reliable.', {
        type: 'object',
        properties: {
            processId: { type: 'number', description: 'Process ID to get tree for' },
            depth: { type: 'number', description: 'Max depth to traverse (default: 3, max: 10)' },
        },
        additionalProperties: false,
    }, async (args) => {
        const depth = Math.min(Math.max(sn(args.depth, 3), 1), 10);
        const pid = args.processId != null ? sn(args.processId) : null;
        const processFilter = pid != null ? `$el.Current.ProcessId -eq ${pid}` : '$true';
        const jsonDepth = depth + 5;
        const script = `
function Get-UIATree($element, $currentDepth, $maxDepth) {
  if ($currentDepth -gt $maxDepth) { return $null }
  $rect = $element.Current.BoundingRectangle
  $node = @{
    Name = $element.Current.Name
    AutomationId = $element.Current.AutomationId
    ClassName = $element.Current.ClassName
    ControlType = $element.Current.ControlType.ProgrammaticName
    ProcessId = $element.Current.ProcessId
    Rect = "$([int]$rect.X),$([int]$rect.Y),$([int]$rect.Width),$([int]$rect.Height)"
    Children = @()
  }
  if ($currentDepth -lt $maxDepth) {
    $children = $element.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)
    foreach ($child in $children) {
      $childNode = Get-UIATree $child ($currentDepth + 1) $maxDepth
      if ($childNode) { $node.Children += $childNode }
    }
  }
  return $node
}
$root = [Windows.Automation.AutomationElement]::RootElement
$windows = $root.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)
$trees = @()
foreach ($w in $windows) {
  $el = $w
  if (${processFilter}) {
    $trees += (Get-UIATree $w 0 ${depth})
  }
}
$trees | ConvertTo-Json -Depth ${jsonDepth}
`;
        const result = await shell.exec(script, 30000);
        if (result.exitCode !== 0) {
            return { isError: true, content: [{ type: 'text', text: `UIA tree failed: ${result.stderr}` }] };
        }
        return { content: [{ type: 'text', text: result.stdout.trim() || '[]' }] };
    }, { title: 'UIA Get Tree', readOnlyHint: true });
    // 11. window_list — uses pre-loaded Win32 class
    registerTool('window_list', 'List all visible windows with their titles, handles, and positions.', { type: 'object', properties: {}, additionalProperties: false }, async () => {
        const script = `
[Win32]::ListWindows()
[Win32]::windows | ForEach-Object { $_ } | ConvertTo-Json -Depth 2
`;
        const result = await shell.exec(script, 10000);
        if (result.exitCode !== 0) {
            return { isError: true, content: [{ type: 'text', text: `Window list failed: ${result.stderr}` }] };
        }
        return { content: [{ type: 'text', text: result.stdout.trim() || '[]' }] };
    }, { title: 'Window List', readOnlyHint: true });
    // 12. window_focus
    registerTool('window_focus', 'Bring a window to the foreground by title or handle.', {
        type: 'object',
        properties: {
            title: { type: 'string', description: 'Window title (partial match)' },
            handle: { type: 'number', description: 'Window handle (HWND)' },
        },
        additionalProperties: false,
    }, async (args) => {
        if (!args.title && !args.handle) {
            return { isError: true, content: [{ type: 'text', text: 'Provide either title or handle' }] };
        }
        let findWindow;
        if (args.handle) {
            const h = sn(args.handle);
            findWindow = `$hwnd = [IntPtr]::new(${h})`;
        }
        else {
            const escaped = sp(args.title);
            findWindow = `
$procs = Get-Process | Where-Object { $_.MainWindowTitle -like '*${escaped}*' -and $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
if (-not $procs) { Write-Error 'Window not found'; exit 1 }
$hwnd = $procs.MainWindowHandle`;
        }
        const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FocusHelper {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@
${findWindow}
if ([FocusHelper]::IsIconic($hwnd)) {
    [FocusHelper]::ShowWindow($hwnd, 9)
}
[FocusHelper]::SetForegroundWindow($hwnd)
Write-Output "focused window"
`;
        const result = await shell.exec(script);
        if (result.exitCode !== 0) {
            return { isError: true, content: [{ type: 'text', text: `Focus failed: ${result.stderr}` }] };
        }
        return { content: [{ type: 'text', text: result.stdout.trim() }] };
    }, { title: 'Window Focus', destructiveHint: false });
    // 13. window_close
    registerTool('window_close', 'Close a window by title or handle.', {
        type: 'object',
        properties: {
            title: { type: 'string', description: 'Window title (partial match)' },
            handle: { type: 'number', description: 'Window handle (HWND)' },
        },
        additionalProperties: false,
    }, async (args) => {
        if (!args.title && !args.handle) {
            return { isError: true, content: [{ type: 'text', text: 'Provide either title or handle' }] };
        }
        let script;
        if (args.handle) {
            const h = sn(args.handle);
            script = `
[Win32]::SendMessage([IntPtr]::new(${h}), 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
Write-Output "closed window"
`;
        }
        else {
            const escaped = sp(args.title);
            script = `
$procs = Get-Process | Where-Object { $_.MainWindowTitle -like '*${escaped}*' -and $_.MainWindowHandle -ne [IntPtr]::Zero }
if (-not $procs) { Write-Error 'Window not found'; exit 1 }
foreach ($p in $procs) { $p.CloseMainWindow() | Out-Null }
Write-Output "closed window(s)"
`;
        }
        const result = await shell.exec(script);
        if (result.exitCode !== 0) {
            return { isError: true, content: [{ type: 'text', text: `Close failed: ${result.stderr}` }] };
        }
        return { content: [{ type: 'text', text: result.stdout.trim() }] };
    }, { title: 'Window Close', destructiveHint: true });
    // 14. zoom_screenshot — native-resolution region capture for precise element identification
    registerTool('zoom_screenshot', '★ STEP 2 (after screenshot): Zoom into a region at NATIVE resolution with COORDINATE GRID.\n\n' +
        'HOW TO USE:\n' +
        '1. From the full screenshot, identify the AREA where your target is\n' +
        '2. Call zoom_screenshot(x, y, width, height) on that area — use generous size (200-400px) to ensure target is captured\n' +
        '3. Read the zoomed image — the GRID LABELS show absolute screen coordinates\n' +
        '4. Find your target element, read the nearest grid label numbers for its center X,Y\n' +
        '5. Call mouse_click(x, y) with those EXACT coordinates — ONE shot, do NOT repeat\n\n' +
        'GRID LABELS = absolute screen coordinates. Pass them directly to mouse_click. No math or estimation needed.\n' +
        'Also auto-detects elements via UIA + OCR. If numbered elements appear, use click_element(number) instead.', {
        type: 'object',
        properties: {
            x: { type: 'number', description: 'Left X coordinate of zoom region (screen pixels)' },
            y: { type: 'number', description: 'Top Y coordinate of zoom region (screen pixels)' },
            width: { type: 'number', description: 'Width of zoom region. Default: 400' },
            height: { type: 'number', description: 'Height of zoom region. Default: 400' },
            scale: { type: 'number', description: 'Upscale factor for tiny regions (2 = 2x zoom). Default: 1 (native). Max: 4' },
            grid: { type: 'boolean', description: 'Overlay coordinate grid with absolute screen coordinates. Default: true' },
            annotate: { type: 'boolean', description: 'Auto-detect elements via UIA + OCR. Default: true' },
        },
        required: ['x', 'y'],
        additionalProperties: false,
    }, async (args) => {
        const zx = sn(args.x);
        const zy = sn(args.y);
        const zw = args.width != null ? sn(args.width) : 400;
        const zh = args.height != null ? sn(args.height) : 400;
        const scale = args.scale != null ? Math.max(1, Math.min(4, sn(args.scale))) : 1;
        const grid = args.grid !== false; // default ON
        const annotate = args.annotate !== false;
        const imgPathEscaped = sp(OCR_WORKER_PS1.replace(/\\/g, '\\\\'));
        const script = `
$zx = ${zx}; $zy = ${zy}; $zw = ${zw}; $zh = ${zh}; $scale = ${scale}
$outFile = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "spectrai_zoom_$(Get-Date -Format 'yyyyMMdd_HHmmss_fff').png")

# Capture at native resolution
$bmp = New-Object System.Drawing.Bitmap($zw, $zh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($zx, $zy, 0, 0, (New-Object System.Drawing.Size($zw, $zh)))
$g.Dispose()

# Optional upscale for tiny regions
if ($scale -gt 1) {
    $newW = [int]($zw * $scale)
    $newH = [int]($zh * $scale)
    $scaled = New-Object System.Drawing.Bitmap($newW, $newH)
    $gs = [System.Drawing.Graphics]::FromImage($scaled)
    $gs.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $gs.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $gs.DrawImage($bmp, 0, 0, $newW, $newH)
    $gs.Dispose()
    $bmp.Dispose()
    $bmp = $scaled
}

# Draw fine coordinate grid with ABSOLUTE screen coordinates
if (${grid ? '$true' : '$false'}) {
    $gd = [System.Drawing.Graphics]::FromImage($bmp)
    $gd.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $scaleRatio = $bmp.Width / $zw
    # Adaptive grid step based on region size
    $step = 50
    if ($zw -le 300 -or $zh -le 300) { $step = 25 }
    if ($zw -le 150 -or $zh -le 150) { $step = 10 }
    if ($zw -gt 600) { $step = 100 }
    $gridPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(80, 0, 200, 255), 1)
    $majorPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(120, 0, 150, 255), 1)
    $fontSize = 9
    if ($step -le 25) { $fontSize = 8 }
    if ($step -le 10) { $fontSize = 7 }
    $font = New-Object System.Drawing.Font('Arial', $fontSize, [System.Drawing.FontStyle]::Bold)
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(230, 0, 100, 230))
    $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 255, 255, 255))
    # Vertical lines (X coordinates)
    $startX = [int]([Math]::Ceiling($zx / $step) * $step)
    for ($absX = $startX; $absX -lt ($zx + $zw); $absX += $step) {
        $relX = $absX - $zx
        $px = [int]($relX * $scaleRatio)
        $pen = if (($absX % ($step * 2)) -eq 0) { $majorPen } else { $gridPen }
        $gd.DrawLine($pen, $px, 0, $px, $bmp.Height)
        $lbl = "$absX"
        $sz = $gd.MeasureString($lbl, $font)
        $gd.FillRectangle($bgBrush, ($px + 1), 1, $sz.Width, $sz.Height)
        $gd.DrawString($lbl, $font, $brush, ($px + 1), 1)
    }
    # Horizontal lines (Y coordinates)
    $startY = [int]([Math]::Ceiling($zy / $step) * $step)
    for ($absY = $startY; $absY -lt ($zy + $zh); $absY += $step) {
        $relY = $absY - $zy
        $py = [int]($relY * $scaleRatio)
        $pen = if (($absY % ($step * 2)) -eq 0) { $majorPen } else { $gridPen }
        $gd.DrawLine($pen, 0, $py, $bmp.Width, $py)
        $lbl = "$absY"
        $sz = $gd.MeasureString($lbl, $font)
        $gd.FillRectangle($bgBrush, 1, ($py + 1), $sz.Width, $sz.Height)
        $gd.DrawString($lbl, $font, $brush, 1, ($py + 1))
    }
    # Origin marker
    $originLbl = "($zx,$zy)"
    $osz = $gd.MeasureString($originLbl, $font)
    $gd.FillRectangle($bgBrush, 0, 0, $osz.Width + 4, $osz.Height + 2)
    $gd.DrawString($originLbl, $font, $brush, 2, 1)
    $gridPen.Dispose(); $majorPen.Dispose(); $font.Dispose(); $brush.Dispose(); $bgBrush.Dispose(); $gd.Dispose()
}

$bmp.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)
$imgW = $bmp.Width; $imgH = $bmp.Height
$bmp.Dispose()
Write-Output "$outFile|$imgW|$imgH"
`;
        const captureResult = await shell.exec(script, 10000);
        if (captureResult.exitCode !== 0) {
            return { isError: true, content: [{ type: 'text', text: `Zoom capture failed: ${captureResult.stderr}` }] };
        }
        const capParts = captureResult.stdout.trim().split('|');
        const filePath = capParts[0];
        const imageW = parseInt(capParts[1] || '0', 10);
        const imageH = parseInt(capParts[2] || '0', 10);
        // Store metadata for screenshot_click
        const meta = {
            captureX: zx, captureY: zy,
            captureW: zw, captureH: zh,
            imageW, imageH,
        };
        screenshotMetaMap.set(filePath, meta);
        lastScreenshotPath = filePath;
        let elementListText = '';
        if (annotate) {
            try {
                const annotateScript = `
$captureX = ${zx}; $captureY = ${zy}; $captureW = ${zw}; $captureH = ${zh}
$imgPath = '${sp(filePath.replace(/\\/g, '\\\\'))}'

# Force Chrome accessibility if needed
try {
    $centerPt = New-Object System.Windows.Point(($captureX + $captureW/2), ($captureY + $captureH/2))
    $targetEl = [Windows.Automation.AutomationElement]::FromPoint($centerPt)
    $window = $null
    $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
    $cur = $targetEl
    while ($cur -ne $null -and $cur -ne [Windows.Automation.AutomationElement]::RootElement) {
        if ($cur.Current.ControlType -eq [Windows.Automation.ControlType]::Window) { $window = $cur; break }
        $cur = $walker.GetParent($cur)
    }
    if (-not $window) { $window = [Windows.Automation.AutomationElement]::RootElement }
    $winClass = $window.Current.ClassName
    if ($winClass -match 'Chrome_WidgetWin|Electron') {
        $wh = $window.Current.NativeWindowHandle
        if ($wh -ne 0) {
            $found = [Win32]::FindChromeRenderWidget([IntPtr]::new($wh))
            if ($found) { [Win32]::ForceAccessibility([Win32]::chromeRenderHwnd); Start-Sleep -Milliseconds 300 }
        }
    }
} catch {}

# UIA detection
$filtered = @()
$idx = 1
try {
    if (-not $window) { $window = [Windows.Automation.AutomationElement]::RootElement }
    $allEls = $window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
    foreach ($el in $allEls) {
        $rect = $el.Current.BoundingRectangle
        if ($rect.IsEmpty -or $rect.Width -le 2 -or $rect.Height -le 2) { continue }
        if ($rect.Width -gt $captureW -or $rect.Height -gt $captureH) { continue }
        $elCx = [int]($rect.X + $rect.Width / 2)
        $elCy = [int]($rect.Y + $rect.Height / 2)
        if ($elCx -lt $captureX -or $elCx -ge ($captureX + $captureW)) { continue }
        if ($elCy -lt $captureY -or $elCy -ge ($captureY + $captureH)) { continue }
        $name = $el.Current.Name
        $aid = $el.Current.AutomationId
        $ct = $el.Current.ControlType.ProgrammaticName
        $label = if ($name) { $name } elseif ($aid) { $aid } else { '' }
        $isClickable = ($ct -match 'Button|Hyperlink|MenuItem|TabItem|ListItem|CheckBox|RadioButton|ComboBox|Image')
        if (-not $label -and -not $isClickable) { continue }
        if (-not $label) { $label = $ct -replace 'ControlType\\.', '' }
        $filtered += @{N=$idx; Name=$label; CT=$ct; CX=$elCx; CY=$elCy; W=[int]$rect.Width; H=[int]$rect.Height; Src='UIA'}
        $idx++
        if ($idx -gt 60) { break }
    }
} catch {}

# OCR fallback
if ($filtered.Count -lt 10) {
    try {
        $ocrWorker = '${imgPathEscaped}'.Replace('\\\\','\\')
        $ocrImgPath = $imgPath.Replace('\\\\','\\')
        $ocrOut = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "spectrai_ocr_$(Get-Date -Format 'yyyyMMdd_HHmmss_fff').txt")
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'powershell.exe'
        $psi.Arguments = '-NoProfile -STA -ExecutionPolicy Bypass -File "' + $ocrWorker + '" -ImgPath "' + $ocrImgPath + '" -CaptureX ' + $captureX + ' -CaptureY ' + $captureY + ' -CaptureW ' + $captureW + ' -CaptureH ' + $captureH + ' -OutFile "' + $ocrOut + '"'
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardError = $true
        $proc = [System.Diagnostics.Process]::Start($psi)
        $stderr = $proc.StandardError.ReadToEnd()
        $proc.WaitForExit(8000)
        if ((Test-Path $ocrOut) -and (Get-Item $ocrOut).Length -gt 0) {
            foreach ($ol in (Get-Content $ocrOut -Encoding UTF8)) {
                $parts = $ol.Split('|')
                if ($parts.Count -ge 5) {
                    $filtered += @{N=$idx; Name=$parts[0]; CT='OCR.Text'; CX=[int]$parts[1]; CY=[int]$parts[2]; W=[int]$parts[3]; H=[int]$parts[4]; Src='OCR'}
                    $idx++
                    if ($idx -gt 80) { break }
                }
            }
        }
        Remove-Item $ocrOut -ErrorAction SilentlyContinue
    } catch {}
}

# Draw annotations
if ($filtered.Count -gt 0) {
    $fileBytes = [System.IO.File]::ReadAllBytes($imgPath)
    $ms = New-Object System.IO.MemoryStream(,$fileBytes)
    $bmp = [System.Drawing.Bitmap]::new($ms)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $font = New-Object System.Drawing.Font('Arial', 10, [System.Drawing.FontStyle]::Bold)
    $labelFont = New-Object System.Drawing.Font('Arial', 8)
    $redBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(230, 230, 30, 30))
    $greenBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(230, 30, 150, 30))
    $whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 255, 255, 0), 2)
    $ocrPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 0, 255, 100), 2)
    $scaleX = $bmp.Width / $captureW
    $scaleY = $bmp.Height / $captureH
    foreach ($el in $filtered) {
        $imgPx = [int](($el.CX - $captureX) * $scaleX)
        $imgPy = [int](($el.CY - $captureY) * $scaleY)
        $elImgW = [Math]::Max([int]($el.W * $scaleX), 20)
        $elImgH = [Math]::Max([int]($el.H * $scaleY), 20)
        $isOcr = $el.Src -eq 'OCR'
        $pen = if ($isOcr) { $ocrPen } else { $borderPen }
        $bg = if ($isOcr) { $greenBrush } else { $redBrush }
        $g.DrawRectangle($pen, ($imgPx - $elImgW/2), ($imgPy - $elImgH/2), $elImgW, $elImgH)
        $r = 11
        $g.FillEllipse($bg, ($imgPx - $r), ($imgPy - $elImgH/2 - $r*2 - 2), ($r * 2), ($r * 2))
        $lbl = "$($el.N)"
        $sz = $g.MeasureString($lbl, $font)
        $g.DrawString($lbl, $font, $whiteBrush, ($imgPx - $sz.Width/2), ($imgPy - $elImgH/2 - $r*2 - 2 + ($r - $sz.Height/2)))
        $nameLbl = $el.Name
        if ($nameLbl.Length -gt 20) { $nameLbl = $nameLbl.Substring(0, 17) + '...' }
        $nsz = $g.MeasureString($nameLbl, $labelFont)
        $g.FillRectangle((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(180,0,0,0))), ($imgPx - $nsz.Width/2), ($imgPy + $elImgH/2 + 2), $nsz.Width, $nsz.Height)
        $g.DrawString($nameLbl, $labelFont, $whiteBrush, ($imgPx - $nsz.Width/2), ($imgPy + $elImgH/2 + 2))
    }
    $font.Dispose(); $labelFont.Dispose(); $redBrush.Dispose(); $greenBrush.Dispose()
    $whiteBrush.Dispose(); $borderPen.Dispose(); $ocrPen.Dispose(); $g.Dispose()
    $bmp.Save($imgPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose(); $ms.Dispose()
}
foreach ($el in $filtered) { Write-Output "$($el.N)|$($el.Name)|$($el.CT)|$($el.CX)|$($el.CY)" }
`;
                const annotateResult = await shell.exec(annotateScript, 45000);
                const elements = [];
                for (const line of annotateResult.stdout.trim().split('\n')) {
                    const p = line.trim().split('|');
                    if (p.length >= 5 && p[0] && p[3] && p[4]) {
                        elements.push({
                            number: parseInt(p[0], 10),
                            name: p[1] || '',
                            controlType: p[2] || '',
                            screenX: parseInt(p[3], 10),
                            screenY: parseInt(p[4], 10),
                        });
                    }
                }
                if (elements.length > 0) {
                    meta.elements = elements;
                    screenshotMetaMap.set(filePath, meta);
                    lastAnnotatedPath = filePath;
                }
                const uiaCount = elements.filter(e => !e.controlType.startsWith('OCR')).length;
                const ocrCount = elements.filter(e => e.controlType.startsWith('OCR')).length;
                elementListText = elements.length > 0
                    ? `\n\nDetected ${uiaCount} UI elements + ${ocrCount} OCR texts:\n` +
                        elements.map(e => `  [${e.number}] "${e.name}" (${e.controlType.replace('ControlType.', '')})`).join('\n')
                    : '';
            }
            catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                elementListText = `\n\nAnnotation error: ${errMsg}`;
            }
        }
        return {
            content: [{
                    type: 'text',
                    text: [
                        `Zoom screenshot saved: ${filePath}`,
                        `Region: (${zx},${zy}) ${zw}x${zh}, image=${imageW}x${imageH}${scale > 1 ? `, scale=${scale}x` : ''}`,
                        grid ? `GRID: Shows absolute screen coordinates. Read the X,Y numbers from grid lines near your target, then use mouse_click(x,y) directly — ONE shot, no estimation.` : '',
                        `Use click_element(number) for annotated elements, or read grid coordinates and use mouse_click(x,y).`,
                        `Use the Read tool to view this image.`,
                    ].filter(Boolean).join('\n') + elementListText,
                }],
        };
    }, { title: 'Zoom Screenshot', readOnlyHint: true });
}
