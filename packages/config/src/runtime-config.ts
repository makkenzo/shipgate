import { z } from 'zod'

import { EnvironmentValidationError } from './errors.js'

const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])

const optionalString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().trim().min(1).optional(),
)

const runtimeEnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  APP_VERSION: z.string().trim().min(1).default('0.0.0'),

  LOG_LEVEL: logLevelSchema.default('info'),

  HOST: z.string().trim().min(1).default('0.0.0.0'),

  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),

  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(10_000),

  GITHUB_APP_ID: optionalString,
})

export type RuntimeEnvironment = z.infer<typeof runtimeEnvironmentSchema>['NODE_ENV']

export type LogLevel = z.infer<typeof logLevelSchema>

export interface RuntimeConfig {
  readonly environment: RuntimeEnvironment
  readonly appVersion: string
  readonly logLevel: LogLevel
  readonly shutdownTimeoutMs: number

  readonly api: {
    readonly host: string
    readonly port: number
  }

  readonly github: {
    readonly appId: string | undefined
  }
}

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const result = runtimeEnvironmentSchema.safeParse(environment)

  if (!result.success) {
    throw new EnvironmentValidationError('runtime', result.error)
  }

  return {
    environment: result.data.NODE_ENV,
    appVersion: result.data.APP_VERSION,
    logLevel: result.data.LOG_LEVEL,
    shutdownTimeoutMs: result.data.SHUTDOWN_TIMEOUT_MS,

    api: {
      host: result.data.HOST,
      port: result.data.PORT,
    },

    github: {
      appId: result.data.GITHUB_APP_ID,
    },
  }
}
