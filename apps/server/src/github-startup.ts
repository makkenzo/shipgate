import { assertGitHubAppRegistration, type GitHubAppValidationReport } from '@shipgate/github'

import type { ApplicationContext } from './application-context.js'

export async function validateGitHubAppAtStartup(
  context: ApplicationContext,
): Promise<GitHubAppValidationReport | undefined> {
  if (!context.runtimeConfig.githubApp.startupValidationEnabled) {
    context.logger.info(
      {
        event: 'github.app.validation.skipped',
      },
      'GitHub App startup validation is disabled',
    )

    return undefined
  }

  const report = await assertGitHubAppRegistration({
    appOrigin: context.runtimeConfig.appOrigin,
    appId: context.runtimeConfig.githubApp.appId,
    clientId: context.runtimeConfig.githubApp.clientId,
    privateKey: context.githubSecrets.privateKey,
    clientSecret: context.githubSecrets.clientSecret,
    webhookSecret: context.githubSecrets.webhookSecret,
    tokenEncryptionKey: context.githubSecrets.tokenEncryptionKey,
    tokenEncryptionKeyId: context.runtimeConfig.githubApp.tokenEncryptionKeyId,
    userTokensExpire: context.runtimeConfig.githubApp.userTokensExpire,
    apiBaseUrl: context.runtimeConfig.githubApp.apiUrl,
    apiVersion: context.runtimeConfig.githubApp.apiVersion,
    requestTimeoutMs: context.runtimeConfig.githubApp.requestTimeoutMs,
  })

  context.logger.info(
    {
      event: 'github.app.validated',
      githubApp: {
        id: report.app?.id,
        slug: report.app?.slug,
        callbackUrl: report.expectedRegistration?.callbackUrl,
        webhookUrl: report.expectedRegistration?.webhookUrl,
        checks: report.checks.length,
        remoteVerificationLimitations: report.remoteVerificationLimitations,
      },
    },
    'GitHub App registration validated',
  )

  return report
}
