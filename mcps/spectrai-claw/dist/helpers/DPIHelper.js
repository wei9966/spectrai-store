import { runPowerShell } from './PowerShellRunner.js';
let cachedScreenInfo = null;
export async function getScreenInfo() {
    if (cachedScreenInfo)
        return cachedScreenInfo;
    const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
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
    const result = await runPowerShell(script);
    if (result.exitCode !== 0) {
        throw new Error(`Failed to get screen info: ${result.stderr}`);
    }
    const data = JSON.parse(result.stdout);
    cachedScreenInfo = {
        width: data.Width,
        height: data.Height,
        dpiX: data.DpiX,
        dpiY: data.DpiY,
        scaleFactor: data.ScaleFactor,
    };
    return cachedScreenInfo;
}
export function logicalToPhysical(x, y, scaleFactor) {
    return {
        x: Math.round(x * scaleFactor),
        y: Math.round(y * scaleFactor),
    };
}
export function physicalToLogical(x, y, scaleFactor) {
    return {
        x: Math.round(x / scaleFactor),
        y: Math.round(y / scaleFactor),
    };
}
export function clearCache() {
    cachedScreenInfo = null;
}
