import { exec } from 'child_process'
import { registerTool } from './registry.js'
import { runPowerShell } from '../helpers/PowerShellRunner.js'
import { PolicyEngine } from '../security/PolicyEngine.js'
import type { CallToolResult } from '../types/index.js'

const DEFAULT_TIMEOUT = 30000

function textResult(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

export function registerShellTools(): void {
  registerTool(
    'shell_execute',
    '执行 Shell 命令（cmd.exe），返回 stdout/stderr/exitCode',
    {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '工作目录（可选）' },
        timeout: { type: 'number', description: '超时时间（毫秒），默认 30000' },
      },
      required: ['command'],
    },
    async (args): Promise<CallToolResult> => {
      const command = args.command as string
      const cwd = (args.cwd as string) || undefined
      const timeout = (args.timeout as number) || DEFAULT_TIMEOUT

      const validation = PolicyEngine.validateCommand(command)
      if (!validation.allowed) {
        return errorResult(`Command blocked: ${validation.reason}`)
      }

      return new Promise((resolve) => {
        exec(command, { cwd, timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
          if (error && 'killed' in error && error.killed) {
            resolve(errorResult(`Command timed out after ${timeout}ms`))
            return
          }
          resolve(textResult({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            exitCode: error ? (error as any).code ?? 1 : 0,
          }))
        })
      })
    },
    { title: 'Shell Execute', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  )

  registerTool(
    'shell_powershell',
    '执行 PowerShell 脚本，返回 stdout/stderr/exitCode',
    {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'PowerShell 脚本内容' },
        cwd: { type: 'string', description: '工作目录（可选）' },
        timeout: { type: 'number', description: '超时时间（毫秒），默认 30000' },
      },
      required: ['script'],
    },
    async (args): Promise<CallToolResult> => {
      const script = args.script as string
      const cwd = (args.cwd as string) || undefined
      const timeout = (args.timeout as number) || DEFAULT_TIMEOUT

      const validation = PolicyEngine.validatePowerShellScript(script)
      if (!validation.allowed) {
        return errorResult(`Script blocked: ${validation.reason}`)
      }

      const fullScript = cwd ? `Set-Location '${cwd.replace(/'/g, "''")}'; ${script}` : script

      try {
        const result = await runPowerShell(fullScript, timeout)
        return textResult({
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err))
      }
    },
    { title: 'Shell PowerShell', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  )
}
