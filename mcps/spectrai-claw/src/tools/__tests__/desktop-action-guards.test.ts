import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  chatOpenMatches,
  classifyForegroundResult,
  interpretSessionSelectVerify,
  isSessionListItem,
  shouldFallbackClickAfterUia,
} from '../desktop-action-guards.js'

describe('isSessionListItem', () => {
  it('matches ListItem and session_item_*', () => {
    assert.equal(isSessionListItem({ controlType: 'ControlType.ListItem' }), true)
    assert.equal(isSessionListItem({ automationId: 'session_item_12' }), true)
    assert.equal(isSessionListItem({ controlType: 'Button', automationId: 'chat_input_field' }), false)
  })
})

describe('interpretSessionSelectVerify / shouldFallbackClickAfterUia', () => {
  it('Select + IsSelected but title unchanged → not ok / needs_fallback_click', () => {
    const interpreted = interpretSessionSelectVerify({
      selectedAfter: true,
      openedAfter: false,
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

  it('opened chat title → verified / no fallback', () => {
    const interpreted = interpretSessionSelectVerify({
      selectedAfter: true,
      openedAfter: true,
    })
    assert.equal(interpreted.ok, true)
    assert.equal(interpreted.verify, 'verified')
    assert.equal(
      shouldFallbackClickAfterUia({ ok: true, verify: 'verified' }, true),
      false,
    )
  })
})

describe('chatOpenMatches', () => {
  it('matches window title or current_chat_name_label', () => {
    assert.equal(
      chatOpenMatches({ windowTitle: '懵逼三人组-下一站翻身', chatName: '' }, '懵逼三人组-下一站翻身'),
      true,
    )
    assert.equal(
      chatOpenMatches({ windowTitle: '微信', chatName: '懵逼三人组-下一站翻身' }, '懵逼三人组-下一站翻身'),
      true,
    )
    assert.equal(
      chatOpenMatches({ windowTitle: '文件传输助手', chatName: '文件传输助手' }, '懵逼三人组-下一站翻身'),
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
