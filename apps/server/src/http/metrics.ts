import { getQueueMetrics } from '@shipgate/jobs'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client'

import type { ApplicationContext } from '../application-context.js'

export interface ApiMetrics {
  observeRequest(request: FastifyRequest, reply: FastifyReply): void

  render(): Promise<{
    readonly contentType: string
    readonly body: string
  }>
}

export function createApiMetrics(context: ApplicationContext): ApiMetrics {
  const registry = new Registry()

  registry.setDefaultLabels({
    application: 'shipgate',
    service: 'shipgate-api',

    version: context.runtimeConfig.appVersion,
  })

  collectDefaultMetrics({
    register: registry,
    prefix: 'shipgate_',
  })

  const requestCounter = new Counter({
    name: 'shipgate_http_requests_total',

    help: 'Total number of HTTP requests.',

    labelNames: ['method', 'route', 'status_code'] as const,

    registers: [registry],
  })

  const requestDuration = new Histogram({
    name: 'shipgate_http_request_duration_seconds',

    help: 'HTTP request duration in seconds.',

    labelNames: ['method', 'route', 'status_code'] as const,

    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],

    registers: [registry],
  })

  const queueMetricsAvailable = new Gauge({
    name: 'shipgate_queue_metrics_available',

    help: 'Whether queue metrics could be collected.',

    registers: [registry],
  })

  const queuedJobs = createQueueGauge(registry, 'queued')

  const scheduledJobs = createQueueGauge(registry, 'scheduled')

  const runningJobs = createQueueGauge(registry, 'running')

  const retryingJobs = createQueueGauge(registry, 'retrying')

  const failedJobs = createQueueGauge(registry, 'failed')

  const activeWorkers = new Gauge({
    name: 'shipgate_job_workers_active',

    help: 'Number of workers with a fresh heartbeat.',

    registers: [registry],
  })

  const staleWorkers = new Gauge({
    name: 'shipgate_job_workers_stale',

    help: 'Number of workers with a stale heartbeat.',

    registers: [registry],
  })

  return {
    observeRequest(request, reply) {
      const labels = {
        method: request.method,

        route: request.routeOptions.url ?? 'unmatched',

        status_code: String(reply.statusCode),
      }

      requestCounter.inc(labels)

      requestDuration.observe(labels, reply.elapsedTime / 1_000)
    },

    async render() {
      try {
        const metrics = await getQueueMetrics(
          context.database,

          context.runtimeConfig.jobs.heartbeatStaleAfterMs,
        )

        queueMetricsAvailable.set(1)

        queuedJobs.set(metrics.queue.queued)

        scheduledJobs.set(metrics.queue.scheduled)

        runningJobs.set(metrics.queue.running)

        retryingJobs.set(metrics.queue.retrying)

        failedJobs.set(metrics.queue.failed)

        activeWorkers.set(metrics.workers.active)

        staleWorkers.set(metrics.workers.stale)
      } catch (error) {
        queueMetricsAvailable.set(0)

        context.logger.warn(
          {
            event: 'metrics.queue.failed',

            err: error instanceof Error ? error : new Error(String(error)),
          },
          'Queue metrics collection failed',
        )
      }

      return {
        contentType: registry.contentType,

        body: await registry.metrics(),
      }
    },
  }
}

function createQueueGauge(registry: Registry, state: string): Gauge {
  return new Gauge({
    name: `shipgate_jobs_${state}`,

    help: `Number of ${state} Shipgate jobs.`,

    registers: [registry],
  })
}
