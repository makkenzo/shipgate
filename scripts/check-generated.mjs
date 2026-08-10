import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv[2]

const definitions = {
  api: {
    targets: ['apps/web/openapi', 'apps/web/src/api/generated'],
    command: ['pnpm', 'api:generate:compiled'],
  },
  routes: {
    targets: ['apps/web/src/routeTree.gen.ts'],
    command: ['pnpm', '--filter', '@shipgate/web', 'routes:generate'],
  },
}

const definition = definitions[mode]

if (!definition) {
  console.error('Usage: node scripts/check-generated.mjs <api|routes>')
  process.exit(2)
}

const before = await snapshot(definition.targets)
const result = spawnSync(definition.command[0], definition.command.slice(1), {
  cwd: repositoryRoot,
  stdio: 'inherit',
  env: process.env,
})

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

const after = await snapshot(definition.targets)
const changed = [...new Set([...before.keys(), ...after.keys()])]
  .filter((path) => before.get(path) !== after.get(path))
  .toSorted()

if (changed.length > 0) {
  console.error(`Generated ${mode} artifacts were stale:`)
  for (const path of changed) console.error(`  ${path}`)
  console.error('Keep the regenerated files and run the check again.')
  process.exit(1)
}

console.log(`Generated ${mode} artifacts are current.`)

async function snapshot(targets) {
  const files = []

  for (const target of targets) {
    const path = resolve(repositoryRoot, target)
    const metadata = await stat(path)

    if (metadata.isDirectory()) {
      files.push(...(await walk(path)))
    } else {
      files.push(path)
    }
  }

  const hashes = new Map()

  for (const path of files.toSorted()) {
    const contents = await readFile(path)
    hashes.set(relative(repositoryRoot, path), createHash('sha256').update(contents).digest('hex'))
  }

  return hashes
}

async function walk(directory) {
  const files = []

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)

    if (entry.isDirectory()) files.push(...(await walk(path)))
    else if (entry.isFile()) files.push(path)
  }

  return files
}
