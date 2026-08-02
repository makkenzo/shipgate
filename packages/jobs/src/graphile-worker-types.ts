import type { DiagnosticJobPayload, GitHubWebhookProcessPayload } from './registry.js'
import type { JobEnvelope } from './types.js'

declare global {
  namespace GraphileWorker {
    interface Tasks {
      diagnostic_echo: JobEnvelope<DiagnosticJobPayload>
      github_webhook_process: JobEnvelope<GitHubWebhookProcessPayload>
    }
  }
}
