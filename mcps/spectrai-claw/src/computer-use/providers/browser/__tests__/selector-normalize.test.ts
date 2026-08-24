import assert from 'node:assert/strict'
import test from 'node:test'

import { buildFindElementExpression } from '../dom-scripts.js'
import {
  hasResolvedLocatorFields,
  hasSpecificLocatorIntent,
  normalizeBrowserSelector,
} from '../selector-normalize.js'

test('normalizeBrowserSelector maps {type,value} css to flat css', () => {
  assert.deepEqual(normalizeBrowserSelector({ type: 'css', value: "a[href*='x']" }), {
    kind: 'css',
    css: "a[href*='x']",
  })
})

test('normalizeBrowserSelector maps kind/value and aria-label aliases', () => {
  assert.deepEqual(normalizeBrowserSelector({ kind: 'text', value: 'Guide' }), {
    kind: 'text',
    text: 'Guide',
  })
  assert.deepEqual(normalizeBrowserSelector({ type: 'ariaLabel', value: 'Search' }), {
    kind: 'aria-label',
    ariaLabel: 'Search',
  })
  assert.deepEqual(normalizeBrowserSelector({ 'aria-label': 'Search' }), {
    ariaLabel: 'Search',
  })
})

test('normalizeBrowserSelector keeps flat css and listing fields', () => {
  assert.deepEqual(
    normalizeBrowserSelector({
      css: '#q',
      urlIncludes: 'fixture.local',
      visible: true,
      index: 0,
    }),
    {
      css: '#q',
      urlIncludes: 'fixture.local',
      visible: true,
      index: 0,
    },
  )
})

test('hasSpecificLocatorIntent detects unresolved type-only selectors', () => {
  assert.equal(hasSpecificLocatorIntent({ type: 'css' }), true)
  assert.equal(hasResolvedLocatorFields({ type: 'css' }), false)
  assert.equal(hasSpecificLocatorIntent({ visible: true, urlIncludes: 'x' }), false)
  assert.equal(hasResolvedLocatorFields({ css: 'a' }), true)
})

test('dom-scripts defensive path: type/value css embeds as css, not DEFAULT_SELECTOR', () => {
  const expression = buildFindElementExpression({ type: 'css', value: "a[href*='datalearner']" } as never)
  assert.match(expression, /a\[href\*='datalearner'\]/)
  assert.match(expression, /unresolved_locator_intent/)
  assert.match(expression, /normalizeInlineSelector/)
})

test('dom-scripts defensive path: unresolved type-only intent does not fall back to DEFAULT first link', () => {
  const expression = buildFindElementExpression({ type: 'css' } as never)
  assert.match(expression, /unresolved_locator_intent/)
  // The empty-candidates branch must exist before DEFAULT listing semantics.
  assert.match(
    expression,
    /hasSpecificLocatorIntent\(selector\) && !hasResolvedLocatorFields\(selector\)[\s\S]*candidates = \[\];/,
  )
})
