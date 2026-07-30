import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import { type Kysely, sql } from 'kysely'

import { normalizeDatabaseError } from './errors.js'

export interface AdvisoryLockOptions {
  readonly timeoutMs?: number
  readonly retryIntervalMs?: number
  readonly signal?: AbortSignal
}

export class AdvisoryLockTimeoutError extends Error {
  readonly lockName: string
  readonly timeoutMs: number

  constructor(lockName: string, timeoutMs: number) {
    super(`Timed out acquiring advisory lock "${lockName}"`)

    this.name = 'AdvisoryLockTimeoutError'
    this.lockName = lockName
    this.timeoutMs = timeoutMs
  }
}

export async function withRepositoryAdvisoryLock<Database, Result>(
  database: Kysely<Database>,
  lockName: string,
  callback: (connection: Kysely<Database>) => Promise<Result>,
  options: AdvisoryLockOptions = {},
): Promise<Result> {
  const timeoutMs = options.timeoutMs ?? 5_000
  const retryIntervalMs = options.retryIntervalMs ?? 100

  if (lockName.trim().length === 0) {
    throw new TypeError('Advisory lock name must not be empty')
  }

  if (timeoutMs <= 0) {
    throw new RangeError('Advisory lock timeout must be positive')
  }

  if (retryIntervalMs <= 0) {
    throw new RangeError('Advisory lock retry interval must be positive')
  }

  const [key1, key2] = createLockKeys(`shipgate:repository:${lockName}`)

  return database.connection().execute(async (connection) => {
    await acquireLock(connection, {
      key1,
      key2,
      lockName,
      timeoutMs,
      retryIntervalMs,
      signal: options.signal,
    })

    let outcome:
      | {
          readonly type: 'success'
          readonly value: Result
        }
      | {
          readonly type: 'failure'
          readonly error: unknown
        }

    try {
      outcome = {
        type: 'success',
        value: await callback(connection),
      }
    } catch (error) {
      outcome = {
        type: 'failure',
        error,
      }
    }

    try {
      await releaseLock(connection, key1, key2)
    } catch (releaseError) {
      /*
       * Если callback уже упал, сохраняем
       * исходную ошибку. PostgreSQL освободит
       * session lock при разрыве соединения.
       */
      if (outcome.type === 'success') {
        throw releaseError
      }
    }

    if (outcome.type === 'failure') {
      throw outcome.error
    }

    return outcome.value
  })
}

interface AcquireLockOptions {
  readonly key1: number
  readonly key2: number
  readonly lockName: string
  readonly timeoutMs: number
  readonly retryIntervalMs: number
  readonly signal: AbortSignal | undefined
}

async function acquireLock<Database>(
  connection: Kysely<Database>,
  options: AcquireLockOptions,
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs

  while (true) {
    throwIfAborted(options.signal)

    try {
      const result = await sql<{ readonly acquired: boolean }>`
        select pg_try_advisory_lock(
          ${options.key1},
          ${options.key2}
        ) as acquired
      `.execute(connection)

      if (result.rows[0]?.acquired === true) {
        return
      }
    } catch (error) {
      throw normalizeDatabaseError(error, `advisory-lock.acquire:${options.lockName}`)
    }

    const remainingMs = deadline - Date.now()

    if (remainingMs <= 0) {
      throw new AdvisoryLockTimeoutError(options.lockName, options.timeoutMs)
    }

    const waitMs = Math.min(options.retryIntervalMs, remainingMs)

    if (options.signal) {
      await delay(waitMs, undefined, {
        signal: options.signal,
      })
    } else {
      await delay(waitMs)
    }
  }
}

async function releaseLock<Database>(
  connection: Kysely<Database>,
  key1: number,
  key2: number,
): Promise<void> {
  try {
    const result = await sql<{ readonly released: boolean }>`
      select pg_advisory_unlock(
        ${key1},
        ${key2}
      ) as released
    `.execute(connection)

    if (result.rows[0]?.released !== true) {
      throw new Error('PostgreSQL reported that the advisory lock was not held')
    }
  } catch (error) {
    throw normalizeDatabaseError(error, 'advisory-lock.release')
  }
}

function createLockKeys(value: string): readonly [number, number] {
  const digest = createHash('sha256').update(value).digest()

  return [digest.readInt32BE(0), digest.readInt32BE(4)]
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return
  }

  if (signal.reason instanceof Error) {
    throw signal.reason
  }

  throw new Error('Advisory lock acquisition was aborted')
}
