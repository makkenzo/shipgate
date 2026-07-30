import type { RuntimeConfig } from '@shipgate/config'
import pino, { type Logger } from 'pino'

export type ProcessKind = 'api' | 'worker'

export interface LoggerOptions {
  readonly processKind: ProcessKind
  readonly runtimeConfig: RuntimeConfig
}

export function createLogger(options: LoggerOptions): Logger {
  const { processKind, runtimeConfig } = options

  return pino({
    level: runtimeConfig.logLevel,

    base: {
      application: 'shipgate',
      service: `shipgate-${processKind}`,
      processKind,
      environment: runtimeConfig.environment,
      version: runtimeConfig.appVersion,
      pid: process.pid,
    },

    timestamp: pino.stdTimeFunctions.isoTime,

    serializers: {
      err: pino.stdSerializers.err,
    },
  })
}

export function createBootstrapLogger(processKind: ProcessKind): Logger {
  return pino({
    level: 'info',

    base: {
      application: 'shipgate',
      service: `shipgate-${processKind}`,
      processKind,
      pid: process.pid,
    },

    timestamp: pino.stdTimeFunctions.isoTime,

    serializers: {
      err: pino.stdSerializers.err,
    },
  })
}
