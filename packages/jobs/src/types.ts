import type { DatabaseClient, DatabaseSchema, JsonValue } from '@shipgate/database'
import type { Transaction } from 'kysely'
import type { z } from 'zod'

export interface StructuredLogger {
  child(bindings: Readonly<Record<string, unknown>>): StructuredLogger

  debug(bindings: Readonly<Record<string, unknown>>, message: string): void

  info(bindings: Readonly<Record<string, unknown>>, message: string): void

  warn(bindings: Readonly<Record<string, unknown>>, message: string): void

  error(bindings: Readonly<Record<string, unknown>>, message: string): void
}

export interface JobMetadata {
  readonly correlationId: string
  readonly causationId?: string
  readonly enqueuedAt: string
}

export interface JobEnvelope<Data> {
  readonly version: 1
  readonly metadata: JobMetadata
  readonly data: Data
}

export interface JobAttempt {
  readonly id: string
  readonly taskIdentifier: string
  readonly attempt: number
  readonly maxAttempts: number
}

export interface RepositoryInitialSyncExecution {
  readonly requestId: string
  readonly attempt: number
  readonly maxAttempts: number
  readonly correlationId: string
  readonly causationId: string | undefined
  readonly signal: AbortSignal
  readonly logger: StructuredLogger
}

export type RepositoryInitialSyncHandler = (
  execution: RepositoryInitialSyncExecution,
) => Promise<JsonValue | undefined>

export interface RepositoryRequiredChecksSyncExecution {
  readonly projectId: string
  readonly repositoryId: string
  readonly configurationVersion: number
  readonly refreshPolicy: boolean
  readonly commitSha: string | undefined
  readonly reason: string
  readonly deliveryId: string | undefined
  readonly actorGitHubUserId: string | undefined
  readonly attempt: number
  readonly maxAttempts: number
  readonly correlationId: string
  readonly causationId: string | undefined
  readonly signal: AbortSignal
  readonly logger: StructuredLogger
}

export type RepositoryRequiredChecksSyncHandler = (
  execution: RepositoryRequiredChecksSyncExecution,
) => Promise<JsonValue | undefined>

export interface GitHubWebhookProjectionExecution {
  readonly transaction: Transaction<DatabaseSchema>
  readonly deliveryId: string
  readonly event: string
  readonly action: string | null
  readonly installationId: string | null
  readonly repositoryId: string | null
  readonly payload: JsonValue
  readonly correlationId: string
  readonly causationId: string | undefined
}

export type GitHubWebhookProjectionHandler = (
  execution: GitHubWebhookProjectionExecution,
) => Promise<void>

export interface JobTaskContext {
  readonly database: DatabaseClient
  readonly logger: StructuredLogger
  readonly job: JobAttempt
  readonly correlationId: string
  readonly causationId: string | undefined
  readonly signal: AbortSignal
  readonly repositoryInitialSync: RepositoryInitialSyncHandler | undefined
  readonly repositoryRequiredChecksSync: RepositoryRequiredChecksSyncHandler | undefined
  readonly githubWebhookProjection: GitHubWebhookProjectionHandler | undefined
}

export interface JobTaskDependencies {
  readonly database: DatabaseClient
  readonly logger: StructuredLogger
  readonly repositoryInitialSync?: RepositoryInitialSyncHandler
  readonly repositoryRequiredChecksSync?: RepositoryRequiredChecksSyncHandler
  readonly githubWebhookProjection?: GitHubWebhookProjectionHandler
}

export interface JobRetryPolicy {
  readonly maxAttempts: number
}

export interface JobTaskDefinition<Schema extends z.ZodTypeAny> {
  readonly dataSchema: Schema
  readonly retry: JobRetryPolicy

  execute(payload: z.output<Schema>, context: JobTaskContext): Promise<JsonValue | undefined>
}
