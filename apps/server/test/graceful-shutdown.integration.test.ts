import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { once } from 'node:events'
import type { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { createDatabase, type DatabaseClient, migrateToLatest } from '@shipgate/database'
import { migrateJobQueue } from '@shipgate/jobs'
import {
  createTestEnvironment,
  type PostgresTestDatabase,
  startPostgresTestDatabase,
} from '@shipgate/testing'
import getPort from 'get-port'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

type SpawnedProcess = ChildProcessByStdio<null, Readable, Readable>

describe.sequential('graceful shutdown', () => {
  let postgres: PostgresTestDatabase

  let database: DatabaseClient

  beforeAll(async () => {
    postgres = await startPostgresTestDatabase()

    database = createDatabase({
      connectionString: postgres.connectionString,

      applicationName: 'shipgate-shutdown-test',

      ssl: {
        mode: 'disable',
      },

      pool: {
        min: 0,
        max: 2,
        idleTimeoutMs: 5000,
        connectionTimeoutMs: 5000,
        maxLifetimeSeconds: 0,
      },

      allowExitOnIdle: true,
      onPoolError: () => undefined,
    })

    await migrateJobQueue(database)

    await migrateToLatest(database.kysely)
  })

  afterAll(async () => {
    await database.destroy()
    await postgres.stop()
  })

  it.each([
    {
      name: 'API',
      entrypoint: 'src/api.ts',
    },
    {
      name: 'worker',
      entrypoint: 'src/worker.ts',
    },
  ])(
    'stops $name on SIGTERM',
    async ({ entrypoint }) => {
      const port = await getPort()

      const child = spawnEntrypoint(
        entrypoint,

        createTestEnvironment(postgres.connectionString, {
          LOG_LEVEL: 'info',
          PORT: String(port),
        }),
      )

      const output = collectOutput(child)

      try {
        await waitForOutput(output, '"event":"application.started"')

        expect(child.kill('SIGTERM')).toBe(true)

        const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null]

        expect(signal).toBeNull()
        expect(code).toBe(0)

        expect(output.value).toContain('"event":"application.stopping"')

        expect(output.value).toContain('"event":"application.stopped"')
      } finally {
        if (child.exitCode === null) {
          child.kill('SIGKILL')
        }
      }
    },
    30_000,
  )
})

function spawnEntrypoint(entrypoint: string, environment: NodeJS.ProcessEnv): SpawnedProcess {
  return spawn(process.execPath, ['--import', 'tsx', entrypoint], {
    cwd: new URL('..', import.meta.url),

    env: environment,

    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

interface CollectedOutput {
  value: string
}

function collectOutput(child: SpawnedProcess): CollectedOutput {
  const output = {
    value: '',
  }

  child.stdout.on('data', (chunk: Buffer) => {
    output.value += chunk.toString('utf8')
  })

  child.stderr.on('data', (chunk: Buffer) => {
    output.value += chunk.toString('utf8')
  })

  return output
}

async function waitForOutput(output: CollectedOutput, expected: string): Promise<void> {
  const deadline = Date.now() + 20_000

  while (!output.value.includes(expected)) {
    if (Date.now() >= deadline) {
      throw new Error(`Process did not produce ${expected}\n\n${output.value}`)
    }

    await delay(50)
  }
}
