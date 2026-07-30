import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const allowedRuntimeDependencies = new Map([
  ['@shipgate/config', new Set()],
  ['@shipgate/testing', new Set()],

  ['@shipgate/database', new Set()],
  ['@shipgate/web', new Set()],
  ['@shipgate/jobs', new Set(['@shipgate/database'])],

  ['@shipgate/server', new Set(['@shipgate/config', '@shipgate/database', '@shipgate/jobs'])],
])

const productionFields = ['dependencies', 'optionalDependencies', 'peerDependencies']

const dependencyFields = [...productionFields, 'devDependencies']
const workspaceRoots = ['apps', 'packages']
const manifests = []
const errors = []

for (const workspaceRoot of workspaceRoots) {
  const entries = await readdir(workspaceRoot, {
    withFileTypes: true,
  })

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const manifestPath = path.join(workspaceRoot, entry.name, 'package.json')

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

    manifests.push({
      manifest,
      manifestPath,
    })
  }
}

const manifestsByName = new Map()

for (const item of manifests) {
  const packageName = item.manifest.name

  if (manifestsByName.has(packageName)) {
    errors.push(`duplicate workspace name: ${String(packageName)}`)
  } else {
    manifestsByName.set(packageName, item)
  }
}

const dependencyGraph = new Map(
  [...manifestsByName.keys()].map((packageName) => [packageName, new Set()]),
)

for (const { manifest, manifestPath } of manifests) {
  const packageName = manifest.name

  const allowedRuntime = allowedRuntimeDependencies.get(packageName)

  if (!allowedRuntime) {
    errors.push(`${manifestPath}: unknown Shipgate workspace ${String(packageName)}`)

    continue
  }

  for (const field of dependencyFields) {
    const dependencies = Object.entries(manifest[field] ?? {})

    for (const [dependency, version] of dependencies) {
      if (!dependency.startsWith('@shipgate/')) {
        continue
      }

      if (!manifestsByName.has(dependency)) {
        errors.push(`${packageName}: ${field}.${dependency} points to an unknown workspace`)

        continue
      }

      if (typeof version !== 'string' || !version.startsWith('workspace:')) {
        errors.push(`${packageName}: ${field}.${dependency} must use the workspace: protocol`)
      }

      dependencyGraph.get(packageName)?.add(dependency)
    }
  }

  for (const field of productionFields) {
    const dependencies = Object.keys(manifest[field] ?? {})

    for (const dependency of dependencies) {
      if (!dependency.startsWith('@shipgate/')) {
        continue
      }

      if (!allowedRuntime.has(dependency)) {
        errors.push(`${packageName}: ${field}.${dependency} violates the runtime boundary`)
      }
    }
  }

  const developmentDependencies = Object.keys(manifest.devDependencies ?? {})

  for (const dependency of developmentDependencies) {
    if (!dependency.startsWith('@shipgate/')) {
      continue
    }

    const allowedInDevelopment =
      allowedRuntime.has(dependency) ||
      (dependency === '@shipgate/testing' && packageName !== '@shipgate/testing')

    if (!allowedInDevelopment) {
      errors.push(`${packageName}: devDependencies.${dependency} violates the development boundary`)
    }
  }
}

const states = new Map()
const stack = []

function visit(packageName) {
  states.set(packageName, 'visiting')
  stack.push(packageName)

  for (const dependency of dependencyGraph.get(packageName) ?? []) {
    const state = states.get(dependency)

    if (state === 'visiting') {
      const cycleStart = stack.indexOf(dependency)

      const cycle = [...stack.slice(cycleStart), dependency]

      errors.push(`workspace dependency cycle: ${cycle.join(' -> ')}`)

      continue
    }

    if (state !== 'visited') {
      visit(dependency)
    }
  }

  stack.pop()
  states.set(packageName, 'visited')
}

for (const packageName of dependencyGraph.keys()) {
  if (!states.has(packageName)) {
    visit(packageName)
  }
}

if (errors.length > 0) {
  const uniqueErrors = [...new Set(errors)]

  console.error(
    ['Repository dependency violations:', ...uniqueErrors.map((error) => `- ${error}`)].join('\n'),
  )

  process.exitCode = 1
} else {
  console.log('Package boundaries and workspace dependency graph are valid')
}
