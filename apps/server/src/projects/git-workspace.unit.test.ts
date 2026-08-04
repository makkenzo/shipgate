import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import type { ProjectConfigurationValidationError } from './errors.js'
import { createReadOnlyGitWorkspace } from './git-workspace.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('read-only Git workspace', () => {
  it('confirms ancestry from fetched commit objects and rejects diverged branches', async () => {
    const fixture = await createGitFixture()
    const workspace = createReadOnlyGitWorkspace({
      temporaryRoot: fixture.root,
      allowFileProtocol: true,
    })

    await expect(
      workspace.assertProductionAncestor({
        cloneUrl: pathToFileURL(fixture.origin).href,
        installationToken: 'installation-token',
        sourceBranch: 'source',
        productionBranch: 'production',
        sourceSha: fixture.sourceSha,
        productionSha: fixture.productionSha,
      }),
    ).resolves.toBeUndefined()

    await expect(
      workspace.assertProductionAncestor({
        cloneUrl: pathToFileURL(fixture.origin).href,
        installationToken: 'installation-token',
        sourceBranch: 'diverged',
        productionBranch: 'production-diverged',
        sourceSha: fixture.divergedSha,
        productionSha: fixture.divergedProductionSha,
      }),
    ).rejects.toMatchObject({
      name: 'ProjectConfigurationValidationError',
      code: 'production_branch_not_ancestor',
    } satisfies Partial<ProjectConfigurationValidationError>)
  })
})

async function createGitFixture(): Promise<{
  readonly root: string
  readonly origin: string
  readonly productionSha: string
  readonly sourceSha: string
  readonly divergedSha: string
  readonly divergedProductionSha: string
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'shipgate-git-workspace-test-'))
  roots.push(root)
  const repository = path.join(root, 'repository')
  const origin = path.join(root, 'origin.git')
  await mkdir(repository)
  await git(['init', repository])
  await git(['-C', repository, 'config', 'user.name', 'Shipgate Test'])
  await git(['-C', repository, 'config', 'user.email', 'shipgate@example.test'])
  await writeFile(path.join(repository, 'release.txt'), 'production\n')
  await git(['-C', repository, 'add', 'release.txt'])
  await git(['-C', repository, 'commit', '-m', 'production'])
  const productionSha = await revParse(repository, 'HEAD')
  await git(['-C', repository, 'branch', 'production', productionSha])
  await writeFile(path.join(repository, 'release.txt'), 'source\n')
  await git(['-C', repository, 'commit', '-am', 'source'])
  const sourceSha = await revParse(repository, 'HEAD')
  await git(['-C', repository, 'branch', 'source', sourceSha])
  await git(['-C', repository, 'checkout', '--detach', productionSha])
  await writeFile(path.join(repository, 'production.txt'), 'production moved\n')
  await git(['-C', repository, 'add', 'production.txt'])
  await git(['-C', repository, 'commit', '-m', 'production moved'])
  const divergedProductionSha = await revParse(repository, 'HEAD')
  await git(['-C', repository, 'branch', 'production-diverged', divergedProductionSha])
  await git(['-C', repository, 'checkout', '--detach', productionSha])
  await writeFile(path.join(repository, 'diverged.txt'), 'diverged\n')
  await git(['-C', repository, 'add', 'diverged.txt'])
  await git(['-C', repository, 'commit', '-m', 'diverged'])
  const divergedSha = await revParse(repository, 'HEAD')
  await git(['-C', repository, 'branch', 'diverged', divergedSha])
  await git(['init', '--bare', origin])
  await git(['-C', repository, 'remote', 'add', 'origin', pathToFileURL(origin).href])
  await git([
    '-C',
    repository,
    'push',
    'origin',
    'production:refs/heads/production',
    'source:refs/heads/source',
    'diverged:refs/heads/diverged',
    'production-diverged:refs/heads/production-diverged',
  ])

  return {
    root,
    origin,
    productionSha,
    sourceSha,
    divergedSha,
    divergedProductionSha,
  }
}

async function git(args: readonly string[]): Promise<void> {
  await execFileAsync('git', [...args], { encoding: 'utf8' })
}

async function revParse(repository: string, ref: string): Promise<string> {
  const result = await execFileAsync('git', ['-C', repository, 'rev-parse', ref], {
    encoding: 'utf8',
  })

  return result.stdout.trim()
}
