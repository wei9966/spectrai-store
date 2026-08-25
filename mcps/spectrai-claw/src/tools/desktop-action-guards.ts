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

export interface ElementLocalState {
  toggle?: string
  expand?: string
  value?: string
  selected?: string
  focus?: string
  alive?: boolean
}

/**
 * Local UIA activation signal for selection-like rows.
 * Selected-only / Focus-only flips are NOT activation (common Select false positives).
 * Toggle / Expand / Value change, or element leaving the tree, count.
 */
export function localActivationStateChanged(
  before: ElementLocalState,
  after: ElementLocalState,
): boolean {
  if (after.alive === false) return true
  return (
    String(before.toggle || '') !== String(after.toggle || '') ||
    String(before.expand || '') !== String(after.expand || '') ||
    String(before.value || '') !== String(after.value || '')
  )
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
export function activationEvidenceMatches(input: {
  targetName?: string
  beforeTitle?: string
  afterTitle?: string
  foregroundTitle?: string
  localStateChanged?: boolean
  elementGone?: boolean
  targetNameOutsideSelection?: boolean
}): boolean {
  if (input.localStateChanged) return true
  if (input.elementGone) return true
  if (input.targetNameOutsideSelection) return true
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
 * Activatable success requires verify==='verified' — uncertain/resnapshot/empty ≠ success.
 */
export function shouldFallbackClickAfterUia(
  result: { ok: boolean; verify?: string; reason?: string },
  isActivatable: boolean,
): boolean {
  if (!isActivatable) return !result.ok
  if (result.reason === 'needs_fallback_click') return true
  if (result.verify === 'needs_fallback_click' || result.verify === 'state_not_changed') return true
  if (!result.ok) return true
  if (result.verify !== 'verified') return true
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

/**
 * Final HID probe for activatable rows: still no evidence → hard fail
 * (not another needs_fallback_click loop).
 */
export function interpretActivatableHidVerify(input: {
  activatedAfter: boolean
}): { ok: boolean; verify: string; reason: string } {
  if (input.activatedAfter) {
    return { ok: true, verify: 'verified', reason: '' }
  }
  return {
    ok: false,
    verify: 'state_not_changed',
    reason: 'activation_unconfirmed',
  }
}

/** One short HID path: escalate left-single → double for activatable rows. */
export function resolveHidClickTypeForActivatable(input: {
  isActivatable: boolean
  button: string
  clickType: string
}): string {
  if (input.isActivatable && input.button === 'left' && input.clickType === 'single') {
    return 'double'
  }
  return input.clickType
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

/**
 * Focus ShowWindow policy: restore minimized OR tray/hidden (visible=false, often non-iconic).
 * Already-visible non-iconic windows must not get unconditional SW_SHOW(5).
 * ponytail: ceiling = restore+repaint for hidden; upgrade to SW_SHOWNA only if a real app needs it.
 */
export type FocusShowAction = 'none' | 'restore'

export function resolveFocusShowAction(input: {
  iconic: boolean
  visible?: boolean
}): FocusShowAction {
  if (input.iconic || input.visible === false) return 'restore'
  return 'none'
}

export type ScreenshotCaptureMode =
  | 'explicit'
  | 'allScreens'
  | 'monitor'
  | 'followWindow'
  | 'primary'

/**
 * Pick screenshot capture mode. Explicit region / allScreens / monitor win.
 * Optional follow* only applies when caller did not pin region/monitor/allScreens.
 * Missing follow target → caller falls back to primary (same as legacy monitor=0).
 */
export function resolveScreenshotCaptureMode(input: {
  hasExplicitRegion?: boolean
  allScreens?: boolean
  monitorExplicit?: boolean
  followForeground?: boolean
  followHandle?: number | null
  followWindowTitle?: string | null
  followProcessId?: number | null
}): ScreenshotCaptureMode {
  if (input.hasExplicitRegion) return 'explicit'
  if (input.allScreens) return 'allScreens'
  if (input.monitorExplicit) return 'monitor'
  const title = String(input.followWindowTitle || '').trim()
  const handle = input.followHandle
  const pid = input.followProcessId
  if (
    input.followForeground === true ||
    (handle != null && Number.isFinite(handle) && handle !== 0) ||
    title.length > 0 ||
    (pid != null && Number.isFinite(pid) && pid !== 0)
  ) {
    return 'followWindow'
  }
  return 'primary'
}

export interface ScreenBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Choose capture bounds from a followed window's screen, else primary.
 * Pure: PS/Screen.FromHandle result is injected by caller.
 */
export function resolveFollowWindowCaptureBounds(input: {
  windowScreen?: ScreenBounds | null
  primaryScreen: ScreenBounds
}): ScreenBounds {
  const s = input.windowScreen
  if (
    s &&
    Number.isFinite(s.x) &&
    Number.isFinite(s.y) &&
    Number.isFinite(s.width) &&
    Number.isFinite(s.height) &&
    s.width > 0 &&
    s.height > 0
  ) {
    return { x: s.x, y: s.y, width: s.width, height: s.height }
  }
  return { ...input.primaryScreen }
}

/**
 * After iconic SW_RESTORE, force a cheap client/frame repaint before SetForeground.
 * Visible non-iconic windows must not get ShowWindow(5); repaint is restore-only.
 */
export function shouldRepaintAfterFocusShow(action: FocusShowAction): boolean {
  return action === 'restore'
}

/** Cheap downsample unique-color ceiling for "整窗灰" / DWM placeholder detection. */
export const NEAR_MONO_MAX_UNIQUE = 4
/** Luma variance ceiling (0–255 scale); solid gray ≈ 0. */
export const NEAR_MONO_MAX_LUMINANCE_VARIANCE = 8
/**
 * Follow-path "near gray" after tray/hide restore: uniq still above near-mono
 * (smoke ≈149) but palette+variance stay suspiciously low.
 */
export const SUSPICIOUS_BLANK_MAX_UNIQUE = 256
export const SUSPICIOUS_BLANK_MAX_LUMINANCE_VARIANCE = 200

export interface CaptureColorStats {
  /** Distinct packed RGB after cheap downsample / grid sample. */
  uniqueColors: number
  /** Optional luminance variance; omit when only uniq is available. */
  luminanceVariance?: number
}

/**
 * Near-monochrome / blank capture heuristic.
 * uniq≤N OR (when provided) luma variance≤threshold → blank.
 */
export function isNearMonochromeCapture(
  stats: CaptureColorStats,
  opts?: { maxUnique?: number; maxLuminanceVariance?: number },
): boolean {
  const maxUnique = opts?.maxUnique ?? NEAR_MONO_MAX_UNIQUE
  const maxVar = opts?.maxLuminanceVariance ?? NEAR_MONO_MAX_LUMINANCE_VARIANCE
  if (!Number.isFinite(stats.uniqueColors) || stats.uniqueColors < 0) return false
  if (stats.uniqueColors <= maxUnique) return true
  if (
    stats.luminanceVariance != null &&
    Number.isFinite(stats.luminanceVariance) &&
    stats.luminanceVariance <= maxVar
  ) {
    return true
  }
  return false
}

/**
 * Follow* only: near-mono OR (low uniq ∧ low variance) → try PrintWindow.
 * Keeps solid wallpapers on non-follow paths out of scope (caller gates allowPwFallback).
 * ponytail: ceiling = one extra band for post-restore gray; tighten if UI false-triggers.
 */
export function isSuspiciousBlankCapture(stats: CaptureColorStats): boolean {
  if (isNearMonochromeCapture(stats)) return true
  if (!Number.isFinite(stats.uniqueColors) || stats.uniqueColors < 0) return false
  if (stats.uniqueColors > SUSPICIOUS_BLANK_MAX_UNIQUE) return false
  if (
    stats.luminanceVariance == null ||
    !Number.isFinite(stats.luminanceVariance)
  ) {
    return false
  }
  return stats.luminanceVariance <= SUSPICIOUS_BLANK_MAX_LUMINANCE_VARIANCE
}

export function hasResolvableCaptureHwnd(hwnd?: number | null): boolean {
  return hwnd != null && Number.isFinite(hwnd) && hwnd !== 0
}

/**
 * PrintWindow(PW_RENDERFULLCONTENT) only when the GDI screen grab looks blank
 * AND the caller already resolved a target HWND (follow* / fg).
 */
export function shouldPrintWindowFallback(input: {
  isNearBlank: boolean
  targetHwnd?: number | null
}): boolean {
  return input.isNearBlank && hasResolvableCaptureHwnd(input.targetHwnd)
}

export type CaptureBlankDecision = 'ok' | 'try_printwindow' | 'capture_blank'

/**
 * Screenshot blank-path state machine:
 * blank+hwnd → try PrintWindow once; still blank → capture_blank signal;
 * blank without hwnd → capture_blank (do not silently annotate as success).
 */
export function resolveCaptureBlankDecision(input: {
  isNearBlank: boolean
  targetHwnd?: number | null
  printWindowTried?: boolean
  stillBlankAfterPrintWindow?: boolean
}): CaptureBlankDecision {
  const hasHwnd = hasResolvableCaptureHwnd(input.targetHwnd)
  if (!input.printWindowTried) {
    if (!input.isNearBlank) return 'ok'
    if (hasHwnd) return 'try_printwindow'
    return 'capture_blank'
  }
  // After PrintWindow: only the post-fallback blank flag matters.
  if (input.stillBlankAfterPrintWindow) return 'capture_blank'
  return 'ok'
}
