import type { DiagnosticJobPayload } from './registry.js'
import type { JobEnvelope } from './types.js'

declare global {
  namespace GraphileWorker {
    interface Tasks {
      diagnostic_echo: JobEnvelope<DiagnosticJobPayload>
    }
  }
}
