import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  findOcrUiaAnchor,
  isUiaElementCandidate,
  ocrUiaNeighborThreshold,
  parseAnnotatedSource,
  preferClickablePoint,
} from '../click-accuracy.js'

describe('ocrUiaNeighborThreshold', () => {
  it('uses max(24, min(edge)*0.3)', () => {
    assert.equal(ocrUiaNeighborThreshold(100, 80), 24) // 0.3*80=24
    assert.equal(ocrUiaNeighborThreshold(200, 200), 60) // 0.3*200=60
    assert.equal(ocrUiaNeighborThreshold(10, 10), 24) // floor
  })
})

describe('findOcrUiaAnchor', () => {
  const cand = { x: 100, y: 100, w: 40, h: 20, cx: 120, cy: 110 }

  it('hits when OCR centre is inside bounds', () => {
    const hit = findOcrUiaAnchor(110, 105, [cand])
    assert.equal(hit, cand)
  })

  it('hits when within neighbor distance', () => {
    // thresh = max(24, min(40,20)*0.3)=24; point 8px left of rect
    const hit = findOcrUiaAnchor(92, 110, [cand])
    assert.equal(hit, cand)
  })

  it('misses when beyond neighbor distance', () => {
    const hit = findOcrUiaAnchor(50, 110, [cand]) // ~50px away
    assert.equal(hit, null)
  })

  it('prefers containing candidate over farther neighbor', () => {
    const far = { x: 200, y: 100, w: 40, h: 40, cx: 220, cy: 120 }
    const hit = findOcrUiaAnchor(110, 105, [far, cand])
    assert.equal(hit, cand)
  })
})

describe('parseAnnotatedSource / isUiaElementCandidate', () => {
  it('parses OCR_UIA distinctly', () => {
    assert.equal(parseAnnotatedSource('OCR_UIA'), 'OCR_UIA')
    assert.equal(parseAnnotatedSource('OCR'), 'OCR')
    assert.equal(parseAnnotatedSource('UIA'), 'UIA')
  })

  it('treats OCR_UIA as UIA-clickable, pure OCR as not', () => {
    assert.equal(
      isUiaElementCandidate({
        name: 'Send',
        controlType: 'ControlType.Button',
        source: 'OCR_UIA',
        patterns: ['Invoke'],
      }),
      true,
    )
    assert.equal(
      isUiaElementCandidate({
        name: 'Send',
        controlType: 'OCR.Text',
        source: 'OCR',
      }),
      false,
    )
    assert.equal(
      isUiaElementCandidate({
        name: 'OK',
        controlType: 'ControlType.Button',
        source: 'UIA',
      }),
      true,
    )
  })
})

describe('preferClickablePoint', () => {
  it('prefers GetClickablePoint when ok', () => {
    assert.deepEqual(
      preferClickablePoint({ x: 11, y: 22, ok: true }, { x: 100, y: 200 }),
      { x: 11, y: 22 },
    )
    assert.deepEqual(
      preferClickablePoint({ x: 11, y: 22, ok: false }, { x: 100, y: 200 }),
      { x: 100, y: 200 },
    )
  })
})
