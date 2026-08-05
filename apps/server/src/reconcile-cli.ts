import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'

import { queueRepositoryReconciliationForProject } from './projects/index.js'
import { runApplication } from './run-application.js'

const commandArguments = process.argv[2] === '--' ? process.argv.slice(3) : process.argv.slice(2)

await runApplication({
  processKind: 'migrator',

  async start(context) {
    const { values } = parseArgs({
      args: commandArguments,
      options: {
        'project-id': {
          type: 'string',
        },
        reason: {
          type: 'string',
          default: 'manual_reconciliation',
        },
        'force-push': {
          type: 'boolean',
          default: false,
        },
      },
      strict: true,
    })
    const projectId = requireNonEmptyOption('--project-id', values['project-id'])
    const reason = requireNonEmptyOption('--reason', values.reason)
    const operationId = randomUUID()
    const reconciliation = await queueRepositoryReconciliationForProject(context.database, {
      projectId,
      reason,
      requestedByGitHubUserId: null,
      deduplicationKey: operationId,
      correlationId: operationId,
      causationId: `cli:repository-reconciliation:${operationId}`,
      triggerScope: {
        reasons: ['manual_reconciliation', reason],
        requireReconciliation: true,
      },
      forcePush: values['force-push'],
    })

    if (!reconciliation) {
      process.exitCode = 2
      process.stdout.write(
        `${JSON.stringify({
          event: 'repository.reconciliation.not_queued',
          projectId,
          reason: 'project_not_runnable',
          correlationId: operationId,
        })}\n`,
      )
    } else {
      process.stdout.write(
        `${JSON.stringify({
          event: 'repository.reconciliation.queued',
          projectId,
          reconciliationRequestId: reconciliation.id,
          syncRunId: reconciliation.syncRunId,
          forcePush: values['force-push'],
          correlationId: operationId,
        })}\n`,
      )
    }

    return {
      waitUntilStopped: Promise.resolve(),
    }
  },
})

function requireNonEmptyOption(name: string, value: string | undefined): string {
  const normalized = value?.trim()

  if (!normalized) {
    throw new Error(`${name} is required and must not be empty`)
  }

  return normalized
}
