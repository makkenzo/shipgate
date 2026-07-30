import { z } from 'zod'

import type { JobEnvelope, JobMetadata } from './types.js'

const timestampSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'Expected an ISO timestamp',
})

export const jobMetadataSchema = z
  .object({
    correlationId: z.string().trim().min(1).max(128),

    causationId: z.string().trim().min(1).max(256).optional(),

    enqueuedAt: timestampSchema,
  })
  .strict()

export function createJobEnvelopeSchema<Schema extends z.ZodTypeAny>(dataSchema: Schema) {
  return z
    .object({
      version: z.literal(1),
      metadata: jobMetadataSchema,
      data: dataSchema,
    })
    .strict()
}

export function createJobEnvelope<Data>(
  data: Data,
  metadata: {
    readonly correlationId: string
    readonly causationId?: string
  },
): JobEnvelope<Data> {
  const jobMetadata: JobMetadata = {
    correlationId: metadata.correlationId,
    enqueuedAt: new Date().toISOString(),

    ...(metadata.causationId !== undefined
      ? {
          causationId: metadata.causationId,
        }
      : {}),
  }

  return {
    version: 1,
    metadata: jobMetadata,
    data,
  }
}
