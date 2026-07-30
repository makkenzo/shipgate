import { getMigrationStatus, rollbackLastMigration } from '@shipgate/database'
import { isJobQueueInstalled } from '@shipgate/jobs'

import { runApplication } from './run-application.js'

type DatabaseCommand = 'down' | 'status'

const command = parseCommand(process.argv[2])

if (!command) {
  process.stderr.write('Usage: database-cli.js <down|status>\n')
  process.exitCode = 1
} else {
  await runApplication({
    processKind: 'migrator',

    async start(context) {
      let output: unknown

      if (command === 'down') {
        output = await rollback(context.database.kysely)
      } else {
        const jobQueueInstalled = await isJobQueueInstalled(context.database)

        if (!jobQueueInstalled) {
          process.exitCode = 1
        }

        output = {
          event: 'database.migrations.status',
          jobQueueInstalled,
          migrations: await getMigrationStatus(context.database.kysely),
        }
      }

      process.stdout.write(`${JSON.stringify(output)}\n`)

      return {
        waitUntilStopped: Promise.resolve(),
      }
    },
  })
}

function parseCommand(value: string | undefined): DatabaseCommand | undefined {
  return value === 'down' || value === 'status' ? value : undefined
}

async function rollback(database: Parameters<typeof rollbackLastMigration>[0]) {
  return {
    event: 'database.migrations.down',
    results: await rollbackLastMigration(database),
  }
}
