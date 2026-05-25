import type { ProviderRouteCandidate } from '../registry.js'
import {
  CanonicalReportSchema,
  type ActionResult,
  type AppState,
  type AppTarget,
  type CanonicalReport,
  type CapabilityReport,
  type ComputerUseAction,
  type VerificationResult,
} from '../types.js'

export function routeToReportSteps(candidates: ProviderRouteCandidate[]): CanonicalReport['route'] {
  return candidates.map((candidate) => ({
    providerId: candidate.provider.id,
    providerKind: candidate.provider.kind,
    priority: candidate.priority,
    reason: candidate.reason,
  }))
}

export function fallbackProviderIds(candidates: ProviderRouteCandidate[]): string[] {
  return candidates
    .filter((candidate) => candidate.fallback)
    .map((candidate) => candidate.provider.id)
}

export function canonicalSuccess(args: {
  phase: CanonicalReport['phase']
  providerId?: string
  providerKind?: CanonicalReport['providerKind']
  action?: ComputerUseAction
  target?: AppTarget
  result?: ActionResult
  state?: AppState
  capabilities?: CapabilityReport[]
  verification?: VerificationResult
  route?: CanonicalReport['route']
  warnings?: string[]
}): CanonicalReport {
  return CanonicalReportSchema.parse({
    ok: true,
    status: 'success',
    phase: args.phase,
    providerId: args.providerId,
    providerKind: args.providerKind,
    action: args.action,
    target: args.target,
    result: args.result,
    state: args.state,
    capabilities: args.capabilities ?? [],
    verification: args.verification,
    route: args.route ?? [],
    fallbackSuggested: false,
    fallbackProviders: [],
    warnings: args.warnings ?? [],
  })
}

export function canonicalFailure(args: {
  phase: CanonicalReport['phase']
  code: string
  message: string
  providerId?: string
  providerKind?: CanonicalReport['providerKind']
  action?: ComputerUseAction
  target?: AppTarget
  result?: ActionResult
  state?: AppState
  capabilities?: CapabilityReport[]
  verification?: VerificationResult
  route?: CanonicalReport['route']
  fallbackSuggested?: boolean
  fallbackProviders?: string[]
  warnings?: string[]
  details?: Record<string, unknown>
}): CanonicalReport {
  return CanonicalReportSchema.parse({
    ok: false,
    status: 'failure',
    phase: args.phase,
    providerId: args.providerId,
    providerKind: args.providerKind,
    action: args.action,
    target: args.target,
    result: args.result,
    state: args.state,
    capabilities: args.capabilities ?? [],
    verification: args.verification,
    route: args.route ?? [],
    fallbackSuggested: args.fallbackSuggested ?? false,
    fallbackProviders: args.fallbackProviders ?? [],
    error: {
      code: args.code,
      message: args.message,
      details: args.details,
    },
    warnings: args.warnings ?? [],
  })
}

export function actionFailureResult(args: {
  action: ComputerUseAction
  providerId?: string
  providerKind?: ActionResult['providerKind']
  code: string
  message: string
  fallbackSuggested?: boolean
  fallbackReason?: string
  verification?: VerificationResult
  details?: Record<string, unknown>
  warnings?: string[]
}): ActionResult {
  return {
    ok: false,
    actionId: args.action.id,
    actionType: args.action.type,
    providerId: args.providerId,
    providerKind: args.providerKind,
    fallbackSuggested: args.fallbackSuggested,
    fallbackReason: args.fallbackReason,
    verification: args.verification,
    error: {
      code: args.code,
      message: args.message,
      details: args.details,
    },
    warnings: args.warnings ?? [],
  }
}
