import type { BrowserAction, BrowserActionResult, BrowserCapabilityReport, BrowserComputerUseProvider, BrowserConnectionOptions, BrowserDomSnapshot, BrowserElement, BrowserSelector, BrowserTarget, BrowserTargetQuery, BrowserWindow } from './types.js';
export declare class BrowserDomCdpProvider implements BrowserComputerUseProvider {
    private readonly http;
    private readonly defaultTimeoutMs;
    private ensurePromise;
    constructor(options?: BrowserConnectionOptions);
    listTargets(): Promise<BrowserTarget[]>;
    listWindows(): Promise<BrowserWindow[]>;
    readDomSnapshot(selector?: BrowserSelector, maxElements?: number, target?: BrowserTargetQuery): Promise<BrowserDomSnapshot>;
    findElement(selector: BrowserSelector, target?: BrowserTargetQuery): Promise<BrowserElement | null>;
    executeAction(action: BrowserAction, target?: BrowserTargetQuery): Promise<BrowserActionResult>;
    getCapabilityReport(): Promise<BrowserCapabilityReport>;
    getAppState(target?: BrowserTargetQuery): Promise<BrowserDomSnapshot>;
    getAppTree(target?: BrowserTargetQuery): Promise<BrowserDomSnapshot>;
    invokeElement(selectorOrElement: BrowserSelector | BrowserElement, action?: Partial<BrowserAction>, target?: BrowserTargetQuery): Promise<BrowserActionResult>;
    setValue(selectorOrElement: BrowserSelector | BrowserElement, value: string, target?: BrowserTargetQuery): Promise<BrowserActionResult>;
    getCapabilities(): Promise<BrowserCapabilityReport>;
    private ensureReady;
    private normalizeAction;
    private resolveTarget;
    private evaluate;
    private withTargetMetadata;
    private safeElementState;
    private verifyAction;
    private defaultVerification;
    private toFailure;
    private fallbackForFailure;
}
