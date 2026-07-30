import type { Kysely, Transaction } from 'kysely'

import { isDatabaseDriverError, normalizeDatabaseError } from './errors.js'

export type TransactionIsolationLevel = 'read committed' | 'repeatable read' | 'serializable'

export type TransactionAccessMode = 'read only' | 'read write'

export interface TransactionOptions {
  readonly isolationLevel?: TransactionIsolationLevel
  readonly accessMode?: TransactionAccessMode
  readonly operation?: string
}

export async function withTransaction<Database, Result>(
  database: Kysely<Database>,
  callback: (transaction: Transaction<Database>) => Promise<Result>,
  options: TransactionOptions = {},
): Promise<Result> {
  let builder = database.transaction()

  if (options.isolationLevel) {
    builder = builder.setIsolationLevel(options.isolationLevel)
  }

  if (options.accessMode) {
    builder = builder.setAccessMode(options.accessMode)
  }

  try {
    return await builder.execute(callback)
  } catch (error) {
    /*
     * Domain/application errors сохраняем как есть.
     * Нормализуем только ошибки PostgreSQL/driver.
     */
    if (isDatabaseDriverError(error)) {
      throw normalizeDatabaseError(error, options.operation ?? 'transaction')
    }

    throw error
  }
}
