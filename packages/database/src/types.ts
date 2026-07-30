import type { DatabaseSslMode } from '@shipgate/config'
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

export interface ShipgateSystemMetadataTable {
  key: string
  value: JsonValue
  created_at: Generated<Date>
}

export interface DatabaseSchema {
  shipgate_system_metadata: ShipgateSystemMetadataTable
}

export interface DatabasePoolOptions {
  readonly min: number
  readonly max: number
  readonly idleTimeoutMs: number
  readonly connectionTimeoutMs: number
  readonly maxLifetimeSeconds: number
}

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
