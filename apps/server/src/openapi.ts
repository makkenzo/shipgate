import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApplicationContext } from './application-context.js'
import { buildApiApplication } from './http/api-app.js'

const outputDirectory = fileURLToPath(new URL('../../web/openapi/', import.meta.url))

const outputPath = join(outputDirectory, 'shipgate.openapi.json')

const context = createApplicationContext({
  processKind: 'api',

  environment: {
    ...process.env,

    /*
     * Building the contract creates the normal composition context so routes
     * receive their real dependencies, but it never opens a database
     * connection. Keep generation deterministic in clean build environments
     * where deployment secrets are intentionally unavailable.
     */
    DATABASE_URL:
      process.env.DATABASE_URL ?? 'postgresql://shipgate:shipgate@127.0.0.1:5432/shipgate',

    /*
     * The contract describes every implemented API operation.
     * Runtime exposure remains controlled independently.
     */
    API_DIAGNOSTICS_ENABLED: 'true',
  },
})

try {
  const app = await buildApiApplication(context)

  try {
    await app.ready()

    const document = app.swagger()

    await mkdir(outputDirectory, {
      recursive: true,
    })

    await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8')

    process.stdout.write(`OpenAPI written to ${outputPath}\n`)
  } finally {
    await app.close()
  }
} finally {
  await context.database.destroy()
  context.logger.flush()
}
