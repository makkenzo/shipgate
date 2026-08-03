export function toSafeHttpUrl(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined
  }

  try {
    const url = new URL(value)

    if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname))) {
      return url.href
    }
  } catch {
    // Invalid and relative external URLs are rejected below.
  }

  return undefined
}

export function toSafeSameOriginPath(
  value: string | null | undefined,
  origin: string,
  fallback: string,
): string {
  if (!value) {
    return fallback
  }

  try {
    const url = new URL(value, origin)

    if (url.origin === origin) {
      return `${url.pathname}${url.search}${url.hash}`
    }
  } catch {
    // Invalid navigation targets fall back to the known local route.
  }

  return fallback
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}
