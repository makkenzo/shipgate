import { z } from 'zod'

import { EnvironmentValidationError } from './errors.js'

const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])

const databaseSslModeSchema = z.enum(['disable', 'require', 'verify-full'])

const optionalNonEmptyStringEnvironmentSchema = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  z.string().trim().min(1).optional(),
)

const optionalPositiveIntegerEnvironmentSchema = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  z.coerce.number().int().positive().safe().optional(),
)

const optionalHttpsOriginEnvironmentSchema = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  z
    .string()
    .trim()
    .refine(isHttpsOrigin, {
      message: 'Expected an exact HTTPS origin without a path',
    })
    .optional(),
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
  .transform((value, context) => {
    const origins = parseCommaSeparatedValues(value)

    for (const origin of origins) {
      if (!isHttpOrigin(origin)) {
        context.addIssue({
          code: 'custom',
          message: `Invalid HTTP origin: ${origin}`,
        })

        return z.NEVER
      }
    }

    return origins
  })

const githubRuntimeEnvironmentShape = {
  APP_ORIGIN: optionalHttpsOriginEnvironmentSchema,
  GITHUB_APP_ID: optionalPositiveIntegerEnvironmentSchema,
  GITHUB_APP_CLIENT_ID: optionalNonEmptyStringEnvironmentSchema,
  GITHUB_APP_USER_TOKENS_EXPIRE: optionalBooleanEnvironmentSchema,
  GITHUB_API_URL: z
    .string()
    .trim()
    .refine(isHttpOrigin, {
      message: 'GITHUB_API_URL must be an exact HTTP origin',
    })
    .default('https://api.github.com'),
  GITHUB_OAUTH_URL: z
    .string()
    .trim()
    .refine(isHttpOrigin, {
      message: 'GITHUB_OAUTH_URL must be an exact HTTP origin',
    })
    .default('https://github.com'),
  GITHUB_API_VERSION: z.string().trim().min(1).default('2026-03-10'),
  GITHUB_API_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
  GITHUB_TOKEN_EARLY_REFRESH_MS: z.coerce.number().int().min(1_000).default(300_000),
  GITHUB_REFRESH_LEASE_MS: z.coerce.number().int().min(1_000).default(60_000),
  GITHUB_REFRESH_LEASE_POLL_MS: z.coerce.number().int().min(25).default(100),
  GITHUB_TOKEN_ENCRYPTION_KEY_ID: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{1,64}$/, {
      message: 'GITHUB_TOKEN_ENCRYPTION_KEY_ID contains unsupported characters',
    })
    .default('primary'),
}

const githubRuntimeEnvironmentSchema = z
  .object(githubRuntimeEnvironmentShape)
  .superRefine((environment, context) => {
    if (environment.GITHUB_REFRESH_LEASE_MS < environment.GITHUB_API_REQUEST_TIMEOUT_MS * 3) {
      context.addIssue({
        code: 'custom',
        path: ['GITHUB_REFRESH_LEASE_MS'],
        message:
          'GITHUB_REFRESH_LEASE_MS must be at least three times GITHUB_API_REQUEST_TIMEOUT_MS',
      })
    }

    if (environment.GITHUB_REFRESH_LEASE_POLL_MS >= environment.GITHUB_REFRESH_LEASE_MS) {
      context.addIssue({
        code: 'custom',
        path: ['GITHUB_REFRESH_LEASE_POLL_MS'],
        message: 'GITHUB_REFRESH_LEASE_POLL_MS must be less than GITHUB_REFRESH_LEASE_MS',
      })
    }
  })

const runtimeEnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    APP_VERSION: z.string().trim().min(1).default('0.0.0'),

    LOG_LEVEL: logLevelSchema.default('info'),

    HOST: z.string().trim().min(1).default('0.0.0.0'),

    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),

    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(10_000),

    ...githubRuntimeEnvironmentShape,

    GITHUB_APP_STARTUP_VALIDATION_ENABLED: optionalBooleanEnvironmentSchema,

    DATABASE_POOL_MIN: z.coerce.number().int().min(0).max(100).default(0),

    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),

    DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),

    DATABASE_MAX_LIFETIME_SECONDS: z.coerce.number().int().min(0).default(300),

    DATABASE_READINESS_TIMEOUT_MS: z.coerce.number().int().min(100).default(2_000),

    DATABASE_SSL_MODE: databaseSslModeSchema.default('disable'),

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

    API_DIAGNOSTICS_ENABLED: optionalBooleanEnvironmentSchema,

    API_METRICS_ENABLED: optionalBooleanEnvironmentSchema,

    API_CORS_ORIGINS: corsOriginsEnvironmentSchema,

    AUTH_SESSION_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(300)
      .max(30 * 24 * 60 * 60)
      .default(7 * 24 * 60 * 60),

    AUTH_OAUTH_ATTEMPT_TTL_SECONDS: z.coerce.number().int().min(60).max(1800).default(600),
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

    if (environment.GITHUB_REFRESH_LEASE_MS < environment.GITHUB_API_REQUEST_TIMEOUT_MS * 3) {
      context.addIssue({
        code: 'custom',
        path: ['GITHUB_REFRESH_LEASE_MS'],
        message:
          'GITHUB_REFRESH_LEASE_MS must be at least three times GITHUB_API_REQUEST_TIMEOUT_MS',
      })
    }

    if (environment.GITHUB_REFRESH_LEASE_POLL_MS >= environment.GITHUB_REFRESH_LEASE_MS) {
      context.addIssue({
        code: 'custom',
        path: ['GITHUB_REFRESH_LEASE_POLL_MS'],
        message: 'GITHUB_REFRESH_LEASE_POLL_MS must be less than GITHUB_REFRESH_LEASE_MS',
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

export interface GitHubRuntimeConfig {
  readonly appOrigin: string | undefined
  readonly appId: number | undefined
  readonly clientId: string | undefined
  readonly userTokensExpire: boolean | undefined
  readonly apiUrl: string
  readonly oauthUrl: string
  readonly apiVersion: string
  readonly requestTimeoutMs: number
  readonly tokenEarlyRefreshMs: number
  readonly refreshLeaseMs: number
  readonly refreshLeasePollMs: number
  readonly tokenEncryptionKeyId: string
}

export interface RuntimeConfig {
  readonly environment: RuntimeEnvironment
  readonly appVersion: string
  readonly logLevel: LogLevel
  readonly shutdownTimeoutMs: number
  readonly appOrigin: string | undefined

  readonly githubApp: {
    readonly startupValidationEnabled: boolean
    readonly appId: number | undefined
    readonly clientId: string | undefined
    readonly userTokensExpire: boolean | undefined
    readonly apiUrl: string
    readonly oauthUrl: string
    readonly apiVersion: string
    readonly requestTimeoutMs: number
    readonly tokenEarlyRefreshMs: number
    readonly refreshLeaseMs: number
    readonly refreshLeasePollMs: number
    readonly tokenEncryptionKeyId: string
  }

  readonly api: {
    readonly host: string
    readonly port: number
    readonly bodyLimitBytes: number
    readonly docsEnabled: boolean
    readonly diagnosticsEnabled: boolean
    readonly metricsEnabled: boolean
    readonly corsOrigins: readonly string[]
  }

  readonly auth: {
    readonly sessionTtlSeconds: number
    readonly oauthAttemptTtlSeconds: number
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

  readonly jobs: {
    readonly concurrency: number
    readonly pollIntervalMs: number
    readonly heartbeatIntervalMs: number
    readonly heartbeatStaleAfterMs: number
  }
}

export function loadGitHubRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): GitHubRuntimeConfig {
  const result = githubRuntimeEnvironmentSchema.safeParse(environment)

  if (!result.success) {
    throw new EnvironmentValidationError('runtime', result.error)
  }

  return {
    appOrigin: result.data.APP_ORIGIN,
    appId: result.data.GITHUB_APP_ID,
    clientId: result.data.GITHUB_APP_CLIENT_ID,
    userTokensExpire: result.data.GITHUB_APP_USER_TOKENS_EXPIRE,
    apiUrl: result.data.GITHUB_API_URL,
    oauthUrl: result.data.GITHUB_OAUTH_URL,
    apiVersion: result.data.GITHUB_API_VERSION,
    requestTimeoutMs: result.data.GITHUB_API_REQUEST_TIMEOUT_MS,
    tokenEarlyRefreshMs: result.data.GITHUB_TOKEN_EARLY_REFRESH_MS,
    refreshLeaseMs: result.data.GITHUB_REFRESH_LEASE_MS,
    refreshLeasePollMs: result.data.GITHUB_REFRESH_LEASE_POLL_MS,
    tokenEncryptionKeyId: result.data.GITHUB_TOKEN_ENCRYPTION_KEY_ID,
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
    appOrigin: result.data.APP_ORIGIN,

    githubApp: {
      startupValidationEnabled:
        result.data.GITHUB_APP_STARTUP_VALIDATION_ENABLED ?? result.data.NODE_ENV === 'production',

      appId: result.data.GITHUB_APP_ID,
      clientId: result.data.GITHUB_APP_CLIENT_ID,
      userTokensExpire: result.data.GITHUB_APP_USER_TOKENS_EXPIRE,
      apiUrl: result.data.GITHUB_API_URL,
      oauthUrl: result.data.GITHUB_OAUTH_URL,
      apiVersion: result.data.GITHUB_API_VERSION,
      requestTimeoutMs: result.data.GITHUB_API_REQUEST_TIMEOUT_MS,
      tokenEarlyRefreshMs: result.data.GITHUB_TOKEN_EARLY_REFRESH_MS,
      refreshLeaseMs: result.data.GITHUB_REFRESH_LEASE_MS,
      refreshLeasePollMs: result.data.GITHUB_REFRESH_LEASE_POLL_MS,
      tokenEncryptionKeyId: result.data.GITHUB_TOKEN_ENCRYPTION_KEY_ID,
    },

    api: {
      host: result.data.HOST,
      port: result.data.PORT,

      bodyLimitBytes: result.data.API_BODY_LIMIT_BYTES,

      docsEnabled: result.data.API_DOCS_ENABLED ?? result.data.NODE_ENV === 'development',

      diagnosticsEnabled:
        result.data.API_DIAGNOSTICS_ENABLED ?? result.data.NODE_ENV !== 'production',

      metricsEnabled: result.data.API_METRICS_ENABLED ?? result.data.NODE_ENV !== 'production',

      corsOrigins: result.data.API_CORS_ORIGINS,
    },

    auth: {
      sessionTtlSeconds: result.data.AUTH_SESSION_TTL_SECONDS,
      oauthAttemptTtlSeconds: result.data.AUTH_OAUTH_ATTEMPT_TTL_SECONDS,
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

function isHttpsOrigin(value: string): boolean {
  return isHttpOrigin(value, { httpsOnly: true })
}

function isHttpOrigin(value: string, options: { readonly httpsOnly?: boolean } = {}): boolean {
  try {
    const url = new URL(value)

    return (
      (options.httpsOnly
        ? url.protocol === 'https:'
        : url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin === value &&
      url.username === '' &&
      url.password === ''
    )
  } catch {
    return false
  }
}
