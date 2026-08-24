/**
 * Pure guards for desktop click/focus postconditions.
 * Kept side-effect free so unit tests do not touch PersistentShell.
 */

export interface ActivationTitles {
  windowTitle: string
  foregroundTitle: string
}

export interface ForegroundProbe {
  targetHwnd: number
  foregroundHwnd: number
  visible: boolean
  iconic: boolean
  foregroundTitle?: string
}

/** List/Tree/Tab/Menu rows where Select/IsSelected ≠ activate/open. */
export function isActivatableSelectionItem(element: {
  controlType?: string
  automationId?: string
}): boolean {
  const ct = String(element.controlType || '').replace(/^ControlType\./i, '')
  return /^(ListItem|TreeItem|TabItem|MenuItem)$/i.test(ct)
}

/**
 * Cheap activation evidence after Select:
 * 1) non-Selected local UIA state change, or
 * 2) owning/fg window title contains target name, or
 * 3) window/fg title changed vs before.
 */
export function activationEvidenceMatches(input: {
  targetName?: string
  beforeTitle?: string
  afterTitle?: string
  foregroundTitle?: string
  localStateChanged?: boolean
}): boolean {
  if (input.localStateChanged) return true
  const target = String(input.targetName || '').trim()
  const after = String(input.afterTitle || '')
  const fg = String(input.foregroundTitle || '')
  const before = String(input.beforeTitle || '')
  if (target) {
    if (after.includes(target) || fg.includes(target)) return true
  }
  if (before && after && before !== after) return true
  if (before && fg && before !== fg) return true
  return false
}

/**
 * Select/IsSelected alone is not "activated" for selection-like rows.
 * UIA path should force one HID fallback when activation evidence is missing.
 */
export function shouldFallbackClickAfterUia(
  result: { ok: boolean; verify?: string; reason?: string },
  isActivatable: boolean,
): boolean {
  if (!isActivatable) return !result.ok
  if (result.reason === 'needs_fallback_click') return true
  if (result.verify === 'needs_fallback_click' || result.verify === 'state_not_changed') return true
  if (!result.ok) return true
  return false
}

/** Treat Select without activation evidence as non-success. */
export function interpretActivatableSelectVerify(input: {
  activatedAfter: boolean
}): { ok: boolean; verify: string; reason: string } {
  if (input.activatedAfter) {
    return { ok: true, verify: 'verified', reason: '' }
  }
  // selected ≠ activated
  return {
    ok: false,
    verify: 'state_not_changed',
    reason: 'needs_fallback_click',
  }
}

const SELF_OCCLUDE_RE = /spectrai|claude\s*code|cursor|visual studio code/i

export function classifyForegroundResult(probe: ForegroundProbe): {
  ok: boolean
  reason: string
} {
  if (!probe.targetHwnd) {
    return { ok: false, reason: 'focus_failed:window_not_found' }
  }
  if (probe.iconic) {
    return { ok: false, reason: 'focus_failed:minimized' }
  }
  if (!probe.visible) {
    return { ok: false, reason: 'focus_failed:not_visible' }
  }
  if (probe.foregroundHwnd === probe.targetHwnd) {
    return { ok: true, reason: '' }
  }
  const fgTitle = String(probe.foregroundTitle || '')
  if (SELF_OCCLUDE_RE.test(fgTitle)) {
    return { ok: false, reason: 'target_occluded' }
  }
  return { ok: false, reason: 'focus_failed:not_foreground' }
}
