import { performance } from 'node:perf_hooks'

import { sql, type Kysely } from 'kysely'

import { normalizeDatabaseError, type DatabaseOperationError } from './errors.js'
import type { DatabaseSchema } from './types.js'

export type DatabaseReadinessResult =
  | {
      readonly ready: true
      readonly latencyMs: number
    }
  | {
      readonly ready: false
      readonly latencyMs: number
      readonly error: DatabaseOperationError
    }

export async function checkDatabaseReadiness(
  database: Kysely<DatabaseSchema>,
  timeoutMs: number,
): Promise<DatabaseReadinessResult> {
  const startedAt = performance.now()

  try {
    await sql<{ readonly ready: number }>`
      select 1 as ready
    `.execute(database, {
      signal: AbortSignal.timeout(timeoutMs),
      inflightQueryAbortStrategy: 'cancel query',
    })

    return {
      ready: true,
      latencyMs: getLatency(startedAt),
    }
  } catch (error) {
    return {
      ready: false,
      latencyMs: getLatency(startedAt),
      error: normalizeDatabaseError(error, 'readiness'),
    }
  }
}

export async function assertDatabaseReady(
  database: Kysely<DatabaseSchema>,
  timeoutMs: number,
): Promise<void> {
  const result = await checkDatabaseReadiness(database, timeoutMs)

  if (!result.ready) {
    throw result.error
  }
}

function getLatency(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100
}
