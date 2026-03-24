export interface ShellResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}
declare class PersistentShell {
    private proc;
    private ready;
    private readyPromise;
    private stdoutBuf;
    private pendingResolve;
    private pendingReject;
    private pendingTimer;
    /** Start or restart the persistent PowerShell process */
    start(): Promise<void>;
    private tryResolve;
    private clearTimer;
    /** Execute a script in the persistent process */
    exec(script: string, timeout?: number): Promise<ShellResult>;
    /** Kill the persistent process */
    kill(): void;
}
/** Singleton instance */
export declare const shell: PersistentShell;
export {};
