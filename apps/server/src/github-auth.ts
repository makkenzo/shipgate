import type { GitHubSecrets, RuntimeConfig } from '@shipgate/config'
import type { DatabaseClient } from '@shipgate/database'
import {
  createAes256GcmGitHubTokenCipher,
  createGitHubAuthenticationService,
  GitHubAuthenticationError,
  type GitHubAuthenticationService,
  type GitHubClientLogger,
} from '@shipgate/github'
import type { Logger } from 'pino'

import { createDatabaseGitHubUserTokenStore } from './github-user-token-store.js'

export function createApplicationGitHubAuthentication(options: {
  readonly runtimeConfig: RuntimeConfig
  readonly githubSecrets: GitHubSecrets
  readonly database: DatabaseClient
  readonly logger: Logger
}): GitHubAuthenticationService {
  const { githubApp } = options.runtimeConfig
  const { githubSecrets } = options

  const userTokenStore = createDatabaseGitHubUserTokenStore(options.database)
  const missingConfiguration = [
    ...(githubApp.appId === undefined ? ['GITHUB_APP_ID'] : []),
    ...(githubApp.clientId === undefined ? ['GITHUB_APP_CLIENT_ID'] : []),
    ...(githubSecrets.privateKey === undefined ? ['GITHUB_APP_PRIVATE_KEY'] : []),
    ...(githubSecrets.clientSecret === undefined ? ['GITHUB_APP_CLIENT_SECRET'] : []),
    ...(githubSecrets.tokenEncryptionKey === undefined ? ['GITHUB_TOKEN_ENCRYPTION_KEY'] : []),
  ]

  if (missingConfiguration.length > 0) {
    return createUnavailableGitHubAuthenticationService(missingConfiguration, userTokenStore.delete)
  }

  const appId = requireGitHubConfiguration(githubApp.appId, 'GITHUB_APP_ID')
  const clientId = requireGitHubConfiguration(githubApp.clientId, 'GITHUB_APP_CLIENT_ID')
  const clientSecret = requireGitHubConfiguration(
    githubSecrets.clientSecret,
    'GITHUB_APP_CLIENT_SECRET',
  )
  const privateKey = requireGitHubConfiguration(githubSecrets.privateKey, 'GITHUB_APP_PRIVATE_KEY')
  const tokenEncryptionKey = requireGitHubConfiguration(
    githubSecrets.tokenEncryptionKey,
    'GITHUB_TOKEN_ENCRYPTION_KEY',
  )

  const createService = () =>
    createGitHubAuthenticationService({
      appId,
      clientId,
      clientSecret,
      privateKey,
      apiBaseUrl: githubApp.apiUrl,
      oauthBaseUrl: githubApp.oauthUrl,
      apiVersion: githubApp.apiVersion,
      requestTimeoutMs: githubApp.requestTimeoutMs,
      tokenEarlyRefreshMs: githubApp.tokenEarlyRefreshMs,
      refreshLeaseMs: githubApp.refreshLeaseMs,
      refreshLeasePollMs: githubApp.refreshLeasePollMs,
      userAgent: `shipgate/${options.runtimeConfig.appVersion}`,
      tokenCipher: createAes256GcmGitHubTokenCipher({
        key: tokenEncryptionKey,
        keyId: githubApp.tokenEncryptionKeyId,
      }),
      userTokenStore,
      logger: createOctokitLogger(options.logger),
    })

  return createLazyGitHubAuthenticationService(createService)
}

function requireGitHubConfiguration<Value>(
  value: Value | undefined,
  environmentName: string,
): Value {
  if (value === undefined) {
    throw new GitHubAuthenticationError(
      `GitHub authentication is not configured: ${environmentName}`,
    )
  }

  return value
}

function createUnavailableGitHubAuthenticationService(
  missingConfiguration: readonly string[],
  deleteUserAuthorization: (userId: number) => Promise<void>,
): GitHubAuthenticationService {
  const createError = () =>
    new GitHubAuthenticationError(
      `GitHub authentication is not configured: ${missingConfiguration.join(', ')}`,
    )

  return {
    async getAppClient() {
      throw createError()
    },

    async getInstallationClient() {
      throw createError()
    },

    async getUserClient() {
      throw createError()
    },

    async authorizeUser() {
      throw createError()
    },

    invalidateInstallation() {},
    invalidateUser() {},
    revokeUser: deleteUserAuthorization,
  }
}

function createLazyGitHubAuthenticationService(
  factory: () => GitHubAuthenticationService,
): GitHubAuthenticationService {
  let service: GitHubAuthenticationService | undefined
  const getService = () => (service ??= factory())

  return {
    getAppClient: () => getService().getAppClient(),
    getInstallationClient: (input) => getService().getInstallationClient(input),
    getUserClient: (userId) => getService().getUserClient(userId),
    authorizeUser: (input) => getService().authorizeUser(input),
    invalidateInstallation: (installationId) => getService().invalidateInstallation(installationId),
    invalidateUser: (userId) => getService().invalidateUser(userId),
    revokeUser: (userId) => getService().revokeUser(userId),
  }
}

function createOctokitLogger(logger: Logger): GitHubClientLogger {
  return {
    debug(message) {
      logger.debug({ event: 'github.client.log' }, message)
    },

    info(message) {
      logger.info({ event: 'github.client.log' }, message)
    },

    warn(message) {
      logger.warn({ event: 'github.client.log' }, message)
    },

    error(message) {
      logger.error({ event: 'github.client.log' }, message)
    },
  }
}
