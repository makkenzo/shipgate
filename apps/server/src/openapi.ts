import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApplicationContext } from './application-context.js'
import { buildApiApplication } from './http/api-app.js'

const outputDirectory = fileURLToPath(new URL('../../web/openapi/', import.meta.url))

const outputPath = join(outputDirectory, 'shipgate.openapi.json')

const context = createApplicationContext({
  processKind: 'api',
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
