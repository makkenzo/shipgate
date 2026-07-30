import { PostgreSqlContainer } from '@testcontainers/postgresql'

const postgresImage = 'postgres:18.4-alpine3.24'

export interface PostgresTestDatabase {
  readonly connectionString: string

  stop(): Promise<void>
}

export async function startPostgresTestDatabase(): Promise<PostgresTestDatabase> {
  const container = await new PostgreSqlContainer(postgresImage)
    .withDatabase('shipgate_test')
    .withUsername('shipgate_test')
    .withPassword('shipgate_test')
    .start()

  return {
    connectionString: container.getConnectionUri(),

    async stop() {
      await container.stop()
    },
  }
}
