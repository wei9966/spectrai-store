/**
 * Pure guards for desktop click/focus postconditions.
 * Kept side-effect free so unit tests do not touch PersistentShell.
 */
/** List/Tree/Tab/Menu rows where Select/IsSelected ≠ activate/open. */
export function isActivatableSelectionItem(element) {
    const ct = String(element.controlType || '').replace(/^ControlType\./i, '');
    return /^(ListItem|TreeItem|TabItem|MenuItem)$/i.test(ct);
}
/**
 * Local UIA activation signal for selection-like rows.
 * Selected-only / Focus-only flips are NOT activation (common Select false positives).
 * Toggle / Expand / Value change, or element leaving the tree, count.
 */
export function localActivationStateChanged(before, after) {
    if (after.alive === false)
        return true;
    return (String(before.toggle || '') !== String(after.toggle || '') ||
        String(before.expand || '') !== String(after.expand || '') ||
        String(before.value || '') !== String(after.value || ''));
}
/**
 * Cheap activation evidence after Select / HID:
 * 1) non-Selected local UIA state change, or
 * 2) clicked selection row left the tree, or
 * 3) target name appears on a non-selection control in-process, or
 * 4) owning/fg window title contains target name, or
 * 5) window/fg title changed vs before.
 * Selected/Focus-only flips alone are never evidence.
 */
export function activationEvidenceMatches(input) {
    if (input.localStateChanged)
        return true;
    if (input.elementGone)
        return true;
    if (input.targetNameOutsideSelection)
        return true;
    const target = String(input.targetName || '').trim();
    const after = String(input.afterTitle || '');
    const fg = String(input.foregroundTitle || '');
    const before = String(input.beforeTitle || '');
    if (target) {
        if (after.includes(target) || fg.includes(target))
            return true;
    }
    if (before && after && before !== after)
        return true;
    if (before && fg && before !== fg)
        return true;
    return false;
}
/**
 * Select/IsSelected alone is not "activated" for selection-like rows.
 * UIA path should force one HID fallback when activation evidence is missing.
 * Activatable success requires verify==='verified' — uncertain/resnapshot/empty ≠ success.
 */
export function shouldFallbackClickAfterUia(result, isActivatable) {
    if (!isActivatable)
        return !result.ok;
    if (result.reason === 'needs_fallback_click')
        return true;
    if (result.verify === 'needs_fallback_click' || result.verify === 'state_not_changed')
        return true;
    if (!result.ok)
        return true;
    if (result.verify !== 'verified')
        return true;
    return false;
}
/** Treat Select without activation evidence as non-success. */
export function interpretActivatableSelectVerify(input) {
    if (input.activatedAfter) {
        return { ok: true, verify: 'verified', reason: '' };
    }
    // selected ≠ activated
    return {
        ok: false,
        verify: 'state_not_changed',
        reason: 'needs_fallback_click',
    };
}
/**
 * Final HID probe for activatable rows: still no evidence → hard fail
 * (not another needs_fallback_click loop).
 */
export function interpretActivatableHidVerify(input) {
    if (input.activatedAfter) {
        return { ok: true, verify: 'verified', reason: '' };
    }
    return {
        ok: false,
        verify: 'state_not_changed',
        reason: 'activation_unconfirmed',
    };
}
/** One short HID path: escalate left-single → double for activatable rows. */
export function resolveHidClickTypeForActivatable(input) {
    if (input.isActivatable && input.button === 'left' && input.clickType === 'single') {
        return 'double';
    }
    return input.clickType;
}
const SELF_OCCLUDE_RE = /spectrai|claude\s*code|cursor|visual studio code/i;
export function classifyForegroundResult(probe) {
    if (!probe.targetHwnd) {
        return { ok: false, reason: 'focus_failed:window_not_found' };
    }
    if (probe.iconic) {
        return { ok: false, reason: 'focus_failed:minimized' };
    }
    if (!probe.visible) {
        return { ok: false, reason: 'focus_failed:not_visible' };
    }
    if (probe.foregroundHwnd === probe.targetHwnd) {
        return { ok: true, reason: '' };
    }
    const fgTitle = String(probe.foregroundTitle || '');
    if (SELF_OCCLUDE_RE.test(fgTitle)) {
        return { ok: false, reason: 'target_occluded' };
    }
    return { ok: false, reason: 'focus_failed:not_foreground' };
}
