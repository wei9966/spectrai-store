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
