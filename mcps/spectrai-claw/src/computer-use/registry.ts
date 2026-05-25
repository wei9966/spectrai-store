import type { ComputerUseProvider } from './core/provider.js'
import {
  ComputerUseActionSchema,
  actionToCapability,
  isFallbackProviderKind,
  type AppTarget,
  type CapabilityReport,
  type ComputerUseAction,
  type ComputerUseActionInput,
  type ComputerUseProviderKind,
} from './types.js'

export const PROVIDER_KIND_PRIORITY: Record<ComputerUseProviderKind, number> = {
  browser: 500,
  'os-accessibility': 400,
  'app-bridge': 300,
  'vision-ocr': 200,
  hid: 100,
  mock: 0,
}

export interface ProviderRouteCandidate {
  provider: ComputerUseProvider
  capability: CapabilityReport
  priority: number
  fallback: boolean
  reason: string
}

export interface ProviderRouteOptions {
  target?: AppTarget
  preferredProviderIds?: string[]
  includeProviderIds?: string[]
  excludeProviderIds?: string[]
  includeKinds?: ComputerUseProviderKind[]
  excludeKinds?: ComputerUseProviderKind[]
  allowFallback?: boolean
  requireBackground?: boolean
}

function getActionTarget(action: ComputerUseAction): AppTarget | undefined {
  if ('target' in action && action.target?.app) {
    return action.target.app
  }

  return action.app
}

function supportsBackground(capability: CapabilityReport, action: ComputerUseAction): boolean {
  if (action.type === 'readState') {
    return capability.backgroundRead
  }

  if (action.type === 'setValue' || action.type === 'typeText') {
    return capability.backgroundType
  }

  return capability.backgroundInvoke
}

function describeCandidate(capability: CapabilityReport, fallback: boolean): string {
  const mode = fallback ? 'fallback' : 'primary'
  const bg = capability.requiresForeground ? 'foreground-required' : 'background-capable'
  return `${mode}:${capability.providerKind}:${bg}`
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ComputerUseProvider>()

  register(provider: ComputerUseProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Computer use provider already registered: ${provider.id}`)
    }

    this.providers.set(provider.id, provider)
  }

  unregister(providerId: string): boolean {
    return this.providers.delete(providerId)
  }

  get(providerId: string): ComputerUseProvider | undefined {
    return this.providers.get(providerId)
  }

  list(): ComputerUseProvider[] {
    return Array.from(this.providers.values()).sort((a, b) => this.effectivePriority(b) - this.effectivePriority(a))
  }

  listFallbackProviders(): ComputerUseProvider[] {
    return this.list().filter((provider) => isFallbackProviderKind(provider.kind))
  }

  async capabilityReport(target?: AppTarget): Promise<CapabilityReport[]> {
    const reports = await Promise.all(
      this.list().map(async (provider) => provider.getCapabilities(target)),
    )

    return reports.sort((a, b) => b.priority - a.priority)
  }

  async route(actionInput: ComputerUseActionInput, options: ProviderRouteOptions = {}): Promise<ProviderRouteCandidate[]> {
    const action = ComputerUseActionSchema.parse(actionInput)
    const target = options.target ?? getActionTarget(action)
    const allowFallback = options.allowFallback ?? true
    const actionKind = actionToCapability(action)
    const preferred = new Set(options.preferredProviderIds ?? [])
    const includeProviderIds = options.includeProviderIds ? new Set(options.includeProviderIds) : null
    const excludeProviderIds = new Set(options.excludeProviderIds ?? [])
    const includeKinds = options.includeKinds ? new Set(options.includeKinds) : null
    const excludeKinds = new Set(options.excludeKinds ?? [])

    const candidates: ProviderRouteCandidate[] = []

    for (const provider of this.list()) {
      if (includeProviderIds && !includeProviderIds.has(provider.id)) continue
      if (excludeProviderIds.has(provider.id)) continue
      if (includeKinds && !includeKinds.has(provider.kind)) continue
      if (excludeKinds.has(provider.kind)) continue

      const fallback = isFallbackProviderKind(provider.kind)
      if (fallback && !allowFallback) continue

      const capability = await provider.getCapabilities(target)
      if (!capability.supportedActions.includes(actionKind)) continue
      if (options.requireBackground && !supportsBackground(capability, action)) continue

      const preferredBoost = preferred.has(provider.id) ? 10_000 : 0
      const priority = this.effectivePriority(provider, capability) + preferredBoost

      candidates.push({
        provider,
        capability,
        priority,
        fallback,
        reason: describeCandidate(capability, fallback),
      })
    }

    return candidates.sort((a, b) => b.priority - a.priority)
  }

  private effectivePriority(provider: ComputerUseProvider, capability?: CapabilityReport): number {
    const kindPriority = PROVIDER_KIND_PRIORITY[provider.kind]
    const explicit = capability?.priority ?? provider.priority ?? 0
    return kindPriority + explicit
  }
}

export const defaultProviderRegistry = new ProviderRegistry()
