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

    const topology = {
      cloneUrl: pathToFileURL(fixture.origin).href,
      installationToken: 'installation-token',
      sourceBranch: 'source',
      productionBranch: 'production',
      sourceSha: fixture.sourceSha,
      productionSha: fixture.productionSha,
    }

    await expect(workspace.assertProductionAncestor(topology)).resolves.toBeUndefined()

    await expect(workspace.loadRepositorySnapshot(topology)).resolves.toMatchObject({
      sourceSha: fixture.sourceSha,
      productionSha: fixture.productionSha,
      commits: [
        {
          sha: fixture.sourceSha,
          parentShas: [fixture.productionSha],
          sourceDeltaPosition: 0,
        },
      ],
    })

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

  it('builds the complete delta DAG, first-parent history, and integration windows', async () => {
    const fixture = await createTopologyFixture()
    const workspace = createReadOnlyGitWorkspace({
      temporaryRoot: fixture.root,
      allowFileProtocol: true,
    })

    const snapshot = await workspace.loadRepositorySnapshot({
      cloneUrl: pathToFileURL(fixture.origin).href,
      installationToken: 'installation-token',
      sourceBranch: 'source',
      productionBranch: 'production',
      sourceSha: fixture.sourceSha,
      productionSha: fixture.productionSha,
    })

    expect(snapshot).toMatchObject({
      sourceSha: fixture.sourceSha,
      productionSha: fixture.productionSha,
      mergeBaseSha: fixture.productionSha,
      firstParentShas: [
        fixture.linearSha,
        fixture.mergeSha,
        fixture.rebasedFirstSha,
        fixture.rebasedSecondSha,
      ],
    })
    expect(snapshot.commits.map((commit) => commit.sha)).toEqual([
      fixture.linearSha,
      fixture.topicFirstSha,
      fixture.topicSecondSha,
      fixture.mergeSha,
      fixture.rebasedFirstSha,
      fixture.rebasedSecondSha,
    ])
    expect(snapshot.integrationWindows).toEqual([
      expect.objectContaining({
        integrationSha: fixture.linearSha,
        firstParentSha: fixture.productionSha,
        secondParentSha: null,
        commitShas: [fixture.linearSha],
      }),
      expect.objectContaining({
        integrationSha: fixture.mergeSha,
        firstParentSha: fixture.linearSha,
        secondParentSha: fixture.topicSecondSha,
        commitShas: [fixture.topicFirstSha, fixture.topicSecondSha, fixture.mergeSha],
        introducedCommitShas: [fixture.topicFirstSha, fixture.topicSecondSha],
      }),
      expect.objectContaining({
        integrationSha: fixture.rebasedFirstSha,
        firstParentSha: fixture.mergeSha,
        secondParentSha: null,
        commitShas: [fixture.rebasedFirstSha],
      }),
      expect.objectContaining({
        integrationSha: fixture.rebasedSecondSha,
        firstParentSha: fixture.rebasedFirstSha,
        secondParentSha: null,
        commitShas: [fixture.rebasedSecondSha],
      }),
    ])
    expect(
      snapshot.commits.map((commit) => [
        commit.sha,
        commit.firstParentPosition,
        commit.integrationPointSha,
      ]),
    ).toEqual([
      [fixture.linearSha, 0, fixture.linearSha],
      [fixture.topicFirstSha, null, fixture.mergeSha],
      [fixture.topicSecondSha, null, fixture.mergeSha],
      [fixture.mergeSha, 1, fixture.mergeSha],
      [fixture.rebasedFirstSha, 2, fixture.rebasedFirstSha],
      [fixture.rebasedSecondSha, 3, fixture.rebasedSecondSha],
    ])
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

async function createTopologyFixture(): Promise<{
  readonly root: string
  readonly origin: string
  readonly productionSha: string
  readonly linearSha: string
  readonly topicFirstSha: string
  readonly topicSecondSha: string
  readonly mergeSha: string
  readonly rebasedFirstSha: string
  readonly rebasedSecondSha: string
  readonly sourceSha: string
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'shipgate-git-topology-test-'))
  roots.push(root)
  const repository = path.join(root, 'repository')
  const origin = path.join(root, 'origin.git')
  await mkdir(repository)
  await git(['init', repository])
  await git(['-C', repository, 'config', 'user.name', 'Shipgate Test'])
  await git(['-C', repository, 'config', 'user.email', 'shipgate@example.test'])
  await writeFile(path.join(repository, 'base.txt'), 'production\n')
  await git(['-C', repository, 'add', 'base.txt'])
  await git(['-C', repository, 'commit', '-m', 'production'])
  const productionSha = await revParse(repository, 'HEAD')
  await git(['-C', repository, 'branch', 'production', productionSha])
  await git(['-C', repository, 'checkout', '-b', 'source'])
  await writeFile(path.join(repository, 'linear.txt'), 'linear\n')
  await git(['-C', repository, 'add', 'linear.txt'])
  await git(['-C', repository, 'commit', '-m', 'linear integration'])
  const linearSha = await revParse(repository, 'HEAD')
  await git(['-C', repository, 'checkout', '-b', 'topic'])
  await writeFile(path.join(repository, 'topic-1.txt'), 'topic one\n')
  await git(['-C', repository, 'add', 'topic-1.txt'])
  await git(['-C', repository, 'commit', '-m', 'topic one'])
  const topicFirstSha = await revParse(repository, 'HEAD')
  await writeFile(path.join(repository, 'topic-2.txt'), 'topic two\n')
  await git(['-C', repository, 'add', 'topic-2.txt'])
  await git(['-C', repository, 'commit', '-m', 'topic two'])
  const topicSecondSha = await revParse(repository, 'HEAD')
  await git(['-C', repository, 'checkout', 'source'])
  await git(['-C', repository, 'merge', '--no-ff', 'topic', '-m', 'merge topic'])
  const mergeSha = await revParse(repository, 'HEAD')
  await writeFile(path.join(repository, 'rebase-1.txt'), 'rebased one\n')
  await git(['-C', repository, 'add', 'rebase-1.txt'])
  await git(['-C', repository, 'commit', '-m', 'rebased one'])
  const rebasedFirstSha = await revParse(repository, 'HEAD')
  await writeFile(path.join(repository, 'rebase-2.txt'), 'rebased two\n')
  await git(['-C', repository, 'add', 'rebase-2.txt'])
  await git(['-C', repository, 'commit', '-m', 'rebased two'])
  const rebasedSecondSha = await revParse(repository, 'HEAD')
  const sourceSha = rebasedSecondSha
  await git(['init', '--bare', origin])
  await git(['-C', repository, 'remote', 'add', 'origin', pathToFileURL(origin).href])
  await git([
    '-C',
    repository,
    'push',
    'origin',
    'production:refs/heads/production',
    'source:refs/heads/source',
  ])

  return {
    root,
    origin,
    productionSha,
    linearSha,
    topicFirstSha,
    topicSecondSha,
    mergeSha,
    rebasedFirstSha,
    rebasedSecondSha,
    sourceSha,
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
