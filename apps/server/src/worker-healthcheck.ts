import { hostname } from 'node:os'

import { loadRuntimeConfig, loadSecrets } from '@shipgate/config'
import { createDatabase } from '@shipgate/database'
import { isWorkerHeartbeatFresh } from '@shipgate/jobs'

const runtimeConfig = loadRuntimeConfig()

const secrets = loadSecrets()

const database = createDatabase({
  connectionString: secrets.databaseUrl,

  applicationName: 'shipgate-worker-healthcheck',

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
    max: 1,

    idleTimeoutMs: runtimeConfig.database.idleTimeoutMs,

    connectionTimeoutMs: runtimeConfig.database.connectionTimeoutMs,

    maxLifetimeSeconds: 0,
  },

  allowExitOnIdle: true,

  onPoolError: (error) => {
    process.stderr.write(`${error.message}\n`)
  },
})

try {
  const healthy = await isWorkerHeartbeatFresh(
    database,
    hostname(),

    runtimeConfig.jobs.heartbeatStaleAfterMs,
  )

  if (!healthy) {
    process.stderr.write('Worker heartbeat is stale\n')

    process.exitCode = 1
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)

  process.exitCode = 1
} finally {
  await database.destroy()
}
