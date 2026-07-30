import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'

import { loadRuntimeConfig, loadSecrets } from '@shipgate/config'
import { createDatabase } from '@shipgate/database'

import { enqueueJob } from './enqueue.js'
import { waitForJobExecution } from './store.js'

const commandArguments = process.argv[2] === '--' ? process.argv.slice(3) : process.argv.slice(2)

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
    ? Number.parseInt(values['fail-until-attempt'], 10)
    : undefined

const delayMs = Number.parseInt(values['delay-ms'], 10)

const timeoutMs = Number.parseInt(values['timeout-ms'], 10)

const runtimeConfig = loadRuntimeConfig()

const secrets = loadSecrets()

const database = createDatabase({
  connectionString: secrets.databaseUrl,

  applicationName: 'shipgate-job-cli',

  ssl: {
    mode: runtimeConfig.database.sslMode,

    ...(secrets.databaseSslCa
      ? {
          ca: secrets.databaseSslCa,
        }
      : {}),
  },

  pool: {
    min: 0,
    max: 2,

    idleTimeoutMs: runtimeConfig.database.idleTimeoutMs,

    connectionTimeoutMs: runtimeConfig.database.connectionTimeoutMs,

    maxLifetimeSeconds: runtimeConfig.database.maxLifetimeSeconds,
  },

  allowExitOnIdle: true,

  onPoolError: (error) => {
    process.stderr.write(
      `${JSON.stringify({
        event: 'jobs.pool.error',
        error: error.message,
      })}\n`,
    )
  },
})

try {
  const correlationId = randomUUID()

  const job = await enqueueJob(
    database,
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
    const execution = await waitForJobExecution(database, job.jobId, {
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
} finally {
  await database.destroy()
}
