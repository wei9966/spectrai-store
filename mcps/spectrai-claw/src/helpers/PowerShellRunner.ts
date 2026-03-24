/**
 * PowerShellRunner — delegates to PersistentShell for fast execution.
 * Kept as a thin wrapper for backward compatibility with shell-tools and file-tools.
 */
import { shell, ShellResult } from './PersistentShell.js'

export type { ShellResult as PowerShellResult }

export async function runPowerShell(
  script: string,
  timeout: number = 30000,
): Promise<ShellResult> {
  return shell.exec(script, timeout)
}
