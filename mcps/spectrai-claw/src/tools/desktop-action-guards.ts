/**
 * Pure guards for desktop click/focus postconditions.
 * Kept side-effect free so unit tests do not touch PersistentShell.
 */

export interface ChatOpenState {
  windowTitle: string
  chatName: string
}

export interface ForegroundProbe {
  targetHwnd: number
  foregroundHwnd: number
  visible: boolean
  iconic: boolean
  foregroundTitle?: string
}

/** WeChat session rows: ListItem or automationId session_item_*. */
export function isSessionListItem(element: {
  controlType?: string
  automationId?: string
}): boolean {
  const ct = String(element.controlType || '').replace(/^ControlType\./i, '')
  if (/^ListItem$/i.test(ct)) return true
  const aid = String(element.automationId || '')
  return /^session_item_/i.test(aid)
}

/** Business open check: top-bar label or window title contains the session name. */
export function chatOpenMatches(state: ChatOpenState, targetName: string): boolean {
  const target = String(targetName || '').trim()
  if (!target) return false
  const chat = String(state.chatName || '')
  const title = String(state.windowTitle || '')
  return chat.includes(target) || title.includes(target)
}

/**
 * Select/IsSelected alone is not "opened" for session rows.
 * UIA path should force HID fallback when business postcondition fails.
 */
export function shouldFallbackClickAfterUia(
  result: { ok: boolean; verify?: string; reason?: string },
  isSession: boolean,
): boolean {
  if (!isSession) return !result.ok
  if (result.reason === 'needs_fallback_click') return true
  if (result.verify === 'needs_fallback_click' || result.verify === 'state_not_changed') return true
  if (!result.ok) return true
  return false
}

/** Treat Select+IsSelected without chat title change as non-success. */
export function interpretSessionSelectVerify(input: {
  selectedAfter: boolean
  openedAfter: boolean
}): { ok: boolean; verify: string; reason: string } {
  if (input.openedAfter) {
    return { ok: true, verify: 'verified', reason: '' }
  }
  // selected≠opened
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
