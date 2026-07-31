export interface StoredGitHubUserCredentials {
  readonly userId: number
  readonly version: number
  readonly encryptedAccessToken: string
  readonly accessTokenExpiresAt: Date
  readonly encryptedRefreshToken: string
  readonly refreshTokenExpiresAt: Date
  readonly refreshLeaseId: string | null
  readonly refreshLeaseExpiresAt: Date | null
}

export interface StoredGitHubUserCredentialInput {
  readonly userId: number
  readonly encryptedAccessToken: string
  readonly accessTokenExpiresAt: Date
  readonly encryptedRefreshToken: string
  readonly refreshTokenExpiresAt: Date
}

export type GitHubRefreshLeaseResult = 'acquired' | 'conflict' | 'missing'

export interface GitHubUserTokenStore {
  get(userId: number): Promise<StoredGitHubUserCredentials | undefined>

  upsert(input: StoredGitHubUserCredentialInput): Promise<StoredGitHubUserCredentials>

  tryAcquireRefreshLease(input: {
    readonly userId: number
    readonly expectedVersion: number
    readonly leaseId: string
    readonly leaseExpiresAt: Date
    readonly now: Date
  }): Promise<GitHubRefreshLeaseResult>

  completeRefresh(input: {
    readonly userId: number
    readonly expectedVersion: number
    readonly leaseId: string
    readonly credentials: Omit<StoredGitHubUserCredentialInput, 'userId'>
  }): Promise<StoredGitHubUserCredentials | undefined>

  releaseRefreshLease(input: {
    readonly userId: number
    readonly expectedVersion: number
    readonly leaseId: string
  }): Promise<void>

  delete(userId: number): Promise<void>
}

export function createInMemoryGitHubUserTokenStore(): GitHubUserTokenStore {
  const records = new Map<number, StoredGitHubUserCredentials>()

  return {
    async get(userId) {
      return cloneRecord(records.get(userId))
    },

    async upsert(input) {
      const current = records.get(input.userId)
      const record: StoredGitHubUserCredentials = {
        ...input,
        version: (current?.version ?? 0) + 1,
        refreshLeaseId: null,
        refreshLeaseExpiresAt: null,
      }

      records.set(input.userId, record)

      return cloneRecord(record)!
    },

    async tryAcquireRefreshLease(input) {
      const current = records.get(input.userId)

      if (!current) {
        return 'missing'
      }

      if (
        current.version !== input.expectedVersion ||
        (current.refreshLeaseExpiresAt !== null &&
          current.refreshLeaseExpiresAt.getTime() > input.now.getTime())
      ) {
        return 'conflict'
      }

      records.set(input.userId, {
        ...current,
        refreshLeaseId: input.leaseId,
        refreshLeaseExpiresAt: new Date(input.leaseExpiresAt),
      })

      return 'acquired'
    },

    async completeRefresh(input) {
      const current = records.get(input.userId)

      if (
        !current ||
        current.version !== input.expectedVersion ||
        current.refreshLeaseId !== input.leaseId
      ) {
        return undefined
      }

      const record: StoredGitHubUserCredentials = {
        userId: input.userId,
        version: current.version + 1,
        ...input.credentials,
        refreshLeaseId: null,
        refreshLeaseExpiresAt: null,
      }

      records.set(input.userId, record)

      return cloneRecord(record)
    },

    async releaseRefreshLease(input) {
      const current = records.get(input.userId)

      if (current?.version === input.expectedVersion && current.refreshLeaseId === input.leaseId) {
        records.set(input.userId, {
          ...current,
          refreshLeaseId: null,
          refreshLeaseExpiresAt: null,
        })
      }
    },

    async delete(userId) {
      records.delete(userId)
    },
  }
}

function cloneRecord(
  record: StoredGitHubUserCredentials | undefined,
): StoredGitHubUserCredentials | undefined {
  if (!record) {
    return undefined
  }

  return {
    ...record,
    accessTokenExpiresAt: new Date(record.accessTokenExpiresAt),
    refreshTokenExpiresAt: new Date(record.refreshTokenExpiresAt),
    refreshLeaseExpiresAt:
      record.refreshLeaseExpiresAt === null ? null : new Date(record.refreshLeaseExpiresAt),
  }
}
