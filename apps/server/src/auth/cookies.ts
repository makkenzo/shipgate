export const SESSION_COOKIE_NAME = '__Host-shipgate_session'
export const CSRF_COOKIE_NAME = '__Host-shipgate_csrf'

export function parseCookies(header: string | undefined): Readonly<Record<string, string>> {
  if (!header) {
    return {}
  }

  const cookies: Record<string, string> = {}

  for (const part of header.split(';')) {
    const separator = part.indexOf('=')

    if (separator <= 0) {
      continue
    }

    const name = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()

    if (!name || Object.hasOwn(cookies, name)) {
      continue
    }

    try {
      cookies[name] = decodeURIComponent(value)
    } catch {
      // Ignore malformed cookie values instead of rejecting the whole request.
    }
  }

  return cookies
}

export function createSessionCookies(input: {
  readonly sessionToken: string
  readonly csrfToken: string
  readonly expiresAt: Date
}): string[] {
  const expires = input.expiresAt.toUTCString()

  return [
    serializeCookie(SESSION_COOKIE_NAME, input.sessionToken, {
      httpOnly: true,
      expires,
    }),
    serializeCookie(CSRF_COOKIE_NAME, input.csrfToken, {
      httpOnly: false,
      expires,
    }),
  ]
}

export function createExpiredSessionCookies(): string[] {
  const expires = new Date(0).toUTCString()

  return [
    serializeCookie(SESSION_COOKIE_NAME, '', {
      httpOnly: true,
      expires,
      maxAge: 0,
    }),
    serializeCookie(CSRF_COOKIE_NAME, '', {
      httpOnly: false,
      expires,
      maxAge: 0,
    }),
  ]
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    readonly httpOnly: boolean
    readonly expires: string
    readonly maxAge?: number
  },
): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'Secure',
    'SameSite=Lax',
    `Expires=${options.expires}`,
  ]

  if (options.httpOnly) {
    attributes.push('HttpOnly')
  }

  if (options.maxAge !== undefined) {
    attributes.push(`Max-Age=${options.maxAge}`)
  }

  return attributes.join('; ')
}
