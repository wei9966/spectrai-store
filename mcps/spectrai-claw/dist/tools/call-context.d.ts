export interface ToolCallContext {
    sessionId?: string;
    cwd?: string;
}
export declare const META_SESSION_ID = "spectrai/sessionId";
export declare const META_CWD = "spectrai/cwd";
export declare function contextFromMeta(meta: unknown): ToolCallContext;
export declare function runWithToolCallContext<T>(context: ToolCallContext, fn: () => T): T;
export declare function currentToolCallContext(): ToolCallContext;
/** Relative paths resolve against the calling session's directory, not the shared process cwd. */
export declare function resolveCallPath(p: string): string;
/** State bucket per calling session. Hosts that send no identity share one bucket (standalone use). */
export declare class SessionStateStore<T> {
    private readonly create;
    private readonly maxSessions;
    private readonly states;
    constructor(create: () => T, maxSessions?: number);
    current(): T;
}
