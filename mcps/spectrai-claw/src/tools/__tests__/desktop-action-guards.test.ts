import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  activationEvidenceMatches,
  classifyForegroundResult,
  interpretActivatableSelectVerify,
  isActivatableSelectionItem,
  shouldFallbackClickAfterUia,
} from '../desktop-action-guards.js'

describe('isActivatableSelectionItem', () => {
  it('matches ListItem / TreeItem / TabItem / MenuItem', () => {
    assert.equal(isActivatableSelectionItem({ controlType: 'ControlType.ListItem' }), true)
    assert.equal(isActivatableSelectionItem({ controlType: 'TreeItem' }), true)
    assert.equal(isActivatableSelectionItem({ controlType: 'TabItem' }), true)
    assert.equal(isActivatableSelectionItem({ controlType: 'MenuItem' }), true)
    assert.equal(isActivatableSelectionItem({ controlType: 'Button', automationId: 'ok_btn' }), false)
  })
})

describe('interpretActivatableSelectVerify / shouldFallbackClickAfterUia', () => {
  it('Select without activation evidence → not ok / needs_fallback_click', () => {
    const interpreted = interpretActivatableSelectVerify({
      activatedAfter: false,
    })
    assert.equal(interpreted.ok, false)
    assert.equal(interpreted.verify, 'state_not_changed')
    assert.equal(interpreted.reason, 'needs_fallback_click')
    assert.equal(
      shouldFallbackClickAfterUia(
        { ok: false, verify: 'state_not_changed', reason: 'needs_fallback_click' },
        true,
      ),
      true,
    )
  })

  it('activation evidence → verified / no fallback', () => {
    const interpreted = interpretActivatableSelectVerify({
      activatedAfter: true,
    })
    assert.equal(interpreted.ok, true)
    assert.equal(interpreted.verify, 'verified')
    assert.equal(
      shouldFallbackClickAfterUia({ ok: true, verify: 'verified' }, true),
      false,
    )
  })
})

describe('activationEvidenceMatches', () => {
  it('matches title contain / title change / local state', () => {
    assert.equal(
      activationEvidenceMatches({
        targetName: 'Project Alpha',
        beforeTitle: 'Mail',
        afterTitle: 'Project Alpha — Mail',
      }),
      true,
    )
    assert.equal(
      activationEvidenceMatches({
        targetName: 'Project Alpha',
        beforeTitle: 'Inbox',
        afterTitle: 'Inbox',
        foregroundTitle: 'Project Alpha',
      }),
      true,
    )
    assert.equal(
      activationEvidenceMatches({
        targetName: 'Project Alpha',
        beforeTitle: 'Inbox',
        afterTitle: 'Drafts',
      }),
      true,
    )
    assert.equal(
      activationEvidenceMatches({
        targetName: 'Project Alpha',
        beforeTitle: 'Inbox',
        afterTitle: 'Inbox',
        localStateChanged: true,
      }),
      true,
    )
    assert.equal(
      activationEvidenceMatches({
        targetName: 'Project Alpha',
        beforeTitle: 'Inbox',
        afterTitle: 'Inbox',
        foregroundTitle: 'Inbox',
      }),
      false,
    )
  })
})

describe('classifyForegroundResult', () => {
  it('ok only when target is foreground, visible, not minimized', () => {
    assert.deepEqual(
      classifyForegroundResult({
        targetHwnd: 10,
        foregroundHwnd: 10,
        visible: true,
        iconic: false,
      }),
      { ok: true, reason: '' },
    )
  })

  it('returns target_occluded when SpectrAI covers target', () => {
    assert.deepEqual(
      classifyForegroundResult({
        targetHwnd: 10,
        foregroundHwnd: 99,
        visible: true,
        iconic: false,
        foregroundTitle: 'SpectrAI — workspace',
      }),
      { ok: false, reason: 'target_occluded' },
    )
  })

  it('returns focus_failed when not foreground', () => {
    assert.equal(
      classifyForegroundResult({
        targetHwnd: 10,
        foregroundHwnd: 11,
        visible: true,
        iconic: false,
        foregroundTitle: 'Notepad',
      }).reason,
      'focus_failed:not_foreground',
    )
  })
})
