import type { Bounds, DetectedElement } from '../../../helpers/ipc/protocol.js'
import type { MacOSAXSelector, MacOSElementNode } from './types.js'

function normalize(text: string | null | undefined): string {
  return (text ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

function textMatches(actual: string | null | undefined, expected: string | undefined): boolean {
  if (!expected) return true
  const a = normalize(actual)
  const e = normalize(expected)
  return a === e || a.includes(e) || e.includes(a)
}

function exactTextMatches(actual: string | null | undefined, expected: string | undefined): boolean {
  if (!expected) return true
  return normalize(actual) === normalize(expected)
}

function pathMatches(actual: number[] | null, expected: number[] | string | undefined): boolean {
  if (expected == null) return true
  if (!actual) return false

  const expectedPath = Array.isArray(expected)
    ? expected
    : expected
        .split(/[./]/g)
        .filter(Boolean)
        .map(part => Number(part))

  if (expectedPath.length !== actual.length) return false
  return expectedPath.every((value, index) => value === actual[index])
}

function boundsMatch(actual: Bounds, expected?: Partial<Bounds> & { tolerance?: number }): boolean {
  if (!expected) return true
  const tolerance = expected.tolerance ?? 8
  const checks: Array<[number | undefined, number]> = [
    [expected.x, actual.x],
    [expected.y, actual.y],
    [expected.width, actual.width],
    [expected.height, actual.height],
  ]
  return checks.every(([want, got]) => want == null || Math.abs(want - got) <= tolerance)
}

export function selectorFromDetectedElement(element: DetectedElement): MacOSAXSelector {
  const selector: MacOSAXSelector = {
    AXRole: element.role,
    role: element.role,
    bounds: element.bounds,
  }

  if (element.identifier) {
    selector.AXIdentifier = element.identifier
    selector.identifier = element.identifier
  }
  if (element.title) selector.AXTitle = element.title
  if (element.description) selector.AXDescription = element.description
  if (element.label) selector.label = element.label
  if (element.axPath) selector.path = element.axPath

  return selector
}

export function toMacOSElementNode(element: DetectedElement): MacOSElementNode {
  return {
    provider: 'macos-ax',
    id: element.id,
    role: element.role,
    subrole: element.subrole,
    label: element.label,
    title: element.title,
    value: element.value,
    description: element.description,
    identifier: element.identifier,
    keyboardShortcut: element.keyboardShortcut,
    bounds: element.bounds,
    enabled: element.isEnabled,
    actionable: element.isActionable,
    parentId: element.parentId,
    path: element.axPath ?? null,
    selector: selectorFromDetectedElement(element),
    children: [],
  }
}

export function buildElementTree(elements: DetectedElement[]): {
  roots: MacOSElementNode[]
  flat: MacOSElementNode[]
} {
  const flat = elements.map(toMacOSElementNode)
  const byId = new Map(flat.map(node => [node.id, node]))
  const roots: MacOSElementNode[] = []

  for (const node of flat) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }

  return { roots, flat }
}

export function flattenElementTree(nodes: MacOSElementNode[]): MacOSElementNode[] {
  const out: MacOSElementNode[] = []
  const visit = (node: MacOSElementNode) => {
    out.push(node)
    for (const child of node.children) visit(child)
  }
  for (const node of nodes) visit(node)
  return out
}

export function elementMatchesSelector(element: MacOSElementNode, selector: MacOSAXSelector): boolean {
  const role = selector.AXRole ?? selector.role
  const identifier = selector.AXIdentifier ?? selector.identifier
  const title = selector.AXTitle ?? selector.title
  const description = selector.AXDescription ?? selector.description

  return (
    exactTextMatches(element.role, role) &&
    exactTextMatches(element.identifier, identifier) &&
    textMatches(element.title, title) &&
    textMatches(element.description, description) &&
    textMatches(element.label, selector.label) &&
    textMatches(element.value, selector.value) &&
    pathMatches(element.path, selector.path) &&
    boundsMatch(element.bounds, selector.bounds)
  )
}

export function findBestElement(
  elements: MacOSElementNode[],
  selector: MacOSAXSelector,
): MacOSElementNode | null {
  const candidates = elements.filter(element => elementMatchesSelector(element, selector))
  if (candidates.length === 0) return null

  return candidates.sort((a, b) => scoreElement(b, selector) - scoreElement(a, selector))[0] ?? null
}

function scoreElement(element: MacOSElementNode, selector: MacOSAXSelector): number {
  let score = 0
  if ((selector.AXIdentifier ?? selector.identifier) && element.identifier) score += 40
  if ((selector.AXTitle ?? selector.title) && element.title) score += 24
  if ((selector.AXDescription ?? selector.description) && element.description) score += 16
  if ((selector.label ?? selector.value) && (element.label || element.value)) score += 12
  if ((selector.AXRole ?? selector.role) && element.role) score += 8
  if (selector.path && element.path) score += 8
  if (selector.bounds && element.bounds.width > 0 && element.bounds.height > 0) score += 4
  if (element.actionable) score += 2
  return score
}
