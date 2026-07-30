import type { Generated, Kysely } from 'kysely'
import type { Pool } from 'pg'

import type { DatabaseOperationError } from './errors.js'

export type JsonPrimitive = string | number | boolean | null

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | {
      readonly [key: string]: JsonValue
    }

export interface DatabaseSchema {
  shipgate_job_execution: ShipgateJobExecutionTable

  shipgate_worker_heartbeat: ShipgateWorkerHeartbeatTable
}

export interface DatabasePoolOptions {
  readonly min: number
  readonly max: number
  readonly idleTimeoutMs: number
  readonly connectionTimeoutMs: number
  readonly maxLifetimeSeconds: number
}

export type DatabaseSslMode = 'disable' | 'require' | 'verify-full'

export interface CreateDatabaseOptions {
  readonly connectionString: string
  readonly applicationName: string

  readonly ssl: {
    readonly mode: DatabaseSslMode
    readonly ca?: string
  }

  readonly pool: DatabasePoolOptions

  /**
   * Для CLI и одноразовых тестовых процессов.
   * В API/worker оставляем false.
   */
  readonly allowExitOnIdle?: boolean

  readonly onPoolError: (error: DatabaseOperationError) => void
}

export interface DatabaseClient {
  readonly kysely: Kysely<DatabaseSchema>
  readonly pool: Pool

  destroy(): Promise<void>
}

export type JobExecutionStatus = 'queued' | 'running' | 'retrying' | 'succeeded' | 'failed'

export interface ShipgateJobExecutionTable {
  graphile_job_id: string
  task_identifier: string
  status: JobExecutionStatus
  correlation_id: string
  causation_id: string | null
  payload: JsonValue
  attempts: number
  max_attempts: number
  result: JsonValue | null
  last_error: JsonValue | null
  queued_at: Generated<Date>
  started_at: Date | null
  completed_at: Date | null
  updated_at: Generated<Date>
}

export interface ShipgateWorkerHeartbeatTable {
  worker_id: string
  hostname: string
  pid: number
  app_version: string
  started_at: Date
  heartbeat_at: Date
}
