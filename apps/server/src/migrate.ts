import { migrateToLatest } from '@shipgate/database'
import { migrateJobQueue } from '@shipgate/jobs'

import { runApplication } from './run-application.js'

await runApplication({
  processKind: 'migrator',

  async start(context) {
    await migrateJobQueue(context.database)

    const results = await migrateToLatest(context.database.kysely)

    return {
      startupFields: {
        migrations: {
          applied: results.filter((result) => result.status === 'Success').length,
        },
      },

      waitUntilStopped: Promise.resolve(),
    }
  },
})
