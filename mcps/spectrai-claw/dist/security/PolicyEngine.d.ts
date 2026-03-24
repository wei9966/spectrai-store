/**
 * Security policy engine for validating commands, process operations, and file paths.
 */
export declare class PolicyEngine {
    /** Commands/keywords that are never allowed */
    private static BLOCKED_COMMANDS;
    /** Patterns that indicate shell injection attempts */
    private static INJECTION_PATTERNS;
    /** System processes that must never be killed */
    private static PROTECTED_PROCESSES;
    /** Directories that should not be written to or deleted from */
    private static PROTECTED_PATHS;
    /**
     * Validate a shell command before execution.
     */
    static validateCommand(command: string): {
        allowed: boolean;
        reason?: string;
    };
    /**
     * Validate a PowerShell script before execution.
     */
    static validatePowerShellScript(script: string): {
        allowed: boolean;
        reason?: string;
    };
    /**
     * Validate whether a process can be killed.
     */
    static validateProcessKill(name: string): {
        allowed: boolean;
        reason?: string;
    };
    /**
     * Validate a file path for read/write/delete operations.
     */
    static validateFilePath(filePath: string, operation?: 'read' | 'write' | 'delete'): {
        allowed: boolean;
        reason?: string;
    };
    /**
     * Sanitize a numeric value for safe embedding in scripts.
     * Ensures only valid integers/floats pass through.
     */
    static sanitizeNumber(value: unknown, defaultVal?: number): number;
    /**
     * Sanitize a string for safe embedding in PowerShell single-quoted strings.
     * Escapes single quotes and removes dangerous characters.
     */
    static sanitizeForPowerShell(value: string): string;
}
