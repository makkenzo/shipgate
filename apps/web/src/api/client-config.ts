// biome-ignore lint/suspicious/noImportCycles: Hey API runtimeConfigPath requires this generated type-only back-reference; it is erased at runtime.
import type { CreateClientConfig } from './generated/client.gen'

/*
 * The generated client defaults to the current origin.
 *
 * Development:
 * browser -> Vite -> Fastify proxy
 *
 * Production:
 * browser -> Fastify directly
 *
 * Keeping the origin fixed also prevents browser credentials or CSRF headers
 * from being sent to a build-time-configured third-party endpoint.
 */
export const createClientConfig: CreateClientConfig = (config) => ({
  ...config,
  baseUrl: '/',
  credentials: 'same-origin',
})
