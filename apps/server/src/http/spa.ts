import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

const webDistributionPath = fileURLToPath(new URL('../../../web/dist/', import.meta.url))

export async function registerSpa(app: FastifyInstance): Promise<void> {
  await app.register(fastifyStatic, {
    root: webDistributionPath,

    /*
     * Production build уже сформирован,
     * поэтому регистрируем только реально
     * существующие файлы.
     *
     * Это не даёт wildcard-маршруту
     * пытаться отправлять директории:
     * /, /assets/, etc.
     */
    wildcard: false,

    /*
     * index.html отдаём самостоятельно,
     * чтобы управлять SPA fallback
     * и cache-control.
     */
    index: false,

    maxAge: '30d',
    immutable: true,
  })

  /*
   * Явный корневой маршрут.
   * Fastify автоматически создаст
   * соответствующий HEAD route.
   */
  app.get(
    '/',
    {
      schema: {
        hide: true,
      },
    },
    async (_request, reply) => sendSpaIndex(reply),
  )
}

export function shouldServeSpa(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return false
  }

  const pathname = new URL(request.url, 'http://localhost').pathname

  /*
   * Эти пространства имён никогда
   * не должны превращаться в SPA routes.
   */
  if (
    pathname === '/health' ||
    pathname === '/ready' ||
    pathname === '/metrics' ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/docs') ||
    pathname.startsWith('/assets/')
  ) {
    return false
  }

  const accept = request.headers.accept

  return typeof accept === 'string' && accept.includes('text/html')
}

export function sendSpaIndex(reply: FastifyReply): FastifyReply {
  return reply.type('text/html').sendFile('index.html', {
    maxAge: 0,
    immutable: false,
  })
}
