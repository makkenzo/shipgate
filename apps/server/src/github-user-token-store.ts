import type { DatabaseClient } from '@shipgate/database'
import type {
  GitHubRefreshLeaseResult,
  GitHubUserTokenStore,
  StoredGitHubUserCredentialInput,
  StoredGitHubUserCredentials,
} from '@shipgate/github'
import { sql } from 'kysely'

export function createDatabaseGitHubUserTokenStore(database: DatabaseClient): GitHubUserTokenStore {
  return {
    async get(userId) {
      const row = await database.kysely
        .selectFrom('shipgate_github_user_credential')
        .selectAll()
        .where('github_user_id', '=', serializeUserId(userId))
        .executeTakeFirst()

      return row ? mapCredential(row) : undefined
    },

    async upsert(input) {
      const row = await database.kysely
        .insertInto('shipgate_github_user_credential')
        .values(toInsertValues(input))
        .onConflict((conflict) =>
          conflict.column('github_user_id').doUpdateSet({
            version: sql<number>`shipgate_github_user_credential.version + 1`,
            encrypted_access_token: input.encryptedAccessToken,
            access_token_expires_at: input.accessTokenExpiresAt,
            encrypted_refresh_token: input.encryptedRefreshToken,
            refresh_token_expires_at: input.refreshTokenExpiresAt,
            refresh_lease_id: null,
            refresh_lease_expires_at: null,
            updated_at: sql`now()`,
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow()

      return mapCredential(row)
    },

    async tryAcquireRefreshLease(input) {
      const acquired = await database.kysely
        .updateTable('shipgate_github_user_credential')
        .set({
          refresh_lease_id: input.leaseId,
          refresh_lease_expires_at: input.leaseExpiresAt,
          updated_at: sql`now()`,
        })
        .where('github_user_id', '=', serializeUserId(input.userId))
        .where('version', '=', input.expectedVersion)
        .where((expression) =>
          expression.or([
            expression('refresh_lease_expires_at', 'is', null),
            expression('refresh_lease_expires_at', '<=', input.now),
          ]),
        )
        .returning('github_user_id')
        .executeTakeFirst()

      if (acquired) {
        return 'acquired'
      }

      const existing = await database.kysely
        .selectFrom('shipgate_github_user_credential')
        .select('github_user_id')
        .where('github_user_id', '=', serializeUserId(input.userId))
        .executeTakeFirst()

      return (existing ? 'conflict' : 'missing') satisfies GitHubRefreshLeaseResult
    },

    async completeRefresh(input) {
      const row = await database.kysely
        .updateTable('shipgate_github_user_credential')
        .set({
          version: sql<number>`version + 1`,
          encrypted_access_token: input.credentials.encryptedAccessToken,
          access_token_expires_at: input.credentials.accessTokenExpiresAt,
          encrypted_refresh_token: input.credentials.encryptedRefreshToken,
          refresh_token_expires_at: input.credentials.refreshTokenExpiresAt,
          refresh_lease_id: null,
          refresh_lease_expires_at: null,
          updated_at: sql`now()`,
        })
        .where('github_user_id', '=', serializeUserId(input.userId))
        .where('version', '=', input.expectedVersion)
        .where('refresh_lease_id', '=', input.leaseId)
        .returningAll()
        .executeTakeFirst()

      return row ? mapCredential(row) : undefined
    },

    async releaseRefreshLease(input) {
      await database.kysely
        .updateTable('shipgate_github_user_credential')
        .set({
          refresh_lease_id: null,
          refresh_lease_expires_at: null,
          updated_at: sql`now()`,
        })
        .where('github_user_id', '=', serializeUserId(input.userId))
        .where('version', '=', input.expectedVersion)
        .where('refresh_lease_id', '=', input.leaseId)
        .execute()
    },

    async delete(userId) {
      await database.kysely
        .deleteFrom('shipgate_github_user_credential')
        .where('github_user_id', '=', serializeUserId(userId))
        .execute()
    },
  }
}

function toInsertValues(input: StoredGitHubUserCredentialInput) {
  return {
    github_user_id: serializeUserId(input.userId),
    encrypted_access_token: input.encryptedAccessToken,
    access_token_expires_at: input.accessTokenExpiresAt,
    encrypted_refresh_token: input.encryptedRefreshToken,
    refresh_token_expires_at: input.refreshTokenExpiresAt,
    refresh_lease_id: null,
    refresh_lease_expires_at: null,
  }
}

function mapCredential(row: {
  readonly github_user_id: string
  readonly version: number
  readonly encrypted_access_token: string
  readonly access_token_expires_at: Date
  readonly encrypted_refresh_token: string
  readonly refresh_token_expires_at: Date
  readonly refresh_lease_id: string | null
  readonly refresh_lease_expires_at: Date | null
}): StoredGitHubUserCredentials {
  const userId = Number(row.github_user_id)

  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error(`Stored GitHub user ID is invalid: ${row.github_user_id}`)
  }

  return {
    userId,
    version: row.version,
    encryptedAccessToken: row.encrypted_access_token,
    accessTokenExpiresAt: row.access_token_expires_at,
    encryptedRefreshToken: row.encrypted_refresh_token,
    refreshTokenExpiresAt: row.refresh_token_expires_at,
    refreshLeaseId: row.refresh_lease_id,
    refreshLeaseExpiresAt: row.refresh_lease_expires_at,
  }
}

function serializeUserId(userId: number): string {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new TypeError('GitHub user ID must be a positive safe integer')
  }

  return String(userId)
}
