import type { ToolDefinition, ToolHandler, CallToolResult } from '../types/index.js'

interface RegisteredTool {
  definition: ToolDefinition
  handler: ToolHandler
}

const tools = new Map<string, RegisteredTool>()

export function registerTool(
  name: string,
  description: string,
  inputSchema: ToolDefinition['inputSchema'],
  handler: ToolHandler,
  annotations?: ToolDefinition['annotations'],
): void {
  if (tools.has(name)) {
    throw new Error(`Tool already registered: ${name}`)
  }

  tools.set(name, {
    definition: { name, description, inputSchema, annotations },
    handler,
  })
}

export function listTools(): ToolDefinition[] {
  return Array.from(tools.values()).map(t => t.definition)
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const tool = tools.get(name)
  if (!tool) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    }
  }

  try {
    return await tool.handler(args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      isError: true,
      content: [{ type: 'text', text: message }],
    }
  }
}

export function getToolCount(): number {
  return tools.size
}
