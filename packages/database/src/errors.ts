export type DatabaseErrorKind =
  | 'connection'
  | 'timeout'
  | 'conflict'
  | 'constraint'
  | 'serialization'
  | 'deadlock'
  | 'lock'
  | 'unavailable'
  | 'unknown'

const nodeConnectionErrorCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENOTFOUND',
])

const unavailableSqlStates = new Set(['53300', '57P01', '57P02', '57P03'])

export class DatabaseOperationError extends Error {
  readonly operation: string
  readonly kind: DatabaseErrorKind
  readonly retryable: boolean

  readonly driverCode: string | undefined
  readonly sqlState: string | undefined
  readonly severity: string | undefined
  readonly table: string | undefined
  readonly column: string | undefined
  readonly constraint: string | undefined

  constructor(
    operation: string,
    options: {
      readonly cause: unknown
      readonly kind: DatabaseErrorKind
      readonly retryable: boolean
      readonly driverCode?: string
      readonly sqlState?: string
      readonly severity?: string
      readonly table?: string
      readonly column?: string
      readonly constraint?: string
    },
  ) {
    super(`Database operation "${operation}" failed`, {
      cause: options.cause,
    })

    this.name = 'DatabaseOperationError'
    this.operation = operation
    this.kind = options.kind
    this.retryable = options.retryable
    this.driverCode = options.driverCode
    this.sqlState = options.sqlState
    this.severity = options.severity
    this.table = options.table
    this.column = options.column
    this.constraint = options.constraint
  }
}

export function normalizeDatabaseError(error: unknown, operation: string): DatabaseOperationError {
  if (error instanceof DatabaseOperationError) {
    return error
  }

  const driverCode = getStringProperty(error, 'code')

  const sqlState =
    driverCode !== undefined && /^[0-9A-Z]{5}$/.test(driverCode) ? driverCode : undefined

  const severity = getStringProperty(error, 'severity')
  const table = getStringProperty(error, 'table')
  const column = getStringProperty(error, 'column')
  const constraint = getStringProperty(error, 'constraint')

  const kind = classifyDatabaseError(error, driverCode, sqlState)

  return new DatabaseOperationError(operation, {
    cause: error,
    kind,
    retryable: isRetryable(kind),
    ...(driverCode !== undefined ? { driverCode } : {}),
    ...(sqlState !== undefined ? { sqlState } : {}),
    ...(severity !== undefined ? { severity } : {}),
    ...(table !== undefined ? { table } : {}),
    ...(column !== undefined ? { column } : {}),
    ...(constraint !== undefined ? { constraint } : {}),
  })
}

export function isDatabaseDriverError(error: unknown): boolean {
  if (error instanceof DatabaseOperationError) {
    return true
  }

  const code = getStringProperty(error, 'code')
  const name = getStringProperty(error, 'name')

  return (
    (code !== undefined && (/^[0-9A-Z]{5}$/.test(code) || nodeConnectionErrorCodes.has(code))) ||
    name === 'AbortError' ||
    name === 'TimeoutError'
  )
}

function classifyDatabaseError(
  error: unknown,
  driverCode: string | undefined,
  sqlState: string | undefined,
): DatabaseErrorKind {
  const errorName = getStringProperty(error, 'name')

  if (
    errorName === 'AbortError' ||
    errorName === 'TimeoutError' ||
    driverCode === 'ETIMEDOUT' ||
    sqlState === '57014'
  ) {
    return 'timeout'
  }

  if (
    (driverCode !== undefined && nodeConnectionErrorCodes.has(driverCode)) ||
    sqlState?.startsWith('08')
  ) {
    return 'connection'
  }

  switch (sqlState) {
    case '23505':
      return 'conflict'

    case '40001':
      return 'serialization'

    case '40P01':
      return 'deadlock'

    case '55P03':
      return 'lock'
  }

  if (sqlState?.startsWith('23')) {
    return 'constraint'
  }

  if (sqlState !== undefined && unavailableSqlStates.has(sqlState)) {
    return 'unavailable'
  }

  return 'unknown'
}

function isRetryable(kind: DatabaseErrorKind): boolean {
  return (
    kind === 'connection' ||
    kind === 'timeout' ||
    kind === 'serialization' ||
    kind === 'deadlock' ||
    kind === 'lock' ||
    kind === 'unavailable'
  )
}

function getStringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return undefined
  }

  const property = Reflect.get(value, key)

  return typeof property === 'string' ? property : undefined
}
