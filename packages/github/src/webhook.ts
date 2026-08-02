import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

const signaturePattern = /^sha256=([0-9a-f]{64})$/i

export function verifyGitHubWebhookSignature(input: {
  readonly secret: string
  readonly rawBody: Buffer
  readonly signature: string | undefined
}): boolean {
  if (!input.signature) return false
  const match = signaturePattern.exec(input.signature)
  if (!match?.[1]) return false

  const expected = createHmac('sha256', input.secret).update(input.rawBody).digest()
  const received = Buffer.from(match[1], 'hex')

  return received.length === expected.length && timingSafeEqual(received, expected)
}

export function hashGitHubWebhookPayload(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex')
}
