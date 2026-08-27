import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { EventEmitter } from 'node:events'
import {
  formatPresenceCommand,
  isPresenceEnabled,
  presenceHide,
  presenceMark,
  presenceStop,
  resetPresenceOverlayForTests,
  sanitizeLabel,
} from '../presence-overlay.js'

class FakeStdin extends EventEmitter {
  destroyed = false
  chunks: string[] = []
  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }
  end(): void {
    this.destroyed = true
  }
}

class FakeChild extends EventEmitter {
  stdin = new FakeStdin()
  killed = false
  exitCode: number | null = null
  unref(): void {}
  kill(): boolean {
    this.killed = true
    this.exitCode = 1
    this.emit('exit', 1)
    return true
  }
}

afterEach(() => {
  resetPresenceOverlayForTests()
})

describe('presence overlay command formatting', () => {
  it('formats MARK with rounded coords and label', () => {
    assert.equal(formatPresenceCommand('click', 100.6, 200.2), 'MARK 101 200 click')
  })

  it('formats BADGE when coords missing', () => {
    assert.equal(formatPresenceCommand('type'), 'BADGE type')
    assert.equal(formatPresenceCommand('hotkey', undefined, 10), 'BADGE hotkey')
  })

  it('strips newlines and truncates label', () => {
    const long = 'a'.repeat(100)
    assert.equal(sanitizeLabel('hello\r\nworld'), 'hello world')
    assert.equal(sanitizeLabel(long).length, 80)
  })
})

describe('presence overlay env / platform gates', () => {
  it('is disabled when CLAW_PRESENCE=0', () => {
    assert.equal(isPresenceEnabled({ CLAW_PRESENCE: '0' }, 'win32'), false)
  })

  it('is disabled off win32', () => {
    assert.equal(isPresenceEnabled({}, 'darwin'), false)
    assert.equal(isPresenceEnabled({}, 'linux'), false)
  })

  it('is enabled on win32 by default', () => {
    assert.equal(isPresenceEnabled({}, 'win32'), true)
  })

  it('no-ops when CLAW_PRESENCE=0 and never spawns', () => {
    let spawned = 0
    presenceMark('click', 1, 2, {
      platform: 'win32',
      env: { CLAW_PRESENCE: '0' },
      spawn: (() => {
        spawned += 1
        throw new Error('should not spawn')
      }) as typeof import('child_process').spawn,
    })
    assert.equal(spawned, 0)
  })
})

describe('presence overlay spawn failures stay silent', () => {
  it('does not throw when spawn throws', () => {
    assert.doesNotThrow(() => {
      presenceMark('click', 10, 20, {
        platform: 'win32',
        env: {},
        spawn: (() => {
          throw new Error('spawn boom')
        }) as typeof import('child_process').spawn,
      })
    })
  })

  it('writes MARK then HIDE then QUIT on a live child', () => {
    const fake = new FakeChild()
    presenceMark('click', 12, 34, {
      platform: 'win32',
      env: {},
      spawn: (() => fake) as unknown as typeof import('child_process').spawn,
    })
    presenceHide({ platform: 'win32', env: {} })
    presenceStop()
    assert.deepEqual(fake.stdin.chunks, ['MARK 12 34 click\n', 'HIDE\n', 'QUIT\n'])
    assert.equal(fake.killed, true)
  })
})
