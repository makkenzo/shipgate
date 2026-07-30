import { loadRuntimeConfig, loadSecrets } from '@shipgate/config'
import { createDatabase } from '@shipgate/database'

import { isJobQueueInstalled, migrateJobQueue } from './migrations.js'

const command = process.argv[2]

if (command !== 'up' && command !== 'status') {
  process.stderr.write('Usage: migration-cli.js <up|status>\n')

  process.exitCode = 1
} else {
  try {
    const runtimeConfig = loadRuntimeConfig()

    const secrets = loadSecrets()

    const database = createDatabase({
      connectionString: secrets.databaseUrl,

      applicationName: 'shipgate-job-migrator',

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

            error: {
              name: error.name,
              message: error.message,
              kind: error.kind,
              retryable: error.retryable,
            },
          })}\n`,
        )
      },
    })

    try {
      if (command === 'up') {
        await migrateJobQueue(database)
      }

      const installed = await isJobQueueInstalled(database)

      process.stdout.write(
        `${JSON.stringify({
          event: 'jobs.migrations.status',

          installed,
        })}\n`,
      )

      if (!installed) {
        process.exitCode = 1
      }
    } finally {
      await database.destroy()
    }
  } catch (error) {
    process.exitCode = 1

    process.stderr.write(
      `${JSON.stringify({
        event: 'jobs.migrations.fatal',

        error: {
          name: error instanceof Error ? error.name : 'UnknownError',

          message: error instanceof Error ? error.message : String(error),
        },
      })}\n`,
    )
  }
}
