export function createTestEnvironment(
  databaseUrl: string,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,

    NODE_ENV: 'test',
    APP_VERSION: 'test',
    LOG_LEVEL: 'silent',

    HOST: '127.0.0.1',
    PORT: '3000',

    SHUTDOWN_TIMEOUT_MS: '5000',

    DATABASE_URL: databaseUrl,
    DATABASE_SSL_MODE: 'disable',

    DATABASE_POOL_MIN: '0',
    DATABASE_POOL_MAX: '4',
    DATABASE_IDLE_TIMEOUT_MS: '5000',
    DATABASE_CONNECTION_TIMEOUT_MS: '5000',
    DATABASE_MAX_LIFETIME_SECONDS: '0',
    DATABASE_READINESS_TIMEOUT_MS: '2000',

    JOB_WORKER_CONCURRENCY: '1',
    JOB_WORKER_POLL_INTERVAL_MS: '100',
    JOB_WORKER_HEARTBEAT_INTERVAL_MS: '1000',
    JOB_WORKER_HEARTBEAT_STALE_AFTER_MS: '5000',

    API_DOCS_ENABLED: 'false',

    ...overrides,
  }
}
