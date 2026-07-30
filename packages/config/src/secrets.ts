import { z } from 'zod'

import { EnvironmentValidationError } from './errors.js'

const optionalSecret = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().trim().min(1).optional(),
)

const secretsEnvironmentSchema = z.object({
  DATABASE_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().url().optional(),
  ),

  GITHUB_PRIVATE_KEY: optionalSecret,

  GITHUB_WEBHOOK_SECRET: optionalSecret,
})

export interface Secrets {
  readonly databaseUrl: string | undefined
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
    githubPrivateKey: result.data.GITHUB_PRIVATE_KEY,
    githubWebhookSecret: result.data.GITHUB_WEBHOOK_SECRET,
  }
}
