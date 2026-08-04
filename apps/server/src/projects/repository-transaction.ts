import type { DatabaseClient, DatabaseSchema } from '@shipgate/database'
import {
  type AdvisoryLockOptions,
  withRepositoryAdvisoryLock,
  withTransaction,
} from '@shipgate/database'
import { type Kysely, sql, type Transaction } from 'kysely'

import type { GitHubNumericId } from './model.js'

const repositoryLockBrand: unique symbol = Symbol('repositoryLockBrand')
const repositoryTransactionBrand: unique symbol = Symbol('repositoryTransactionBrand')

export interface RepositoryLock {
  readonly repositoryId: string
  readonly connection: Kysely<DatabaseSchema>
  readonly [repositoryLockBrand]: true
}

export interface RepositoryTransaction {
  readonly repositoryId: string
  readonly transaction: Transaction<DatabaseSchema>
  readonly [repositoryTransactionBrand]: true
}

/**
 * Holds the repository-scoped PostgreSQL session advisory lock without keeping
 * a database transaction open while GitHub and Git are queried.
 */
export async function withRepositoryLock<Result>(
  database: DatabaseClient,
  repositoryId: GitHubNumericId,
  callback: (scope: RepositoryLock) => Promise<Result>,
  options: AdvisoryLockOptions = {},
): Promise<Result> {
  const serializedRepositoryId = serializeGitHubNumericId(repositoryId, 'repository ID')

  return withRepositoryAdvisoryLock(
    database.kysely,
    serializedRepositoryId,
    (connection) =>
      callback({
        repositoryId: serializedRepositoryId,
        connection,
        [repositoryLockBrand]: true,
      }),
    options,
  )
}

/**
 * Opens a short serializable repository transaction on a connection that
 * already owns the repository advisory lock.
 */
export async function withRepositoryTransactionInLock<Result>(
  lock: RepositoryLock,
  callback: (scope: RepositoryTransaction) => Promise<Result>,
): Promise<Result> {
  assertRepositoryLock(lock, lock.repositoryId)

  return withTransaction(
    lock.connection,
    async (transaction) => {
      await sql`
        select
          set_config('shipgate.repository_id', ${lock.repositoryId}, true),
          set_config('shipgate.repository_lock', 'held', true)
      `.execute(transaction)

      return callback({
        repositoryId: lock.repositoryId,
        transaction,
        [repositoryTransactionBrand]: true,
      })
    },
    {
      isolationLevel: 'serializable',
      accessMode: 'read write',
      operation: `projects.repository-transaction:${lock.repositoryId}`,
    },
  )
}

export async function withRepositoryTransaction<Result>(
  database: DatabaseClient,
  repositoryId: GitHubNumericId,
  callback: (scope: RepositoryTransaction) => Promise<Result>,
  options: AdvisoryLockOptions = {},
): Promise<Result> {
  return withRepositoryLock(
    database,
    repositoryId,
    (lock) => withRepositoryTransactionInLock(lock, callback),
    options,
  )
}

export function assertRepositoryLock(scope: RepositoryLock, repositoryId: GitHubNumericId): string {
  const serializedRepositoryId = serializeGitHubNumericId(repositoryId, 'repository ID')

  if (scope.repositoryId !== serializedRepositoryId || scope[repositoryLockBrand] !== true) {
    throw new TypeError(
      [
        `Repository lock scope mismatch: locked ${scope.repositoryId},`,
        `received ${serializedRepositoryId}`,
      ].join(' '),
    )
  }

  return serializedRepositoryId
}

export function assertRepositoryTransaction(
  scope: RepositoryTransaction,
  repositoryId: GitHubNumericId,
): string {
  const serializedRepositoryId = serializeGitHubNumericId(repositoryId, 'repository ID')

  if (scope.repositoryId !== serializedRepositoryId || scope[repositoryTransactionBrand] !== true) {
    throw new TypeError(
      [
        `Repository transaction scope mismatch: locked ${scope.repositoryId},`,
        `received ${serializedRepositoryId}`,
      ].join(' '),
    )
  }

  return serializedRepositoryId
}

export function serializeGitHubNumericId(value: GitHubNumericId, name: string): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`)
    }

    return String(value)
  }

  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new TypeError(`${name} must be a positive decimal GitHub numeric ID`)
  }

  return value
}
