/**
 * Pure helpers for OCR→UIA neighborhood anchoring and click-point preference.
 * Kept side-effect free for unit tests (no PersistentShell / UIA).
 */

/** Floor for OCR→UIA neighbor distance (px). */
export const OCR_UIA_NEIGHBOR_MIN_PX = 24
/** Neighbor radius = max(MIN, min(edge) * RATIO). */
export const OCR_UIA_NEIGHBOR_EDGE_RATIO = 0.3

export type AnnotatedSource = 'UIA' | 'OCR' | 'OCR_UIA'

export interface RectLike {
  x: number
  y: number
  w: number
  h: number
}

export interface OcrUiaCandidate extends RectLike {
  cx: number
  cy: number
}

/** max(24, min(w,h) * 0.3) */
export function ocrUiaNeighborThreshold(w: number, h: number): number {
  const edge = Math.min(Math.max(0, w), Math.max(0, h))
  return Math.max(OCR_UIA_NEIGHBOR_MIN_PX, edge * OCR_UIA_NEIGHBOR_EDGE_RATIO)
}

/** Euclidean distance from point to axis-aligned rect (0 if inside). */
export function distancePointToRect(cx: number, cy: number, rect: RectLike): number {
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w))
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h))
  const dx = cx - nx
  const dy = cy - ny
  return Math.sqrt(dx * dx + dy * dy)
}

export function pointInRect(cx: number, cy: number, rect: RectLike): boolean {
  return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h
}

/**
 * Prefer actionable UIA whose bounds contain the OCR centre;
 * else nearest candidate within max(24, min(edge)*0.3).
 */
export function findOcrUiaAnchor<T extends OcrUiaCandidate>(
  ocrCx: number,
  ocrCy: number,
  candidates: readonly T[],
): T | null {
  let nearest: T | null = null
  let bestDist = Number.POSITIVE_INFINITY
  for (const cand of candidates) {
    if (pointInRect(ocrCx, ocrCy, cand)) return cand
    const dist = distancePointToRect(ocrCx, ocrCy, cand)
    const thresh = ocrUiaNeighborThreshold(cand.w, cand.h)
    if (dist <= thresh && dist < bestDist) {
      bestDist = dist
      nearest = cand
    }
  }
  return nearest
}

export function parseAnnotatedSource(raw: string | undefined): AnnotatedSource {
  if (raw === 'OCR') return 'OCR'
  if (raw === 'OCR_UIA') return 'OCR_UIA'
  return 'UIA'
}

/** OCR_UIA is natively actionable (anchored UIA); pure OCR text is not. */
export function isUiaElementCandidate(element: {
  name?: string
  automationId?: string
  className?: string
  controlType?: string
  source?: string
  patterns?: string[]
} | null | undefined): boolean {
  if (!element) return false
  if (element.source === 'OCR' || (element.controlType || '').startsWith('OCR')) return false
  if (element.source === 'OCR_UIA') {
    return Boolean(element.name || element.automationId || element.className || (element.patterns && element.patterns.length > 0))
  }
  return Boolean(element.name || element.automationId || element.className)
}

/** Prefer GetClickablePoint when ok; fall back to rect centre. */
export function preferClickablePoint(
  clickable: { x: number; y: number; ok?: boolean } | null | undefined,
  rectCenter: { x: number; y: number },
): { x: number; y: number } {
  if (
    clickable &&
    clickable.ok !== false &&
    Number.isFinite(clickable.x) &&
    Number.isFinite(clickable.y)
  ) {
    return { x: clickable.x, y: clickable.y }
  }
  return { x: rectCenter.x, y: rectCenter.y }
}
