/**
 * HUD Renderer — SpectrAI Claw sci-fi overlay visualizer.
 *
 * Calls hud-drawing.ps1 (GDI+) to render a sci-fi HUD overlay onto a screenshot.
 * No Node image libraries required; all drawing is done via PowerShell / System.Drawing.
 *
 * Usage:
 *   const outPath = await renderHud({ imagePath, elements, highlightNumber: 3 })
 */
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { shell } from '../helpers/PersistentShell.js'
import { PolicyEngine } from '../security/PolicyEngine.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const HUD_PS1 = join(__dirname, '..', 'scripts', 'hud-drawing.ps1')

const sp = PolicyEngine.sanitizeForPowerShell.bind(PolicyEngine)

export interface HudElement {
  number: number
  name?: string
  controlType?: string
  screenX?: number
  screenY?: number
  rectX?: number
  rectY?: number
  rectW?: number
  rectH?: number
}

export interface RenderHudOptions {
  /** Absolute path to the source screenshot (PNG). */
  imagePath: string
  /** Array of annotated elements to overlay. */
  elements: HudElement[]
  /** Element number to highlight (glow/pulse). 0 = no highlight. */
  highlightNumber?: number
  /** RGB glow color string, e.g. "0,200,255". Default: cyan. */
  glowColor?: string
  /** Highlight rendering style. Default: 'glow'. */
  highlightMode?: 'glow' | 'pulse' | 'flash'
  /** Override output path. Default: <source>_hud.png next to source. */
  outputPath?: string
}

/**
 * Renders a sci-fi HUD overlay onto `imagePath` and returns the path of the new image.
 * The source image is NOT modified; a new file `*_hud.png` is produced.
 */
export async function renderHud(opts: RenderHudOptions): Promise<string> {
  const {
    imagePath,
    elements,
    highlightNumber = 0,
    glowColor = '0,200,255',
    highlightMode = 'glow',
    outputPath = '',
  } = opts

  // Serialize elements to JSON — escape for PowerShell single-quoted here-string
  const elementsJson = JSON.stringify(elements)
  // We pass JSON via a temp variable in the inline script to avoid shell-escaping issues
  const safeImagePath = sp(imagePath)
  const safeOutputPath = outputPath ? sp(outputPath) : ''
  const safeGlowColor = sp(glowColor)
  const safeHighlightMode = sp(highlightMode)
  const safePs1 = sp(HUD_PS1)
  const highlightNum = Math.max(0, Math.floor(Number(highlightNumber) || 0))

  // Write JSON to temp file to avoid quoting issues with complex names
  const tempJson = imagePath.replace(/\.png$/i, '_hud_elements.json').replace(/\\/g, '\\\\')
  const safeTempJson = sp(tempJson.replace(/\\\\/g, '\\'))

  const script = `
$elementsJson = '${elementsJson.replace(/'/g, "''")}'
$elementsJson | Set-Content -Path '${safeTempJson}' -Encoding UTF8 -Force
& '${safePs1}' \`
  -ImagePath '${safeImagePath}' \`
  -ElementsJson $elementsJson \`
  -HighlightNumber ${highlightNum} \`
  -GlowColor '${safeGlowColor}' \`
  -HighlightMode '${safeHighlightMode}' \`
  -OutputPath '${safeOutputPath}'
Remove-Item '${safeTempJson}' -ErrorAction SilentlyContinue
`

  const result = await shell.exec(script, 30000)

  if (result.exitCode !== 0) {
    throw new Error(`HUD rendering failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`)
  }

  // Parse output path from script's "HUD_OUTPUT:<path>" line
  const lines = result.stdout.split('\n').map(l => l.trim())
  const outputLine = lines.find(l => l.startsWith('HUD_OUTPUT:'))
  if (outputLine) {
    return outputLine.slice('HUD_OUTPUT:'.length).trim()
  }

  // Fallback: derive expected path
  if (outputPath) return outputPath
  return imagePath.replace(/(\.[^.]+)?$/, '_hud.png')
}
