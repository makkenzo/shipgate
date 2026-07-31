import {
  EnvironmentValidationError,
  loadGitHubRuntimeConfig,
  loadGitHubSecrets,
} from '@shipgate/config'
import {
  type GitHubAppValidationCheck,
  type GitHubAppValidationReport,
  validateGitHubAppRegistration,
} from '@shipgate/github'

const jsonOutput = process.argv.slice(2).includes('--json')

try {
  const runtimeConfig = loadGitHubRuntimeConfig()
  const secrets = loadGitHubSecrets()

  const report = await validateGitHubAppRegistration({
    appOrigin: runtimeConfig.appOrigin,
    appId: runtimeConfig.appId,
    clientId: runtimeConfig.clientId,
    privateKey: secrets.privateKey,
    clientSecret: secrets.clientSecret,
    webhookSecret: secrets.webhookSecret,
    tokenEncryptionKey: secrets.tokenEncryptionKey,
    tokenEncryptionKeyId: runtimeConfig.tokenEncryptionKeyId,
    userTokensExpire: runtimeConfig.userTokensExpire,
    apiBaseUrl: runtimeConfig.apiUrl,
    apiVersion: runtimeConfig.apiVersion,
    requestTimeoutMs: runtimeConfig.requestTimeoutMs,
  })

  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    renderHumanReport(report)
  }

  if (!report.ok) {
    process.exitCode = 1
  }
} catch (error) {
  if (jsonOutput) {
    process.stderr.write(
      `${JSON.stringify(
        {
          ok: false,
          error: serializeBootstrapError(error),
        },
        null,
        2,
      )}\n`,
    )
  } else {
    renderBootstrapError(error)
  }

  process.exitCode = 1
}

function renderHumanReport(report: GitHubAppValidationReport): void {
  process.stdout.write('GitHub App doctor\n\n')

  for (const check of report.checks) {
    process.stdout.write(`${getStatusSymbol(check)} ${check.id}: ${check.message}\n`)

    if (check.status === 'failed' && check.details) {
      renderDetails(check.details)
    }
  }

  const passed = report.checks.filter((check) => check.status === 'passed').length
  const failed = report.checks.filter((check) => check.status === 'failed').length
  const skipped = report.checks.filter((check) => check.status === 'skipped').length
  const resultSummary = [`${passed} passed`, `${failed} failed`, `${skipped} skipped`].join(', ')

  process.stdout.write(`\nResult: ${report.ok ? 'OK' : 'FAILED'} (${resultSummary})\n`)

  const remoteVerificationNote = [
    'GitHub does not expose callback URLs, the user-token-expiration toggle,',
    'or a way to validate the client secret through an app-authenticated REST endpoint.',
    'Review remote drift in GitHub App settings; the client secret is exercised by OAuth.',
  ].join(' ')

  process.stdout.write(`\nNote: ${remoteVerificationNote}\n`)
}

function getStatusSymbol(check: GitHubAppValidationCheck): string {
  switch (check.status) {
    case 'passed':
      return '✓'

    case 'failed':
      return '✗'

    case 'skipped':
      return '–'
  }
}

function renderDetails(details: Readonly<Record<string, unknown>>): void {
  const serialized = JSON.stringify(details, null, 2)

  for (const line of serialized.split('\n')) {
    process.stdout.write(`    ${line}\n`)
  }
}

function renderBootstrapError(error: unknown): void {
  process.stderr.write('GitHub App doctor could not load its configuration\n')

  if (error instanceof EnvironmentValidationError) {
    for (const issue of error.issues) {
      process.stderr.write(`✗ ${issue.path}: ${issue.message}\n`)
    }

    return
  }

  process.stderr.write(`✗ ${error instanceof Error ? error.message : String(error)}\n`)
}

function serializeBootstrapError(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof EnvironmentValidationError) {
    return {
      type: error.name,
      scope: error.scope,
      issues: error.issues,
    }
  }

  return {
    type: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
  }
}
