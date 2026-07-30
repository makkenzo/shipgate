import { randomUUID } from 'node:crypto'

import type { Logger } from 'pino'

const correlationIdPattern = /^[A-Za-z0-9._:-]{1,128}$/

export function createCorrelationId(): string {
  return randomUUID()
}

export function resolveCorrelationId(value: string | readonly string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value

  if (candidate && correlationIdPattern.test(candidate)) {
    return candidate
  }

  return createCorrelationId()
}

export function withCorrelationId(logger: Logger, correlationId: string): Logger {
  return logger.child({ correlationId })
}
