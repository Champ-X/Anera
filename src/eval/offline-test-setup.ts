// Vitest setupFiles entry. Keep production configuration out of this module:
// sentinels and transport guards must be installed before it is imported.
import { applyOfflineTestEnvironment, installOfflineProviderGuard } from './offline-test-environment.js'

applyOfflineTestEnvironment(process.env)
installOfflineProviderGuard()
