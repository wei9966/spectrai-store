/**
 * Per-call identity supplied by the host through MCP `_meta`.
 * SpectrAI shares one Claw process between sessions, so "last screenshot" state and
 * relative paths must follow the calling session rather than the process.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
export const META_SESSION_ID = 'spectrai/sessionId';
export const META_CWD = 'spectrai/cwd';
const storage = new AsyncLocalStorage();
export function contextFromMeta(meta) {
    const m = (meta && typeof meta === 'object' ? meta : {});
    const pick = (k) => (typeof m[k] === 'string' && m[k].trim() ? m[k] : undefined);
    return { sessionId: pick(META_SESSION_ID), cwd: pick(META_CWD) };
}
export function runWithToolCallContext(context, fn) {
    return storage.run(context, fn);
}
export function currentToolCallContext() {
    return storage.getStore() ?? {};
}
/** Relative paths resolve against the calling session's directory, not the shared process cwd. */
export function resolveCallPath(p) {
    const cwd = currentToolCallContext().cwd;
    return cwd ? resolve(cwd, p) : resolve(p);
}
/** State bucket per calling session. Hosts that send no identity share one bucket (standalone use). */
export class SessionStateStore {
    create;
    maxSessions;
    states = new Map();
    constructor(create, maxSessions = 64) {
        this.create = create;
        this.maxSessions = maxSessions;
    }
    current() {
        const key = currentToolCallContext().sessionId ?? '';
        let state = this.states.get(key);
        if (state) {
            this.states.delete(key); // re-insert: Map order doubles as LRU
        }
        else {
            state = this.create();
            if (this.states.size >= this.maxSessions) {
                const oldest = this.states.keys().next().value;
                if (oldest !== undefined)
                    this.states.delete(oldest);
            }
        }
        this.states.set(key, state);
        return state;
    }
}
