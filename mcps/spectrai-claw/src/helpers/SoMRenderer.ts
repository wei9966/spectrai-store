import fs from 'node:fs/promises'
import path from 'node:path'

export interface MCPImageContent {
  type: 'image'
  data: string
  mimeType: 'image/png' | 'image/jpeg'
}

export interface MCPTextContent {
  type: 'text'
  text: string
}

export type MCPContent = MCPImageContent | MCPTextContent

function resolveMimeType(filePath: string): MCPImageContent['mimeType'] {
  const ext = path.extname(filePath).toLowerCase()

  if (ext === '.png') {
    return 'image/png'
  }

  if (ext === '.jpg' || ext === '.jpeg') {
    return 'image/jpeg'
  }

  throw new Error(`Unsupported image type for MCP embedding: ${filePath}`)
}

function stringifyElementLabel(label: string): string {
  return label.replaceAll('"', '\\"')
}

/**
 * 单纯把图片文件读成 MCP image content（不附带文字）。
 */
export async function imageContentFromFile(filePath: string): Promise<MCPImageContent> {
  let fileData: Buffer

  try {
    fileData = await fs.readFile(filePath)
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error)
    throw new Error(`Image file not found or unreadable: ${filePath}. ${details}`)
  }

  return {
    type: 'image',
    data: Buffer.from(fileData).toString('base64'),
    mimeType: resolveMimeType(filePath),
  }
}

/**
 * 把 annotated 截图嵌入 MCP content blocks。
 * 返回 [text 描述 + image content + text 元素列表]
 */
export async function embedAnnotatedScreenshot(opts: {
  rawPath: string
  annotatedPath?: string
  uiElements: Array<{ id: string; role: string; label: string; is_actionable: boolean }>
  applicationName?: string
  windowTitle?: string
  snapshotId: string
  warnings?: string[]
}): Promise<MCPContent[]> {
  const candidatePaths = opts.annotatedPath ? [opts.annotatedPath, opts.rawPath] : [opts.rawPath]

  let screenshotContent: MCPImageContent | null = null
  let lastError: unknown = null

  for (const candidatePath of candidatePaths) {
    try {
      screenshotContent = await imageContentFromFile(candidatePath)
      break
    } catch (error) {
      lastError = error
    }
  }

  if (!screenshotContent) {
    if (lastError instanceof Error) {
      throw lastError
    }
    throw new Error('Failed to load screenshot for MCP embedding.')
  }

  const summaryLines = ['UI snapshot captured.', `snapshot_id: ${opts.snapshotId}`]

  if (opts.applicationName) {
    summaryLines.push(`application: ${opts.applicationName}`)
  }

  if (opts.windowTitle) {
    summaryLines.push(`window: ${opts.windowTitle}`)
  }

  if (opts.warnings && opts.warnings.length > 0) {
    summaryLines.push(`warnings: ${opts.warnings.join(' | ')}`)
  }

  const actionableElements = opts.uiElements.filter((item) => item.is_actionable)
  const elementLines = ['Actionable elements:']

  if (actionableElements.length === 0) {
    elementLines.push('(none)')
  } else {
    for (const item of actionableElements) {
      elementLines.push(`[${item.id}] ${item.role} "${stringifyElementLabel(item.label)}"`)
    }
  }

  return [
    {
      type: 'text',
      text: summaryLines.join('\n'),
    },
    screenshotContent,
    {
      type: 'text',
      text: elementLines.join('\n'),
    },
  ]
}
