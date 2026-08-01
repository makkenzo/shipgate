import { randomUUID } from 'node:crypto'

import type { DatabaseClient } from '@shipgate/database'

import { createOpaqueToken, hashOpaqueToken } from './crypto.js'
import {
  type AuthenticatedSession,
  type GitHubUserIdentity,
  parseInstallations,
  serializeInstallations,
} from './model.js'

export interface OAuthAttempt {
  readonly id: string
  readonly pkceVerifier: string
  readonly returnTo: string
}

export interface CreatedSession {
  readonly sessionToken: string
  readonly csrfToken: string
  readonly session: AuthenticatedSession
}

export async function createOAuthAttempt(input: {
  readonly database: DatabaseClient
  readonly state: string
  readonly pkceVerifier: string
  readonly returnTo: string
  readonly expiresAt: Date
}): Promise<void> {
  await input.database.kysely.transaction().execute(async (transaction) => {
    await transaction.deleteFrom('oauth_attempts').where('expires_at', '<=', new Date()).execute()

    await transaction
      .insertInto('oauth_attempts')
      .values({
        id: randomUUID(),
        state_hash: hashOpaqueToken(input.state),
        pkce_verifier: input.pkceVerifier,
        return_to: input.returnTo,
        expires_at: input.expiresAt,
        consumed_at: null,
      })
      .execute()
  })
}

export async function consumeOAuthAttempt(input: {
  readonly database: DatabaseClient
  readonly state: string
  readonly now?: Date
}): Promise<OAuthAttempt | undefined> {
  const now = input.now ?? new Date()
  const row = await input.database.kysely
    .updateTable('oauth_attempts')
    .set({
      consumed_at: now,
    })
    .where('state_hash', '=', hashOpaqueToken(input.state))
    .where('consumed_at', 'is', null)
    .where('expires_at', '>', now)
    .returning(['id', 'pkce_verifier', 'return_to'])
    .executeTakeFirst()

  if (!row) {
    return undefined
  }

  return {
    id: row.id,
    pkceVerifier: row.pkce_verifier,
    returnTo: row.return_to,
  }
}

export async function createLoginSession(input: {
  readonly database: DatabaseClient
  readonly user: GitHubUserIdentity
  readonly expiresAt: Date
  readonly previousSessionToken?: string
  readonly userAgent?: string
}): Promise<CreatedSession> {
  const sessionToken = createOpaqueToken()
  const csrfToken = createOpaqueToken()
  const sessionId = randomUUID()
  const now = new Date()

  await input.database.kysely.transaction().execute(async (transaction) => {
    await transaction
      .insertInto('github_users')
      .values({
        github_user_id: serializeGitHubUserId(input.user.githubUserId),
        login: input.user.login,
        avatar_url: input.user.avatarUrl,
        display_name: input.user.displayName,
        email: input.user.email,
        html_url: input.user.htmlUrl,
        installations: serializeInstallations(input.user.installations),
        installations_synced_at: now,
      })
      .onConflict((conflict) =>
        conflict.column('github_user_id').doUpdateSet({
          login: input.user.login,
          avatar_url: input.user.avatarUrl,
          display_name: input.user.displayName,
          email: input.user.email,
          html_url: input.user.htmlUrl,
          installations: serializeInstallations(input.user.installations),
          installations_synced_at: now,
          updated_at: now,
        }),
      )
      .execute()

    if (input.previousSessionToken) {
      await transaction
        .updateTable('sessions')
        .set({
          revoked_at: now,
          revocation_reason: 'rotated_after_login',
        })
        .where('token_hash', '=', hashOpaqueToken(input.previousSessionToken))
        .where('revoked_at', 'is', null)
        .execute()
    }

    await transaction
      .insertInto('sessions')
      .values({
        id: sessionId,
        github_user_id: serializeGitHubUserId(input.user.githubUserId),
        token_hash: hashOpaqueToken(sessionToken),
        csrf_token_hash: hashOpaqueToken(csrfToken),
        expires_at: input.expiresAt,
        revoked_at: null,
        revocation_reason: null,
        last_seen_at: now,
        user_agent: input.userAgent ?? null,
      })
      .execute()
  })

  return {
    sessionToken,
    csrfToken,
    session: {
      id: sessionId,
      githubUserId: input.user.githubUserId,
      csrfTokenHash: hashOpaqueToken(csrfToken),
      expiresAt: input.expiresAt,
      user: input.user,
    },
  }
}

export async function findActiveSession(
  database: DatabaseClient,
  sessionToken: string,
): Promise<AuthenticatedSession | undefined> {
  const now = new Date()
  const row = await database.kysely
    .selectFrom('sessions')
    .innerJoin(
      'github_user_credentials',
      'github_user_credentials.github_user_id',
      'sessions.github_user_id',
    )
    .innerJoin('github_users', 'github_users.github_user_id', 'sessions.github_user_id')
    .select([
      'sessions.id',
      'sessions.github_user_id',
      'sessions.csrf_token_hash',
      'sessions.expires_at',
      'sessions.last_seen_at',
      'github_users.login',
      'github_users.avatar_url',
      'github_users.display_name',
      'github_users.email',
      'github_users.html_url',
      'github_users.installations',
    ])
    .where('sessions.token_hash', '=', hashOpaqueToken(sessionToken))
    .where('sessions.revoked_at', 'is', null)
    .where('sessions.expires_at', '>', now)
    .executeTakeFirst()

  if (!row) {
    return undefined
  }

  if (row.last_seen_at.getTime() <= now.getTime() - 5 * 60_000) {
    await database.kysely
      .updateTable('sessions')
      .set({
        last_seen_at: now,
      })
      .where('id', '=', row.id)
      .where('last_seen_at', '=', row.last_seen_at)
      .execute()
  }

  const githubUserId = parseGitHubUserId(row.github_user_id)

  return {
    id: row.id,
    githubUserId,
    csrfTokenHash: row.csrf_token_hash,
    expiresAt: row.expires_at,
    user: {
      githubUserId,
      login: row.login,
      avatarUrl: row.avatar_url,
      displayName: row.display_name,
      email: row.email,
      htmlUrl: row.html_url,
      installations: parseInstallations(row.installations),
    },
  }
}

export async function revokeSession(
  database: DatabaseClient,
  sessionId: string,
  reason: string,
): Promise<void> {
  await database.kysely
    .updateTable('sessions')
    .set({
      revoked_at: new Date(),
      revocation_reason: reason,
    })
    .where('id', '=', sessionId)
    .where('revoked_at', 'is', null)
    .execute()
}

export async function revokeUserSessions(
  database: DatabaseClient,
  githubUserId: number,
  reason: string,
): Promise<void> {
  await database.kysely
    .updateTable('sessions')
    .set({
      revoked_at: new Date(),
      revocation_reason: reason,
    })
    .where('github_user_id', '=', serializeGitHubUserId(githubUserId))
    .where('revoked_at', 'is', null)
    .execute()
}

export async function purgeExpiredAuthRecords(database: DatabaseClient): Promise<void> {
  const now = new Date()

  await database.kysely.transaction().execute(async (transaction) => {
    await transaction
      .deleteFrom('oauth_attempts')
      .where((expression) =>
        expression.or([
          expression('expires_at', '<=', now),
          expression('consumed_at', 'is not', null),
        ]),
      )
      .execute()

    await transaction
      .deleteFrom('sessions')
      .where((expression) =>
        expression.or([
          expression('expires_at', '<=', now),
          expression('revoked_at', 'is not', null),
        ]),
      )
      .execute()
  })
}

export function serializeGitHubUserId(userId: number): string {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new TypeError('GitHub user ID must be a positive safe integer')
  }

  return String(userId)
}

function parseGitHubUserId(value: string): number {
  const userId = Number(value)

  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error(`Stored GitHub user ID is invalid: ${value}`)
  }

  return userId
}
