export function createCsrfHeaders(): Record<string, string> {
  return {
    'x-csrf-token': readCookie('__Host-shipgate_csrf') ?? '',
  }
}

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') {
    return undefined
  }

  const prefix = `${name}=`

  for (const part of document.cookie.split(';')) {
    const cookie = part.trim()

    if (cookie.startsWith(prefix)) {
      try {
        return decodeURIComponent(cookie.slice(prefix.length))
      } catch {
        return undefined
      }
    }
  }

  return undefined
}
