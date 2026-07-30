import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'

import { enqueueJob, waitForJobExecution } from '@shipgate/jobs'

import { runApplication } from './run-application.js'

const commandArguments = process.argv[2] === '--' ? process.argv.slice(3) : process.argv.slice(2)

await runApplication({
  processKind: 'migrator',

  async start(context) {
    const { values } = parseArgs({
      args: commandArguments,

      options: {
        message: {
          type: 'string',
          default: 'Shipgate diagnostic job',
        },

        outcome: {
          type: 'string',
          default: 'success',
        },

        'fail-until-attempt': {
          type: 'string',
        },

        'delay-ms': {
          type: 'string',
          default: '0',
        },

        wait: {
          type: 'boolean',
          default: true,
        },

        'timeout-ms': {
          type: 'string',
          default: '40000',
        },
      },

      strict: true,
    })

    const outcome = values.outcome

    if (outcome !== 'success' && outcome !== 'retryable-error' && outcome !== 'permanent-error') {
      throw new Error(`Invalid --outcome: ${outcome}`)
    }

    const failUntilAttempt =
      values['fail-until-attempt'] !== undefined
        ? parseIntegerOption('--fail-until-attempt', values['fail-until-attempt'])
        : undefined

    const delayMs = parseIntegerOption('--delay-ms', values['delay-ms'])
    const timeoutMs = parseIntegerOption('--timeout-ms', values['timeout-ms'])
    const correlationId = randomUUID()

    const job = await enqueueJob(
      context.database,
      'diagnostic_echo',
      {
        message: values.message,
        outcome,
        delayMs,

        ...(failUntilAttempt !== undefined
          ? {
              failUntilAttempt,
            }
          : {}),
      },
      {
        correlationId,
        causationId: `cli:${correlationId}`,
      },
    )

    process.stdout.write(
      `${JSON.stringify({
        event: 'job.queued',
        jobId: job.jobId,
        correlationId,
      })}\n`,
    )

    if (values.wait) {
      const execution = await waitForJobExecution(context.database, job.jobId, {
        timeoutMs,
      })

      process.stdout.write(
        `${JSON.stringify({
          event: 'job.terminal_state',
          execution,
        })}\n`,
      )

      if (execution.status === 'failed') {
        process.exitCode = 2
      }
    }

    return {
      waitUntilStopped: Promise.resolve(),
    }
  },
})

function parseIntegerOption(name: string, value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer`)
  }

  return Number.parseInt(value, 10)
}
