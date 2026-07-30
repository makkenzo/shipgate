import { z } from 'zod'

import { EnvironmentValidationError } from './errors.js'

const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])

const databaseSslModeSchema = z.enum(['disable', 'require', 'verify-full'])

const optionalString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().trim().min(1).optional(),
)

const optionalBooleanEnvironmentSchema = z.preprocess(
  (value) => {
    if (value === '' || value === undefined) {
      return undefined
    }

    return value
  },
  z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
)

const corsOriginsEnvironmentSchema = z
  .string()
  .default(
    [
      'http://localhost:3000',
      'http://localhost:5173',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:5173',
    ].join(','),
  )

const runtimeEnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    APP_VERSION: z.string().trim().min(1).default('0.0.0'),

    LOG_LEVEL: logLevelSchema.default('info'),

    HOST: z.string().trim().min(1).default('0.0.0.0'),

    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),

    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(10_000),

    DATABASE_POOL_MIN: z.coerce.number().int().min(0).max(100).default(0),

    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),

    DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),

    DATABASE_MAX_LIFETIME_SECONDS: z.coerce.number().int().min(0).default(300),

    DATABASE_READINESS_TIMEOUT_MS: z.coerce.number().int().min(100).default(2_000),

    DATABASE_SSL_MODE: databaseSslModeSchema.default('disable'),

    GITHUB_APP_ID: optionalString,

    JOB_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),

    JOB_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(2_000),

    JOB_WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).default(10_000),

    JOB_WORKER_HEARTBEAT_STALE_AFTER_MS: z.coerce.number().int().min(5_000).default(60_000),

    API_BODY_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(10 * 1_024 * 1_024)
      .default(64 * 1_024),

    API_DOCS_ENABLED: optionalBooleanEnvironmentSchema,

    API_CORS_ORIGINS: corsOriginsEnvironmentSchema,
  })
  .superRefine((environment, context) => {
    if (
      environment.JOB_WORKER_HEARTBEAT_STALE_AFTER_MS <
      environment.JOB_WORKER_HEARTBEAT_INTERVAL_MS * 2
    ) {
      context.addIssue({
        code: 'custom',
        path: ['JOB_WORKER_HEARTBEAT_STALE_AFTER_MS'],
        message:
          'JOB_WORKER_HEARTBEAT_STALE_AFTER_MS must be at least twice JOB_WORKER_HEARTBEAT_INTERVAL_MS',
      })
    }

    if (environment.DATABASE_POOL_MIN > environment.DATABASE_POOL_MAX) {
      context.addIssue({
        code: 'custom',
        path: ['DATABASE_POOL_MIN'],
        message: 'DATABASE_POOL_MIN must not exceed DATABASE_POOL_MAX',
      })
    }
  })

export type RuntimeEnvironment = z.infer<typeof runtimeEnvironmentSchema>['NODE_ENV']

export type LogLevel = z.infer<typeof logLevelSchema>

export type DatabaseSslMode = z.infer<typeof databaseSslModeSchema>

export interface RuntimeConfig {
  readonly environment: RuntimeEnvironment
  readonly appVersion: string
  readonly logLevel: LogLevel
  readonly shutdownTimeoutMs: number

  readonly api: {
    readonly host: string
    readonly port: number
    readonly bodyLimitBytes: number
    readonly docsEnabled: boolean
    readonly corsOrigins: readonly string[]
  }

  readonly database: {
    readonly poolMin: number
    readonly poolMax: number
    readonly idleTimeoutMs: number
    readonly connectionTimeoutMs: number
    readonly maxLifetimeSeconds: number
    readonly readinessTimeoutMs: number
    readonly sslMode: DatabaseSslMode
  }

  readonly github: {
    readonly appId: string | undefined
  }

  readonly jobs: {
    readonly concurrency: number
    readonly pollIntervalMs: number
    readonly heartbeatIntervalMs: number
    readonly heartbeatStaleAfterMs: number
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

      bodyLimitBytes: result.data.API_BODY_LIMIT_BYTES,

      docsEnabled: result.data.API_DOCS_ENABLED ?? result.data.NODE_ENV === 'development',

      corsOrigins: parseCommaSeparatedValues(result.data.API_CORS_ORIGINS),
    },

    database: {
      poolMin: result.data.DATABASE_POOL_MIN,
      poolMax: result.data.DATABASE_POOL_MAX,
      idleTimeoutMs: result.data.DATABASE_IDLE_TIMEOUT_MS,
      connectionTimeoutMs: result.data.DATABASE_CONNECTION_TIMEOUT_MS,
      maxLifetimeSeconds: result.data.DATABASE_MAX_LIFETIME_SECONDS,
      readinessTimeoutMs: result.data.DATABASE_READINESS_TIMEOUT_MS,
      sslMode: result.data.DATABASE_SSL_MODE,
    },

    github: {
      appId: result.data.GITHUB_APP_ID,
    },

    jobs: {
      concurrency: result.data.JOB_WORKER_CONCURRENCY,
      pollIntervalMs: result.data.JOB_WORKER_POLL_INTERVAL_MS,
      heartbeatIntervalMs: result.data.JOB_WORKER_HEARTBEAT_INTERVAL_MS,
      heartbeatStaleAfterMs: result.data.JOB_WORKER_HEARTBEAT_STALE_AFTER_MS,
    },
  }
}

function parseCommaSeparatedValues(value: string): readonly string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}
