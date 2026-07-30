import type { JsonValue } from '@shipgate/database'

export function toJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value)

  if (serialized === undefined) {
    throw new TypeError('Value cannot be serialized as JSON')
  }

  return JSON.parse(serialized) as JsonValue
}
