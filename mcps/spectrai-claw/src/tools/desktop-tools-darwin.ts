/**
 * Desktop automation tools for macOS (Darwin).
 * Uses DarwinHelper (Swift CLI helper wrapper) for all native operations.
 * All coordinates are in logical pixels — consistent with Windows version.
 *
 * Tool names and output formats are identical to the Windows version
 * for AI agent compatibility.
 */
import { existsSync, mkdirSync, statSync } from 'fs'
import { dirname, resolve } from 'path'
import { registerTool } from './registry.js'
import { darwin } from '../helpers/DarwinHelper.js'

// Screenshot metadata store — maps file path to capture region info
// Used by screenshot_click to convert image pixel coords → screen coords
interface AnnotatedElement {
  number: number
  name: string
  controlType: string
  screenX: number
  screenY: number
}

interface ScreenshotMeta {
  captureX: number
  captureY: number
  captureW: number
  captureH: number
  imageW: number
  imageH: number
  elements?: AnnotatedElement[]
}
const screenshotMetaMap = new Map<string, ScreenshotMeta>()
let lastScreenshotPath = ''
let lastAnnotatedPath = ''

/** Sanitize number with fallback */
function sn(val: unknown, fallback = 0): number {
  const n = Number(val)
  return Number.isFinite(n) ? n : fallback
}

export function registerDarwinDesktopTools(): void {
  // ──────────────────────────────────────────────────────────────────────
  // 1. screenshot
  // ──────────────────────────────────────────────────────────────────────
  registerTool(
    'screenshot',
    '★ STEP 1: Take a FULL screenshot at native resolution. Always start here.\n\n' +
    'Returns file path + auto-detected UI elements. Use Read tool to VIEW the image first — understand the full layout before acting.\n\n' +
    'WORKFLOW (follow strictly):\n' +
    '1. screenshot() → Read image → understand layout, identify target area\n' +
    '2. If target has a numbered marker → click_element(number) — DONE\n' +
    '3. If target is NOT annotated (icons, images, web app buttons) → zoom_screenshot(x,y,w,h) on that area → read grid coordinates → mouse_click(x,y)\n\n' +
    'IMPORTANT: The image is captured at NATIVE resolution for maximum clarity. Read the image carefully to identify exactly where your target is before zooming.',
    {
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
        annotate: { type: 'boolean', description: 'Auto-detect interactive elements via Accessibility and draw numbered markers. Use click_element(number) to click. Default: true' },
      },
      additionalProperties: false,
    },
    async (args) => {
      const annotate = args.annotate !== false

      // Determine save path
      let outPath: string
      if (args.savePath) {
        outPath = resolve(args.savePath as string)
        const dir = dirname(outPath)
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      } else {
        outPath = `/tmp/spectrai_ss_${Date.now()}.png`
      }

      // Build region string if specified
      const hasRegion = args.x != null || args.y != null || args.width != null || args.height != null
      let region: string | undefined
      if (hasRegion) {
        const rx = args.x != null ? sn(args.x) : 0
        const ry = args.y != null ? sn(args.y) : 0
        const rw = args.width != null ? sn(args.width) : 0
        const rh = args.height != null ? sn(args.height) : 0
        region = `${rx},${ry},${rw},${rh}`
      }

      // Step 1: Capture screenshot
      const ssResult = darwin.screenshot({ output: outPath, region })
      if (!ssResult.success) {
        return { isError: true, content: [{ type: 'text', text: `Screenshot failed: ${ssResult.error || 'unknown error'}` }] }
      }

      const ssData = ssResult.data as { path: string; width: number; height: number; originX?: number; originY?: number }
      const filePath = ssData.path || outPath
      const imageW = ssData.width || 0
      const imageH = ssData.height || 0
      const originX = ssData.originX || (hasRegion ? sn(args.x) : 0)
      const originY = ssData.originY || (hasRegion ? sn(args.y) : 0)

      // Determine capture region dimensions
      let capW: number, capH: number
      if (hasRegion) {
        // Use screen info to fill in missing width/height
        capW = args.width != null ? sn(args.width) : imageW
        capH = args.height != null ? sn(args.height) : imageH
      } else {
        // Full screen — get from screen info or use image dimensions
        const screenResult = darwin.screenInfo()
        if (screenResult.success && screenResult.data?.screens?.length > 0) {
          const screen = screenResult.data.screens[0]
          capW = screen.width || imageW
          capH = screen.height || imageH
        } else {
          capW = imageW
          capH = imageH
        }
      }

      // Store metadata for screenshot_click
      const meta: ScreenshotMeta = {
        captureX: originX, captureY: originY,
        captureW: capW, captureH: capH,
        imageW, imageH,
      }
      screenshotMetaMap.set(filePath, meta)
      lastScreenshotPath = filePath

      // Step 2: Annotate — detect UI elements via Accessibility + OCR
      let elementListText = ''
      if (annotate) {
        try {
          const elements: AnnotatedElement[] = []
          let idx = 1

          // Find frontmost app PID for accessibility tree
          const winResult = darwin.windowsList()
          if (winResult.success && winResult.data?.windows?.length > 0) {
            const frontPid = winResult.data.windows[0].ownerPid
            if (frontPid) {
              const axResult = darwin.axTree(frontPid, 3)
              if (axResult.success && axResult.data?.elements) {
                for (const el of axResult.data.elements) {
                  if (!el.bounds) continue
                  const elCx = Math.round(el.bounds.x + el.bounds.width / 2)
                  const elCy = Math.round(el.bounds.y + el.bounds.height / 2)
                  // Filter: must be within capture region
                  if (elCx < originX || elCx >= originX + capW) continue
                  if (elCy < originY || elCy >= originY + capH) continue
                  // Filter: skip too small or too large
                  if (el.bounds.width <= 2 || el.bounds.height <= 2) continue
                  if (el.bounds.width > capW || el.bounds.height > capH) continue

                  const label = el.title || el.description || el.role || ''
                  const isClickable = /button|link|menuitem|tab|checkbox|radio|combobox|slider|image/i.test(el.role || '')
                  if (!label && !isClickable) continue

                  elements.push({
                    number: idx,
                    name: label || (el.role || 'element'),
                    controlType: el.role || 'AX.Unknown',
                    screenX: elCx,
                    screenY: elCy,
                  })
                  idx++
                  if (idx > 80) break
                }
              }
            }
          }

          // OCR fallback if few accessibility elements
          if (elements.length < 10) {
            const ocrResult = darwin.ocr(filePath)
            if (ocrResult.success && ocrResult.data?.results) {
              for (const r of ocrResult.data.results) {
                if (!r.bounds) continue
                const cx = Math.round(r.bounds.x + r.bounds.width / 2)
                const cy = Math.round(r.bounds.y + r.bounds.height / 2)
                if (cx < originX || cx >= originX + capW) continue
                if (cy < originY || cy >= originY + capH) continue

                elements.push({
                  number: idx,
                  name: r.text || '',
                  controlType: 'OCR.Text',
                  screenX: cx,
                  screenY: cy,
                })
                idx++
                if (idx > 80) break
              }
            }
          }

          if (elements.length > 0) {
            meta.elements = elements
            screenshotMetaMap.set(filePath, meta)
            lastAnnotatedPath = filePath
          }

          const axCount = elements.filter(e => !e.controlType.startsWith('OCR')).length
          const ocrCount = elements.filter(e => e.controlType.startsWith('OCR')).length
          elementListText = elements.length > 0
            ? `\n\nDetected ${axCount} UI elements + ${ocrCount} OCR texts (use click_element to click by number):\n` +
              elements.map(e => `  [${e.number}] "${e.name}" (${e.controlType})`).join('\n')
            : '\n\nNo elements detected via Accessibility or OCR.'
        } catch (annotateErr: unknown) {
          const errMsg = annotateErr instanceof Error ? annotateErr.message : String(annotateErr)
          elementListText = `\n\nAnnotation exception: ${errMsg}`
        }
      }

      const fileSize = existsSync(filePath) ? String(statSync(filePath).size) : '?'

      return {
        content: [{
          type: 'text',
          text: [
            `Screenshot saved: ${filePath}`,
            `Capture region: origin=(${originX},${originY}), size=${capW}x${capH}, image=${imageW}x${imageH}, file=${fileSize} bytes`,
            `NEXT: Use the Read tool to VIEW this image first. Understand the full layout.`,
            annotate && meta.elements && meta.elements.length > 0
              ? `Found ${meta.elements.length} annotated elements. Use click_element(number) for any numbered element. If your target is NOT numbered, use zoom_screenshot(x,y,w,h) on that area → read grid coordinates → mouse_click(x,y).`
              : `No annotated elements found (common for web/Electron apps). Use zoom_screenshot(x,y,w,h) on the area of interest → read grid coordinates → mouse_click(x,y). Do NOT use screenshot_click.`,
          ].join('\n') + elementListText,
        }],
      }
    },
    { title: 'Screenshot', readOnlyHint: true, destructiveHint: false },
  )

  // ──────────────────────────────────────────────────────────────────────
  // 1b. screenshot_click
  // ──────────────────────────────────────────────────────────────────────
  registerTool(
    'screenshot_click',
    '⚠️ LOW PRIORITY — avoid this tool. Use click_element(number) or mouse_click(x,y) instead.\n\n' +
    'This tool clicks by percentage position in the last screenshot. It is IMPRECISE and should only be used as a last resort.\n' +
    'Preferred workflow: screenshot → zoom_screenshot → read grid coordinates → mouse_click(x,y).\n\n' +
    'Modes: percentX+percentY (e.g. 90,50 = 90% from left, 50% from top) or imageX+imageY (pixel position).',
    {
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
    },
    async (args) => {
      const ssPath = (args.screenshotPath as string) || lastScreenshotPath
      if (!ssPath) {
        return { isError: true, content: [{ type: 'text', text: 'No screenshot taken yet. Take a screenshot first.' }] }
      }
      const meta = screenshotMetaMap.get(ssPath)
      if (!meta) {
        return { isError: true, content: [{ type: 'text', text: `No metadata found for screenshot: ${ssPath}. Take a new screenshot first.` }] }
      }

      let imageX: number, imageY: number
      if (args.percentX != null && args.percentY != null) {
        imageX = Math.round((sn(args.percentX) / 100) * meta.imageW)
        imageY = Math.round((sn(args.percentY) / 100) * meta.imageH)
      } else if (args.imageX != null && args.imageY != null) {
        imageX = sn(args.imageX)
        imageY = sn(args.imageY)
      } else {
        return { isError: true, content: [{ type: 'text', text: 'Provide either percentX+percentY or imageX+imageY.' }] }
      }

      const screenX = Math.round(meta.captureX + (imageX / meta.imageW) * meta.captureW)
      const screenY = Math.round(meta.captureY + (imageY / meta.imageH) * meta.captureH)

      const button = (args.button === 'right' || args.button === 'middle') ? args.button as string : 'left'
      const clickCount = args.clickType === 'double' ? 2 : 1

      const clickResult = darwin.mouseClick(screenX, screenY, button, clickCount)
      if (!clickResult.success) {
        return { isError: true, content: [{ type: 'text', text: `Click failed: ${clickResult.error || 'unknown error'}` }] }
      }

      // Capture verification screenshot
      const verifyPath = `/tmp/spectrai_click_verify_${Date.now()}.png`
      const vSize = 200
      const vx = Math.max(0, screenX - vSize)
      const vy = Math.max(0, screenY - vSize)
      darwin.screenshot({ output: verifyPath, region: `${vx},${vy},${vSize * 2},${vSize * 2}` })

      return {
        content: [{
          type: 'text',
          text: `Clicked ${button} at screen(${screenX},${screenY}) — mapped from image pixel(${imageX},${imageY}) in ${ssPath}\nCapture region: origin=(${meta.captureX},${meta.captureY}), image=${meta.imageW}x${meta.imageH}, screen=${meta.captureW}x${meta.captureH}\n\nVerification image saved to: ${verifyPath}\nThis image shows a 400x400 region centered on the click point. Use Read tool to view it and confirm the click hit the right target.`,
        }],
      }
    },
    { title: 'Screenshot Click', destructiveHint: true },
  )

  // ──────────────────────────────────────────────────────────────────────
  // 1c. click_element
  // ──────────────────────────────────────────────────────────────────────
  registerTool(
    'click_element',
    '★ STEP 2 (BEST): Click an annotated element by its NUMBER from screenshot. This is the MOST PRECISE click method — uses exact element center coordinates, zero estimation.\n\nTake a screenshot first, then use the element number shown on the image.\nReturns verification screenshot showing exact click position.',
    {
      type: 'object',
      properties: {
        number: { type: 'number', description: 'Element number from the annotated screenshot (e.g., 1, 2, 3...)' },
        screenshotPath: { type: 'string', description: 'Path to annotated screenshot. Default: last annotated screenshot.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button. Default: left' },
        clickType: { type: 'string', enum: ['single', 'double'], description: 'Click type. Default: single' },
      },
      required: ['number'],
      additionalProperties: false,
    },
    async (args) => {
      const elemNum = sn(args.number)
      const ssPath = (args.screenshotPath as string) || lastAnnotatedPath
      if (!ssPath) {
        return { isError: true, content: [{ type: 'text', text: 'No annotated screenshot available. Take a screenshot with annotate=true first.' }] }
      }
      const meta = screenshotMetaMap.get(ssPath)
      if (!meta || !meta.elements || meta.elements.length === 0) {
        return { isError: true, content: [{ type: 'text', text: `No annotated elements found for: ${ssPath}. Take a new screenshot with annotate=true.` }] }
      }
      const element = meta.elements.find(e => e.number === elemNum)
      if (!element) {
        const available = meta.elements.map(e => `[${e.number}] "${e.name}"`).join(', ')
        return { isError: true, content: [{ type: 'text', text: `Element #${elemNum} not found. Available: ${available}` }] }
      }

      const clickX = element.screenX
      const clickY = element.screenY
      const button = (args.button === 'right' || args.button === 'middle') ? args.button as string : 'left'
      const clickCount = args.clickType === 'double' ? 2 : 1

      const clickResult = darwin.mouseClick(clickX, clickY, button, clickCount)
      if (!clickResult.success) {
        return { isError: true, content: [{ type: 'text', text: `Click failed: ${clickResult.error || 'unknown error'}` }] }
      }

      // Capture verification screenshot
      const verifyPath = `/tmp/spectrai_click_verify_${Date.now()}.png`
      const vSize = 150
      const vx = Math.max(0, clickX - vSize)
      const vy = Math.max(0, clickY - vSize)
      darwin.screenshot({ output: verifyPath, region: `${vx},${vy},${vSize * 2},${vSize * 2}` })

      return {
        content: [{
          type: 'text',
          text: `Clicked [${elemNum}] "${element.name}" at screen(${clickX},${clickY}) — ${button} ${clickCount === 2 ? 'double' : 'single'}\n\nVerification image: ${verifyPath}\nShows 300x300 region centered on click. Use Read tool to confirm it hit the right target.`,
        }],
      }
    },
    { title: 'Click Element', destructiveHint: true },
  )

  // ──────────────────────────────────────────────────────────────────────
  // 2. get_screen_info
  // ──────────────────────────────────────────────────────────────────────
  registerTool(
    'get_screen_info',
    'Get screen resolution, DPI, and scale factor.',
    { type: 'object', properties: {}, additionalProperties: false },
    async () => {
      const result = darwin.screenInfo()
      if (!result.success) {
        return { isError: true, content: [{ type: 'text', text: `Screen info failed: ${result.error || 'unknown error'}` }] }
      }
      const screens = result.data?.screens || []
      if (screens.length === 0) {
        return { isError: true, content: [{ type: 'text', text: 'No screens detected' }] }
      }
      const primary = screens[0]
      const info = {
        Width: primary.width,
        Height: primary.height,
        DpiX: (primary.scaleFactor || 1) * 72,
        DpiY: (primary.scaleFactor || 1) * 72,
        ScaleFactor: primary.scaleFactor || 1,
        AllScreens: screens,
      }
      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] }
    },
    { title: 'Get Screen Info', readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  )

  // ──────────────────────────────────────────────────────────────────────
  // 3. mouse_click
  // ──────────────────────────────────────────────────────────────────────
  registerTool(
    'mouse_click',
    '★ STEP 3: Click at exact screen coordinates. Best used AFTER zoom_screenshot.\n\n' +
    'Read the grid coordinate labels from the zoomed image, then pass those exact X,Y numbers here.\n' +
    'Returns a verification screenshot showing where the click landed.\n' +
    'Only click ONCE — many UI buttons toggle state (like/unlike), clicking twice cancels the action.',
    {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate (logical pixels)' },
        y: { type: 'number', description: 'Y coordinate (logical pixels)' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button' },
        clickType: { type: 'string', enum: ['single', 'double'], description: 'Click type' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    async (args) => {
      const px = sn(args.x)
      const py = sn(args.y)
      const button = (args.button === 'right' || args.button === 'middle') ? args.button as string : 'left'
      const clickCount = args.clickType === 'double' ? 2 : 1

      const clickResult = darwin.mouseClick(px, py, button, clickCount)
      if (!clickResult.success) {
        return { isError: true, content: [{ type: 'text', text: `Click failed: ${clickResult.error || 'unknown error'}` }] }
      }

      // Capture verification screenshot
      const verifyPath = `/tmp/spectrai_click_verify_${Date.now()}.png`
      const vSize = 150
      const vx = Math.max(0, px - vSize)
      const vy = Math.max(0, py - vSize)
      darwin.screenshot({ output: verifyPath, region: `${vx},${vy},${vSize * 2},${vSize * 2}` })

      return {
        content: [{
          type: 'text',
          text: `Clicked ${button} at screen(${px},${py})\n\nVerification image: ${verifyPath}\nShows 300x300 region centered on click. Use Read tool to confirm the click hit the correct target.`,
        }],
      }
    },
    { title: 'Mouse Click', destructiveHint: true },
  )

  // ──────────────────────────────────────────────────────────────────────
  // 4. mouse_move
  // ──────────────────────────────────────────────────────────────────────
  registerTool(
    'mouse_move',
    'Move the mouse cursor to the specified coordinates (logical pixels).',
    {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate (logical pixels)' },
        y: { type: 'number', description: 'Y coordinate (logical pixels)' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    async (args) => {
      const px = sn(args.x)
      const py = sn(args.y)
      const result = darwin.mouseMove(px, py)
      if (!result.success) {
        return { isError: true, content: [{ type: 'text', text: `Move failed: ${result.error || 'unknown error'}` }] }
      }
      return { content: [{ type: 'text', text: `moved to ${px},${py}` }] }
    },
    { title: 'Mouse Move', destructiveHint: false },
  )

  // ──────────────────────────────────────────────────────────────────────
  // 5. mouse_scroll
  // ──────────────────────────────────────────────────────────────────────
  registerTool(
    'mouse_scroll',
    'Scroll the mouse wheel at the current or specified position.',
    {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate (optional, logical pixels)' },
        y: { type: 'number', description: 'Y coordinate (optional, logical pixels)' },
        delta: { type: 'number', description: 'Scroll amount (positive=up, negative=down)' },
      },
      required: ['delta'],
      additionalProperties: false,
    },
    async (args) => {
      // Move to position first if specified
      if (args.x != null && args.y != null) {
        darwin.mouseMove(sn(args.x), sn(args.y))
      }
      const delta = sn(args.delta)
      const result = darwin.mouseScroll(delta, 0)
      if (!result.success) {
        return { isError: true, content: [{ type: 'text', text: `Scroll failed: ${result.error || 'unknown error'}` }] }
      }
      return { content: [{ type: 'text', text: 'scrolled' }] }
    },
    { title: 'Mouse Scroll', destructiveHint: false },
  )

  // ──────────────────────────────────────────────────────────────────────
  // 6. keyboard_type
  // ──────────────────────────────────────────────────────────────────────
  registerTool(
    'keyboard_type',
    'Type text using the keyboard (supports Unicode).',
    {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async (args) => {
      const text = args.text as string
      const result = darwin.keyType(text)
      if (!result.success) {
        return { isError: true, content: [{ type: 'text', text: `Type failed: ${result.error || 'unknown error'}` }] }
      }
      return { content: [{ type: 'text', text: `typed ${text.length} chars` }] }
    },
    { title: 'Keyboard Type', destructiveHint: true },
  )

  // ──────────────────────────────────────────────────────────────────────
  // 7. keyboard_press
  // ──────────────────────────────────────────────────────────────────────
  registerTool(
    'keyboard_press',
    'Press a single key (e.g., Enter, Tab, Escape, F1-F12, Delete, etc.).',
    {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name (e.g., Enter, Tab, Escape, F1, Delete)' },
      },
      required: ['key'],
      additionalProperties: false,
    },
    async (args) => {
      const key = args.key as string
      // Normalize key name for macOS — DarwinHelper handles key name mapping
      const result = darwin.keyPress(key, [])
      if (!result.success) {
        return { isError: true, content: [{ type: 'text', text: `Key press failed: ${result.error || 'unknown error'}` }] }
      }
      return { content: [{ type: 'text', text: `pressed ${key}` }] }
    },
    { title: 'Keyboard Press', destructiveHint: true },
  )

  // ──────────────────────────────────────────────────────────────────────
  // 8. keyboard_hotkey
  // ──────────────────────────────────────────────────────────────────────
  registerTool(
    'keyboard_hotkey',
    'Press a keyboard shortcut/hotkey combination (e.g., Cmd+C, Ctrl+C, Alt+F4, Cmd+Shift+S).\n' +
    'On macOS, "ctrl" maps to Command key for common shortcuts (Ctrl+C → Cmd+C). Use "control" for the actual Control key.',
    {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of key names to press together, e.g. ["ctrl", "c"] or ["cmd", "shift", "s"]',
        },
      },
      required: ['keys'],
      additionalProperties: false,
    },
    async (args) => {
      const keys = args.keys as string[]
      const result = darwin.keyHotkey(keys)
      if (!result.success) {
        return { isError: true, content: [{ type: 'text', text: `Hotkey failed: ${result.error || 'unknown error'}` }] }
      }
      return { content: [{ type: 'text', text: `hotkey ${keys.join('+')}` }] }
    },
    { title: 'Keyboard Hotkey', destructiveHint: true },
  )

  // ──────────────────────────────────────────────────────────────────────
  // 9. uia_find_element (macOS: Accessibility find)
  // ──────────────────────────────────────────────────────────────────────
  registerTool(
    'uia_find_element',
    'Advanced: Find UI elements by name/role/identifier via macOS Accessibility API. Returns coordinates and state. Note: For Chrome/Electron web content, prefer screenshot + click_element instead.',
    {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Element name/title to search for' },
        automationId: { type: 'string', description: 'Accessibility identifier to search for' },
        className: { type: 'string', description: 'Element role to search for (e.g., AXButton, AXTextField)' },
        processId: { type: 'number', description: 'Limit search to a specific process ID' },
      },
      additionalProperties: false,
    },
    async (args) => {
      if (!args.name && !args.automationId && !args.className) {
        return { isError: true, content: [{ type: 'text', text: 'At least one search criterion required (name, automationId, or className)' }] }
      }

      // Determine which PID to search
      let pid: number | undefined
      if (args.processId != null) {
        pid = sn(args.processId)
      } else {
        // Use frontmost window's PID
        const winResult = darwin.windowsList()
        if (winResult.success && winResult.data?.windows?.length > 0) {
          pid = winResult.data.windows[0].ownerPid
        }
      }

      if (!pid) {
        return { isError: true, content: [{ type: 'text', text: 'No process found to search. Provide processId or ensure a window is visible.' }] }
      }

      // Get full accessibility tree and filter
      const axResult = darwin.axTree(pid, 5)
      if (!axResult.success) {
        return { isError: true, content: [{ type: 'text', text: `Accessibility query failed: ${axResult.error || 'unknown error'}` }] }
      }

      const allElements = axResult.data?.elements || []
      const results: Array<Record<string, unknown>> = []
      const searchName = args.name ? (args.name as string).toLowerCase() : null
      const searchId = args.automationId ? (args.automationId as string).toLowerCase() : null
      const searchRole = args.className ? (args.className as string).toLowerCase() : null

      for (const el of allElements) {
        let match = true
        if (searchName && !(el.title || '').toLowerCase().includes(searchName) && !(el.description || '').toLowerCase().includes(searchName)) {
          match = false
        }
        if (searchId && !(el.identifier || '').toLowerCase().includes(searchId)) {
          match = false
        }
        if (searchRole && !(el.role || '').toLowerCase().includes(searchRole)) {
          match = false
        }
        if (match) {
          results.push({
            Name: el.title || el.description || '',
            AutomationId: el.identifier || '',
            ClassName: el.role || '',
            ControlType: el.role || '',
            ProcessId: pid,
            BoundingRectangle: el.bounds ? { X: el.bounds.x, Y: el.bounds.y, Width: el.bounds.width, Height: el.bounds.height } : {},
            IsEnabled: el.enabled !== false,
          })
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] }
    },
    { title: 'UIA Find Element', readOnlyHint: true },
  )

  // ──────────────────────────────────────────────────────────────────────
  // 10. uia_get_tree (macOS: Accessibility tree)
  // ──────────────────────────────────────────────────────────────────────
  registerTool(
    'uia_get_tree',
    'Advanced: Get the full UI element tree for a window via macOS Accessibility API. Useful for understanding native app layout. For web apps, screenshot annotation is more reliable.',
    {
      type: 'object',
      properties: {
        processId: { type: 'number', description: 'Process ID to get tree for' },
        depth: { type: 'number', description: 'Max depth to traverse (default: 3, max: 10)' },
      },
      additionalProperties: false,
    },
    async (args) => {
      const depth = Math.min(Math.max(sn(args.depth, 3), 1), 10)

      let pid: number | undefined
      if (args.processId != null) {
        pid = sn(args.processId)
      } else {
        const winResult = darwin.windowsList()
        if (winResult.success && winResult.data?.windows?.length > 0) {
          pid = winResult.data.windows[0].ownerPid
        }
      }

      if (!pid) {
        return { isError: true, content: [{ type: 'text', text: 'No process found. Provide processId or ensure a window is visible.' }] }
      }

      const axResult = darwin.axTree(pid, depth)
      if (!axResult.success) {
        return { isError: true, content: [{ type: 'text', text: `Accessibility tree failed: ${axResult.error || 'unknown error'}` }] }
      }

      return { content: [{ type: 'text', text: JSON.stringify(axResult.data, null, 2) }] }
    },
    { title: 'UIA Get Tree', readOnlyHint: true },
  )

  // ──────────────────────────────────────────────────────────────────────
  // 11. window_list
  // ──────────────────────────────────────────────────────────────────────
  registerTool(
    'window_list',
    'List all visible windows with their titles, handles, and positions.',
    { type: 'object', properties: {}, additionalProperties: false },
    async () => {
      const result = darwin.windowsList()
      if (!result.success) {
        return { isError: true, content: [{ type: 'text', text: `Window list failed: ${result.error || 'unknown error'}` }] }
      }
      const windows = result.data?.windows || []
      // Format to match Windows output structure
      const formatted = windows.map((w: Record<string, unknown>) => ({
        Title: w.title || '',
        Handle: w.windowId || 0,
        OwnerName: w.ownerName || '',
        ProcessId: w.ownerPid || 0,
        Bounds: w.bounds || {},
      }))
      return { content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }] }
    },
    { title: 'Window List', readOnlyHint: true },
  )

  // ──────────────────────────────────────────────────────────────────────
  // 12. window_focus
  // ──────────────────────────────────────────────────────────────────────
  registerTool(
    'window_focus',
    'Bring a window to the foreground by title or handle.',
    {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Window title (partial match)' },
        handle: { type: 'number', description: 'Window handle (window ID on macOS)' },
      },
      additionalProperties: false,
    },
    async (args) => {
      if (!args.title && !args.handle) {
        return { isError: true, content: [{ type: 'text', text: 'Provide either title or handle' }] }
      }

      // Find the window's PID and title
      let pid: number | undefined
      let title: string | undefined

      if (args.title) {
        const searchTitle = (args.title as string).toLowerCase()
        const winResult = darwin.windowsList()
        if (winResult.success && winResult.data?.windows) {
          const match = winResult.data.windows.find(
            (w: Record<string, unknown>) => ((w.title as string) || '').toLowerCase().includes(searchTitle)
          )
          if (match) {
            pid = match.ownerPid as number
            title = match.title as string
          }
        }
        if (!pid) {
          return { isError: true, content: [{ type: 'text', text: 'Window not found' }] }
        }
      } else {
        // Find by window ID
        const handle = sn(args.handle)
        const winResult = darwin.windowsList()
        if (winResult.success && winResult.data?.windows) {
          const match = winResult.data.windows.find(
            (w: Record<string, unknown>) => w.windowId === handle
          )
          if (match) {
            pid = match.ownerPid as number
            title = match.title as string
          }
        }
        if (!pid) {
          return { isError: true, content: [{ type: 'text', text: 'Window not found' }] }
        }
      }

      const result = darwin.windowFocus(pid, title)
      if (!result.success) {
        return { isError: true, content: [{ type: 'text', text: `Focus failed: ${result.error || 'unknown error'}` }] }
      }
      return { content: [{ type: 'text', text: 'focused window' }] }
    },
    { title: 'Window Focus', destructiveHint: false },
  )

  // ──────────────────────────────────────────────────────────────────────
  // 13. window_close
  // ──────────────────────────────────────────────────────────────────────
  registerTool(
    'window_close',
    'Close a window by title or handle.',
    {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Window title (partial match)' },
        handle: { type: 'number', description: 'Window handle (window ID on macOS)' },
      },
      additionalProperties: false,
    },
    async (args) => {
      if (!args.title && !args.handle) {
        return { isError: true, content: [{ type: 'text', text: 'Provide either title or handle' }] }
      }

      let pid: number | undefined
      let title: string | undefined

      if (args.title) {
        const searchTitle = (args.title as string).toLowerCase()
        const winResult = darwin.windowsList()
        if (winResult.success && winResult.data?.windows) {
          const match = winResult.data.windows.find(
            (w: Record<string, unknown>) => ((w.title as string) || '').toLowerCase().includes(searchTitle)
          )
          if (match) {
            pid = match.ownerPid as number
            title = match.title as string
          }
        }
        if (!pid) {
          return { isError: true, content: [{ type: 'text', text: 'Window not found' }] }
        }
      } else {
        const handle = sn(args.handle)
        const winResult = darwin.windowsList()
        if (winResult.success && winResult.data?.windows) {
          const match = winResult.data.windows.find(
            (w: Record<string, unknown>) => w.windowId === handle
          )
          if (match) {
            pid = match.ownerPid as number
            title = match.title as string
          }
        }
        if (!pid) {
          return { isError: true, content: [{ type: 'text', text: 'Window not found' }] }
        }
      }

      const result = darwin.windowClose(pid, title)
      if (!result.success) {
        return { isError: true, content: [{ type: 'text', text: `Close failed: ${result.error || 'unknown error'}` }] }
      }
      return { content: [{ type: 'text', text: 'closed window' }] }
    },
    { title: 'Window Close', destructiveHint: true },
  )

  // ──────────────────────────────────────────────────────────────────────
  // 14. zoom_screenshot
  // ──────────────────────────────────────────────────────────────────────
  registerTool(
    'zoom_screenshot',
    '★ STEP 2 (after screenshot): Zoom into a region at NATIVE resolution with COORDINATE GRID.\n\n' +
    'HOW TO USE:\n' +
    '1. From the full screenshot, identify the AREA where your target is\n' +
    '2. Call zoom_screenshot(x, y, width, height) on that area — use generous size (200-400px) to ensure target is captured\n' +
    '3. Read the zoomed image — the GRID LABELS show absolute screen coordinates\n' +
    '4. Find your target element, read the nearest grid label numbers for its center X,Y\n' +
    '5. Call mouse_click(x, y) with those EXACT coordinates — ONE shot, do NOT repeat\n\n' +
    'GRID LABELS = absolute screen coordinates. Pass them directly to mouse_click. No math or estimation needed.\n' +
    'Also auto-detects elements via Accessibility + OCR. If numbered elements appear, use click_element(number) instead.',
    {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Left X coordinate of zoom region (screen pixels)' },
        y: { type: 'number', description: 'Top Y coordinate of zoom region (screen pixels)' },
        width: { type: 'number', description: 'Width of zoom region. Default: 400' },
        height: { type: 'number', description: 'Height of zoom region. Default: 400' },
        scale: { type: 'number', description: 'Upscale factor for tiny regions (2 = 2x zoom). Default: 1 (native). Max: 4' },
        grid: { type: 'boolean', description: 'Overlay coordinate grid with absolute screen coordinates. Default: true' },
        annotate: { type: 'boolean', description: 'Auto-detect elements via Accessibility + OCR. Default: true' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    async (args) => {
      const zx = sn(args.x)
      const zy = sn(args.y)
      const zw = args.width != null ? sn(args.width) : 400
      const zh = args.height != null ? sn(args.height) : 400
      const scale = args.scale != null ? Math.max(1, Math.min(4, sn(args.scale))) : 1
      const grid = args.grid !== false
      const annotate = args.annotate !== false

      const outPath = `/tmp/spectrai_zoom_${Date.now()}.png`
      const region = `${zx},${zy},${zw},${zh}`

      // Step 1: Capture region
      const ssResult = darwin.screenshot({ output: outPath, region })
      if (!ssResult.success) {
        return { isError: true, content: [{ type: 'text', text: `Zoom capture failed: ${ssResult.error || 'unknown error'}` }] }
      }

      const ssData = ssResult.data as { path: string; width: number; height: number }
      const filePath = ssData.path || outPath
      const imageW = ssData.width || zw
      const imageH = ssData.height || zh

      // Store metadata
      const meta: ScreenshotMeta = {
        captureX: zx, captureY: zy,
        captureW: zw, captureH: zh,
        imageW, imageH,
      }
      screenshotMetaMap.set(filePath, meta)
      lastScreenshotPath = filePath

      // Step 2: Annotate
      let elementListText = ''
      if (annotate) {
        try {
          const elements: AnnotatedElement[] = []
          let idx = 1

          // Accessibility detection
          const winResult = darwin.windowsList()
          if (winResult.success && winResult.data?.windows?.length > 0) {
            const frontPid = winResult.data.windows[0].ownerPid
            if (frontPid) {
              const axResult = darwin.axTree(frontPid, 3)
              if (axResult.success && axResult.data?.elements) {
                for (const el of axResult.data.elements) {
                  if (!el.bounds) continue
                  const elCx = Math.round(el.bounds.x + el.bounds.width / 2)
                  const elCy = Math.round(el.bounds.y + el.bounds.height / 2)
                  if (elCx < zx || elCx >= zx + zw) continue
                  if (elCy < zy || elCy >= zy + zh) continue
                  if (el.bounds.width <= 2 || el.bounds.height <= 2) continue
                  if (el.bounds.width > zw || el.bounds.height > zh) continue

                  const label = el.title || el.description || el.role || ''
                  const isClickable = /button|link|menuitem|tab|checkbox|radio|combobox|slider|image/i.test(el.role || '')
                  if (!label && !isClickable) continue

                  elements.push({
                    number: idx,
                    name: label || (el.role || 'element'),
                    controlType: el.role || 'AX.Unknown',
                    screenX: elCx,
                    screenY: elCy,
                  })
                  idx++
                  if (idx > 60) break
                }
              }
            }
          }

          // OCR fallback
          if (elements.length < 10) {
            const ocrResult = darwin.ocr(filePath)
            if (ocrResult.success && ocrResult.data?.results) {
              for (const r of ocrResult.data.results) {
                if (!r.bounds) continue
                const cx = Math.round(r.bounds.x + r.bounds.width / 2)
                const cy = Math.round(r.bounds.y + r.bounds.height / 2)
                if (cx < zx || cx >= zx + zw) continue
                if (cy < zy || cy >= zy + zh) continue

                elements.push({
                  number: idx,
                  name: r.text || '',
                  controlType: 'OCR.Text',
                  screenX: cx,
                  screenY: cy,
                })
                idx++
                if (idx > 80) break
              }
            }
          }

          if (elements.length > 0) {
            meta.elements = elements
            screenshotMetaMap.set(filePath, meta)
            lastAnnotatedPath = filePath
          }

          const axCount = elements.filter(e => !e.controlType.startsWith('OCR')).length
          const ocrCount = elements.filter(e => e.controlType.startsWith('OCR')).length
          elementListText = elements.length > 0
            ? `\n\nDetected ${axCount} UI elements + ${ocrCount} OCR texts:\n` +
              elements.map(e => `  [${e.number}] "${e.name}" (${e.controlType})`).join('\n')
            : ''
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err)
          elementListText = `\n\nAnnotation error: ${errMsg}`
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
      }
    },
    { title: 'Zoom Screenshot', readOnlyHint: true },
  )
}
