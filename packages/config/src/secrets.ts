import { z } from 'zod'

import { EnvironmentValidationError } from './errors.js'

const databaseUrlSchema = z
  .url()
  .refine((value) => value.startsWith('postgres://') || value.startsWith('postgresql://'), {
    message: 'DATABASE_URL must use postgres:// or postgresql://',
  })

const optionalSecretSchema = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  z.string().min(1).optional(),
)

const secretsEnvironmentSchema = z.object({
  DATABASE_URL: databaseUrlSchema,

  DATABASE_SSL_CA: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().trim().min(1).optional(),
  ),
})

const githubSecretsEnvironmentSchema = z.object({
  GITHUB_APP_PRIVATE_KEY: optionalSecretSchema,
  GITHUB_APP_CLIENT_SECRET: optionalSecretSchema,
  GITHUB_APP_WEBHOOK_SECRET: optionalSecretSchema,
  GITHUB_TOKEN_ENCRYPTION_KEY: optionalSecretSchema,
})

export interface Secrets {
  readonly databaseUrl: string
  readonly databaseSslCa: string | undefined
}

export interface GitHubSecrets {
  readonly privateKey: string | undefined
  readonly clientSecret: string | undefined
  readonly webhookSecret: string | undefined
  readonly tokenEncryptionKey: string | undefined
}

export function loadSecrets(environment: NodeJS.ProcessEnv = process.env): Secrets {
  const result = secretsEnvironmentSchema.safeParse(environment)

  if (!result.success) {
    throw new EnvironmentValidationError('secrets', result.error)
  }

  return {
    databaseUrl: result.data.DATABASE_URL,
    databaseSslCa: result.data.DATABASE_SSL_CA,
  }
}

/**
 * GitHub secrets are intentionally optional at the parsing layer so
 * `github:doctor` can report each missing value with a targeted diagnostic.
 */
export function loadGitHubSecrets(environment: NodeJS.ProcessEnv = process.env): GitHubSecrets {
  const result = githubSecretsEnvironmentSchema.safeParse(environment)

  if (!result.success) {
    throw new EnvironmentValidationError('secrets', result.error)
  }

  return {
    privateKey: result.data.GITHUB_APP_PRIVATE_KEY,
    clientSecret: result.data.GITHUB_APP_CLIENT_SECRET,
    webhookSecret: result.data.GITHUB_APP_WEBHOOK_SECRET,
    tokenEncryptionKey: result.data.GITHUB_TOKEN_ENCRYPTION_KEY,
  }
}
