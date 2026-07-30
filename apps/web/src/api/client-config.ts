// biome-ignore lint/suspicious/noImportCycles: Hey API runtimeConfigPath requires this generated type-only back-reference; it is erased at runtime.
import type { CreateClientConfig } from './generated/client.gen'

export const createClientConfig: CreateClientConfig = (config) => ({
  ...config,

  /*
   * Empty string means current origin.
   *
   * Development:
   * browser -> Vite -> Fastify proxy
   *
   * Production:
   * browser -> Fastify directly
   */
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? '',
})
