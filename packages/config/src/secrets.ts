import { z } from 'zod'

import { EnvironmentValidationError } from './errors.js'

const optionalSecret = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().trim().min(1).optional(),
)

const databaseUrlSchema = z
  .url()
  .refine((value) => value.startsWith('postgres://') || value.startsWith('postgresql://'), {
    message: 'DATABASE_URL must use postgres:// or postgresql://',
  })

const secretsEnvironmentSchema = z.object({
  DATABASE_URL: databaseUrlSchema,

  DATABASE_SSL_CA: optionalSecret,

  GITHUB_PRIVATE_KEY: optionalSecret,

  GITHUB_WEBHOOK_SECRET: optionalSecret,
})

export interface Secrets {
  readonly databaseUrl: string
  readonly databaseSslCa: string | undefined
  readonly githubPrivateKey: string | undefined
  readonly githubWebhookSecret: string | undefined
}

export function loadSecrets(environment: NodeJS.ProcessEnv = process.env): Secrets {
  const result = secretsEnvironmentSchema.safeParse(environment)

  if (!result.success) {
    throw new EnvironmentValidationError('secrets', result.error)
  }

  return {
    databaseUrl: result.data.DATABASE_URL,
    databaseSslCa: result.data.DATABASE_SSL_CA,
    githubPrivateKey: result.data.GITHUB_PRIVATE_KEY,
    githubWebhookSecret: result.data.GITHUB_WEBHOOK_SECRET,
  }
}
