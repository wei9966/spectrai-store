import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  findOcrUiaAnchor,
  isUiaElementCandidate,
  ocrUiaNeighborThreshold,
  parseAnnotatedSource,
  preferClickablePoint,
  preferLocalSessionOverNetworkSearch,
  scoreSearchAmbiguity,
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

describe('scoreSearchAmbiguity / preferLocalSessionOverNetworkSearch (P3.15)', () => {
  it('ranks same-name local session above network search chrome', () => {
    const local = {
      name: '懵逼三人组',
      className: 'ChatSessionListItem',
      automationId: 'session_row_42',
      controlType: 'ControlType.ListItem',
    }
    const network = {
      name: '懵逼三人组',
      className: 'SearchResultRow',
      automationId: 'search_web_hit_1',
      controlType: 'ControlType.ListItem',
    }
    assert.ok(scoreSearchAmbiguity(local) > scoreSearchAmbiguity(network))
    assert.ok(preferLocalSessionOverNetworkSearch(local, network) < 0)
  })

  it('demotes labels that are themselves network-search chrome', () => {
    assert.ok(scoreSearchAmbiguity({ name: '搜索网络结果' }) < 0)
    assert.ok(scoreSearchAmbiguity({ name: '懵逼三人组 - 搜一搜' }) < 0)
    assert.ok(scoreSearchAmbiguity({ name: 'Search the web' }) < 0)
    assert.ok(scoreSearchAmbiguity({ automationId: 'search_network_panel' }) < 0)
  })

  it('leaves ordinary buttons near neutral', () => {
    assert.equal(scoreSearchAmbiguity({ name: 'OK', controlType: 'ControlType.Button' }), 0)
    assert.equal(
      scoreSearchAmbiguity({
        name: 'Save',
        className: 'Button',
        automationId: 'btnSave',
        controlType: 'ControlType.Button',
      }),
      0,
    )
  })

  it('works from generic class/name cues without WeChat-specific AutomationIds', () => {
    const local = { name: 'Team standup', className: 'ConversationCell' }
    const network = { name: 'Team standup', automationId: 'web_results_item' }
    assert.ok(scoreSearchAmbiguity(local) > 0)
    assert.ok(scoreSearchAmbiguity(network) < 0)
    assert.ok(scoreSearchAmbiguity(local) > scoreSearchAmbiguity(network))
  })
})
