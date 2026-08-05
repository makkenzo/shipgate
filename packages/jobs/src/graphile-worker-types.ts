import type {
  DiagnosticJobPayload,
  GitHubWebhookProcessPayload,
  RepositoryIncrementalSyncJobPayload,
  RepositoryInitialSyncJobPayload,
  RepositoryRequiredChecksSyncJobPayload,
} from './registry.js'
import type { JobEnvelope } from './types.js'

declare global {
  namespace GraphileWorker {
    interface Tasks {
      diagnostic_echo: JobEnvelope<DiagnosticJobPayload>
      github_webhook_process: JobEnvelope<GitHubWebhookProcessPayload>
      'repository.initial-sync': JobEnvelope<RepositoryInitialSyncJobPayload>
      'repository.reconcile': JobEnvelope<RepositoryInitialSyncJobPayload>
      'repository.refresh-branches': JobEnvelope<RepositoryIncrementalSyncJobPayload>
      'repository.refresh-change': JobEnvelope<RepositoryIncrementalSyncJobPayload>
      'repository.refresh-checks': JobEnvelope<RepositoryIncrementalSyncJobPayload>
      'repository.refresh-rules': JobEnvelope<RepositoryIncrementalSyncJobPayload>
      'repository.required-checks-sync': JobEnvelope<RepositoryRequiredChecksSyncJobPayload>
    }
  }
}
