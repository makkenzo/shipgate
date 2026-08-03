import type { DatabaseClient, DatabaseSchema } from '@shipgate/database'
import {
  type AdvisoryLockOptions,
  withRepositoryAdvisoryLock,
  withTransaction,
} from '@shipgate/database'
import { type Transaction, sql } from 'kysely'

import type { GitHubNumericId } from './model.js'

const repositoryTransactionBrand: unique symbol = Symbol('repositoryTransactionBrand')

export interface RepositoryTransaction {
  readonly repositoryId: string
  readonly transaction: Transaction<DatabaseSchema>
  readonly [repositoryTransactionBrand]: true
}

export async function withRepositoryTransaction<Result>(
  database: DatabaseClient,
  repositoryId: GitHubNumericId,
  callback: (scope: RepositoryTransaction) => Promise<Result>,
  options: AdvisoryLockOptions = {},
): Promise<Result> {
  const serializedRepositoryId = serializeGitHubNumericId(repositoryId, 'repository ID')

  return withRepositoryAdvisoryLock(
    database.kysely,
    serializedRepositoryId,
    async (connection) =>
      withTransaction(
        connection,
        async (transaction) => {
          await sql`
            select
              set_config('shipgate.repository_id', ${serializedRepositoryId}, true),
              set_config('shipgate.repository_lock', 'held', true)
          `.execute(transaction)

          return callback({
            repositoryId: serializedRepositoryId,
            transaction,
            [repositoryTransactionBrand]: true,
          })
        },
        {
          isolationLevel: 'serializable',
          accessMode: 'read write',
          operation: `projects.repository-transaction:${serializedRepositoryId}`,
        },
      ),
    options,
  )
}

export function assertRepositoryTransaction(
  scope: RepositoryTransaction,
  repositoryId: GitHubNumericId,
): string {
  const serializedRepositoryId = serializeGitHubNumericId(repositoryId, 'repository ID')

  if (scope.repositoryId !== serializedRepositoryId) {
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
