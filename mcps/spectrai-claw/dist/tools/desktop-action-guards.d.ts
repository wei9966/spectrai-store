/**
 * Pure guards for desktop click/focus postconditions.
 * Kept side-effect free so unit tests do not touch PersistentShell.
 */
export interface ActivationTitles {
    windowTitle: string;
    foregroundTitle: string;
}
export interface ForegroundProbe {
    targetHwnd: number;
    foregroundHwnd: number;
    visible: boolean;
    iconic: boolean;
    foregroundTitle?: string;
}
/** List/Tree/Tab/Menu rows where Select/IsSelected ≠ activate/open. */
export declare function isActivatableSelectionItem(element: {
    controlType?: string;
    automationId?: string;
}): boolean;
export interface ElementLocalState {
    toggle?: string;
    expand?: string;
    value?: string;
    selected?: string;
    focus?: string;
    alive?: boolean;
}
/**
 * Local UIA activation signal for selection-like rows.
 * Selected-only / Focus-only flips are NOT activation (common Select false positives).
 * Toggle / Expand / Value change, or element leaving the tree, count.
 */
export declare function localActivationStateChanged(before: ElementLocalState, after: ElementLocalState): boolean;
/**
 * Cheap activation evidence after Select / HID:
 * 1) non-Selected local UIA state change, or
 * 2) clicked selection row left the tree, or
 * 3) target name appears on a non-selection control in-process, or
 * 4) owning/fg window title contains target name, or
 * 5) window/fg title changed vs before.
 * Selected/Focus-only flips alone are never evidence.
 */
export declare function activationEvidenceMatches(input: {
    targetName?: string;
    beforeTitle?: string;
    afterTitle?: string;
    foregroundTitle?: string;
    localStateChanged?: boolean;
    elementGone?: boolean;
    targetNameOutsideSelection?: boolean;
}): boolean;
/**
 * Select/IsSelected alone is not "activated" for selection-like rows.
 * UIA path should force one HID fallback when activation evidence is missing.
 * Activatable success requires verify==='verified' — uncertain/resnapshot/empty ≠ success.
 */
export declare function shouldFallbackClickAfterUia(result: {
    ok: boolean;
    verify?: string;
    reason?: string;
}, isActivatable: boolean): boolean;
/** Treat Select without activation evidence as non-success. */
export declare function interpretActivatableSelectVerify(input: {
    activatedAfter: boolean;
}): {
    ok: boolean;
    verify: string;
    reason: string;
};
/**
 * Final HID probe for activatable rows: still no evidence → hard fail
 * (not another needs_fallback_click loop).
 */
export declare function interpretActivatableHidVerify(input: {
    activatedAfter: boolean;
}): {
    ok: boolean;
    verify: string;
    reason: string;
};
/** One short HID path: escalate left-single → double for activatable rows. */
export declare function resolveHidClickTypeForActivatable(input: {
    isActivatable: boolean;
    button: string;
    clickType: string;
}): string;
export declare function classifyForegroundResult(probe: ForegroundProbe): {
    ok: boolean;
    reason: string;
};
/**
 * Focus ShowWindow policy: restore minimized only.
 * Already-visible non-iconic windows must not get unconditional SW_SHOW(5).
 * ponytail: ceiling = iconic-only restore; upgrade to SW_SHOWNA only if a real app needs it.
 */
export type FocusShowAction = 'none' | 'restore';
export declare function resolveFocusShowAction(input: {
    iconic: boolean;
}): FocusShowAction;
export type ScreenshotCaptureMode = 'explicit' | 'allScreens' | 'monitor' | 'followWindow' | 'primary';
/**
 * Pick screenshot capture mode. Explicit region / allScreens / monitor win.
 * Optional follow* only applies when caller did not pin region/monitor/allScreens.
 * Missing follow target → caller falls back to primary (same as legacy monitor=0).
 */
export declare function resolveScreenshotCaptureMode(input: {
    hasExplicitRegion?: boolean;
    allScreens?: boolean;
    monitorExplicit?: boolean;
    followForeground?: boolean;
    followHandle?: number | null;
    followWindowTitle?: string | null;
    followProcessId?: number | null;
}): ScreenshotCaptureMode;
export interface ScreenBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}
/**
 * Choose capture bounds from a followed window's screen, else primary.
 * Pure: PS/Screen.FromHandle result is injected by caller.
 */
export declare function resolveFollowWindowCaptureBounds(input: {
    windowScreen?: ScreenBounds | null;
    primaryScreen: ScreenBounds;
}): ScreenBounds;
