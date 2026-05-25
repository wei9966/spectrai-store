import { createMacOSAccessibilityProvider, type MacOSAccessibilityProvider } from './provider.js'
import { createMacOSCoreProvider, type MacOSCoreProviderOptions, type MacOSProviderContractSource } from './contract-adapter.js'
import type { MacOSCoreProviderContract } from './schema.js'

export interface MacOSCoreBridgeOptions extends Omit<MacOSCoreProviderOptions, 'provider'> {
  provider?: MacOSProviderContractSource
  localProvider?: MacOSAccessibilityProvider
}

export function createMacOSCoreBridge(options: MacOSCoreBridgeOptions = {}): MacOSCoreProviderContract {
  const provider = options.provider ?? options.localProvider ?? createMacOSAccessibilityProvider()
  return createMacOSCoreProvider({ provider, readOptions: options.readOptions })
}

export function createMacOSLocalProviderForBridge(): MacOSAccessibilityProvider {
  return createMacOSAccessibilityProvider()
}
