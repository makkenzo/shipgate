import type { StructuredLogger } from './types.js'

const noopLogger: StructuredLogger = {
  child() {
    return noopLogger
  },

  debug() {},
  info() {},
  warn() {},
  error() {},
}

export function createNoopJobLogger(): StructuredLogger {
  return noopLogger
}
