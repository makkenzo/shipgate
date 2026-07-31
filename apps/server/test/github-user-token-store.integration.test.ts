import { createDatabase, type DatabaseClient, migrateToLatest } from '@shipgate/database'
import { type PostgresTestDatabase, startPostgresTestDatabase } from '@shipgate/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDatabaseGitHubUserTokenStore } from '../src/github-user-token-store.js'

describe.sequential('GitHub user token store', () => {
  let postgres: PostgresTestDatabase
  let database: DatabaseClient

  beforeAll(async () => {
    postgres = await startPostgresTestDatabase()
    database = createDatabase({
      connectionString: postgres.connectionString,
      applicationName: 'shipgate-github-token-store-test',
      ssl: {
        mode: 'disable',
      },
      pool: {
        min: 0,
        max: 4,
        idleTimeoutMs: 5_000,
        connectionTimeoutMs: 5_000,
        maxLifetimeSeconds: 0,
      },
      allowExitOnIdle: true,
      onPoolError: () => undefined,
    })

    await migrateToLatest(database.kysely)
  }, 60_000)

  afterAll(async () => {
    await database.destroy()
    await postgres.stop()
  })

  it('atomically leases and rotates a credential pair', async () => {
    const store = createDatabaseGitHubUserTokenStore(database)
    const now = new Date('2026-07-31T20:00:00.000Z')
    const initial = await store.upsert({
      userId: 42,
      encryptedAccessToken: 'encrypted-access-1',
      accessTokenExpiresAt: new Date(now.getTime() + 60_000),
      encryptedRefreshToken: 'encrypted-refresh-1',
      refreshTokenExpiresAt: new Date(now.getTime() + 86_400_000),
    })

    expect(initial.version).toBe(1)

    await expect(
      Promise.all([
        store.tryAcquireRefreshLease({
          userId: 42,
          expectedVersion: initial.version,
          leaseId: 'lease-a',
          leaseExpiresAt: new Date(now.getTime() + 30_000),
          now,
        }),
        store.tryAcquireRefreshLease({
          userId: 42,
          expectedVersion: initial.version,
          leaseId: 'lease-b',
          leaseExpiresAt: new Date(now.getTime() + 30_000),
          now,
        }),
      ]),
    ).resolves.toEqual(expect.arrayContaining(['acquired', 'conflict']))

    const leased = await store.get(42)
    const leaseId = leased?.refreshLeaseId

    expect(leaseId).toMatch(/^lease-[ab]$/)

    if (!leaseId) {
      throw new Error('Expected a refresh lease ID')
    }

    const rotated = await store.completeRefresh({
      userId: 42,
      expectedVersion: initial.version,
      leaseId,
      credentials: {
        encryptedAccessToken: 'encrypted-access-2',
        accessTokenExpiresAt: new Date(now.getTime() + 120_000),
        encryptedRefreshToken: 'encrypted-refresh-2',
        refreshTokenExpiresAt: new Date(now.getTime() + 172_800_000),
      },
    })

    expect(rotated).toMatchObject({
      userId: 42,
      version: 2,
      encryptedAccessToken: 'encrypted-access-2',
      encryptedRefreshToken: 'encrypted-refresh-2',
      refreshLeaseId: null,
      refreshLeaseExpiresAt: null,
    })

    await expect(
      store.completeRefresh({
        userId: 42,
        expectedVersion: initial.version,
        leaseId,
        credentials: {
          encryptedAccessToken: 'must-not-win',
          accessTokenExpiresAt: new Date(now.getTime() + 120_000),
          encryptedRefreshToken: 'must-not-win',
          refreshTokenExpiresAt: new Date(now.getTime() + 172_800_000),
        },
      }),
    ).resolves.toBeUndefined()
  })
})
