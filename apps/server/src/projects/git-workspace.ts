import { Buffer } from 'node:buffer'
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

import { ProjectConfigurationValidationError } from './errors.js'

const execFileAsync = promisify(execFile)
const gitOutputLimitBytes = 8 * 1024 * 1024
const defaultGitTimeoutMs = 120_000
const defaultMaximumCommitCount = 10_000

export interface GitWorkspaceAncestryInput {
  readonly cloneUrl: string
  readonly installationToken: string
  readonly sourceBranch: string
  readonly productionBranch: string
  readonly sourceSha: string
  readonly productionSha: string
  readonly signal?: AbortSignal | undefined
}

export interface GitRepositoryCommit {
  readonly sha: string
  readonly treeSha: string
  readonly message: string
  readonly authorName: string | null
  readonly authorEmail: string | null
  readonly authoredAt: Date | null
  readonly committerName: string | null
  readonly committerEmail: string | null
  readonly committedAt: Date
  readonly parentShas: readonly string[]
  readonly sourceDeltaPosition: number | null
  readonly firstParentPosition: number | null
  readonly integrationPointSha: string | null
  readonly productionPatchEquivalent: boolean
}

export interface GitIntegrationWindow {
  readonly integrationSha: string
  readonly firstParentSha: string
  readonly secondParentSha: string | null
  readonly firstParentPosition: number
  readonly commitShas: readonly string[]
  readonly introducedCommitShas: readonly string[]
}

export interface GitRepositorySnapshot {
  readonly sourceSha: string
  readonly productionSha: string
  readonly mergeBaseSha: string
  readonly firstParentShas: readonly string[]
  readonly integrationWindows: readonly GitIntegrationWindow[]
  readonly commits: readonly GitRepositoryCommit[]
}

export interface GitAncestryWorkspace {
  assertProductionAncestor(input: GitWorkspaceAncestryInput): Promise<void>
}

export interface ReadOnlyGitWorkspace extends GitAncestryWorkspace {
  loadRepositorySnapshot(input: GitWorkspaceAncestryInput): Promise<GitRepositorySnapshot>
}

export function createReadOnlyGitWorkspace(
  options: {
    readonly gitCommand?: string
    readonly timeoutMs?: number
    readonly temporaryRoot?: string
    readonly allowFileProtocol?: boolean
    readonly maximumCommitCount?: number
  } = {},
): ReadOnlyGitWorkspace {
  const gitCommand = options.gitCommand ?? 'git'
  const timeoutMs = options.timeoutMs ?? defaultGitTimeoutMs
  const temporaryRoot = options.temporaryRoot ?? tmpdir()
  const allowFileProtocol = options.allowFileProtocol ?? false
  const maximumCommitCount = options.maximumCommitCount ?? defaultMaximumCommitCount

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Git workspace timeout must be a positive safe integer')
  }

  if (!Number.isSafeInteger(maximumCommitCount) || maximumCommitCount <= 0) {
    throw new TypeError('Git workspace commit limit must be a positive safe integer')
  }

  const withFetchedWorkspace = async <Result>(
    input: GitWorkspaceAncestryInput,
    callback: (input: {
      readonly workspace: string
      readonly fetchedSourceSha: string
      readonly fetchedProductionSha: string
    }) => Promise<Result>,
  ): Promise<Result> => {
    assertSha(input.sourceSha, 'source SHA')
    assertSha(input.productionSha, 'production SHA')
    const cloneUrl = normalizeCloneUrl(input.cloneUrl, allowFileProtocol)
    const workspace = await mkdtemp(path.join(temporaryRoot, 'shipgate-git-'))

    try {
      await chmod(workspace, 0o700)
      await runGit(gitCommand, ['init', '--bare', workspace], {
        timeoutMs,
        signal: input.signal,
      })
      await assertBranchNameWithGit(
        gitCommand,
        workspace,
        input.sourceBranch,
        timeoutMs,
        input.signal,
      )
      await assertBranchNameWithGit(
        gitCommand,
        workspace,
        input.productionBranch,
        timeoutMs,
        input.signal,
      )
      await runGit(gitCommand, ['-C', workspace, 'remote', 'add', 'origin', cloneUrl], {
        timeoutMs,
        signal: input.signal,
      })

      await runGit(
        gitCommand,
        [
          '-C',
          workspace,
          'fetch',
          '--no-tags',
          '--filter=blob:none',
          '--force',
          'origin',
          `+refs/heads/${input.sourceBranch}:refs/shipgate/source`,
          `+refs/heads/${input.productionBranch}:refs/shipgate/production`,
        ],
        {
          timeoutMs,
          signal: input.signal,
          environment: createAuthenticatedGitEnvironment(input.installationToken),
        },
      )

      const fetchedSourceSha = await readCommitSha(
        gitCommand,
        workspace,
        'refs/shipgate/source',
        timeoutMs,
        input.signal,
      )
      const fetchedProductionSha = await readCommitSha(
        gitCommand,
        workspace,
        'refs/shipgate/production',
        timeoutMs,
        input.signal,
      )

      if (fetchedSourceSha !== input.sourceSha || fetchedProductionSha !== input.productionSha) {
        throw new ProjectConfigurationValidationError(
          'repository_state_changed',
          'GitHub branch heads changed while the read-only workspace was being fetched',
          {
            details: {
              expectedSourceSha: input.sourceSha,
              fetchedSourceSha,
              expectedProductionSha: input.productionSha,
              fetchedProductionSha,
            },
          },
        )
      }

      return await callback({ workspace, fetchedSourceSha, fetchedProductionSha })
    } finally {
      await rm(workspace, {
        recursive: true,
        force: true,
        maxRetries: 3,
      })
    }
  }

  return {
    async assertProductionAncestor(input) {
      await withFetchedWorkspace(input, async ({ workspace }) => {
        await assertAncestry(gitCommand, workspace, input, timeoutMs)
      })
    },

    async loadRepositorySnapshot(input) {
      return withFetchedWorkspace(
        input,
        async ({ workspace, fetchedSourceSha, fetchedProductionSha }) => {
          await assertAncestry(gitCommand, workspace, input, timeoutMs)
          const deltaShas = await readSourceDelta(
            gitCommand,
            workspace,
            input.productionSha,
            input.sourceSha,
            timeoutMs,
            maximumCommitCount,
            input.signal,
          )
          const baseCommits: GitRepositoryCommit[] = []

          if (deltaShas.length === 0) {
            baseCommits.push(
              await readCommit(
                gitCommand,
                workspace,
                input.sourceSha,
                null,
                timeoutMs,
                input.signal,
              ),
            )
          } else {
            for (const [position, sha] of deltaShas.entries()) {
              baseCommits.push(
                await readCommit(gitCommand, workspace, sha, position, timeoutMs, input.signal),
              )
            }
          }

          const mergeBaseSha = await readMergeBase(
            gitCommand,
            workspace,
            input.productionSha,
            input.sourceSha,
            timeoutMs,
            input.signal,
          )
          const firstParentShas = await readFirstParentHistory(
            gitCommand,
            workspace,
            input.productionSha,
            input.sourceSha,
            timeoutMs,
            input.signal,
          )
          const integrationWindows = await readIntegrationWindows({
            gitCommand,
            workspace,
            productionSha: input.productionSha,
            deltaShas,
            firstParentShas,
            commits: baseCommits,
            timeoutMs,
            signal: input.signal,
          })
          const productionEquivalentShas = await readProductionPatchEquivalence({
            gitCommand,
            workspace,
            productionSha: input.productionSha,
            sourceSha: input.sourceSha,
            firstParentShas,
            commits: baseCommits,
            timeoutMs,
            maximumCommitCount,
            signal: input.signal,
            environment: createAuthenticatedGitEnvironment(input.installationToken),
          })
          const firstParentPositions = new Map(
            firstParentShas.map((sha, position) => [sha, position] as const),
          )
          const integrationByCommit = new Map<string, string>()

          for (const window of integrationWindows) {
            for (const sha of window.commitShas) {
              if (integrationByCommit.has(sha)) {
                throw createGitWorkspaceFailure(
                  `Commit ${sha} belongs to multiple first-parent integration windows`,
                )
              }

              integrationByCommit.set(sha, window.integrationSha)
            }
          }

          const commits = baseCommits.map(
            (commit): GitRepositoryCommit => ({
              ...commit,
              firstParentPosition: firstParentPositions.get(commit.sha) ?? null,
              integrationPointSha:
                commit.sourceDeltaPosition === null
                  ? null
                  : (integrationByCommit.get(commit.sha) ?? null),
              productionPatchEquivalent: productionEquivalentShas.has(commit.sha),
            }),
          )

          if (deltaShas.some((sha) => !integrationByCommit.has(sha))) {
            throw createGitWorkspaceFailure(
              'The first-parent integration windows do not cover the complete source delta',
            )
          }

          return {
            sourceSha: fetchedSourceSha,
            productionSha: fetchedProductionSha,
            mergeBaseSha,
            firstParentShas,
            integrationWindows,
            commits,
          }
        },
      )
    },
  }
}

async function assertAncestry(
  gitCommand: string,
  workspace: string,
  input: GitWorkspaceAncestryInput,
  timeoutMs: number,
): Promise<void> {
  const ancestry = await runGitWithStatus(
    gitCommand,
    ['-C', workspace, 'merge-base', '--is-ancestor', input.productionSha, input.sourceSha],
    {
      timeoutMs,
      signal: input.signal,
    },
  )

  if (ancestry.exitCode === 1) {
    throw new ProjectConfigurationValidationError(
      'production_branch_not_ancestor',
      'Production branch is not an ancestor of source branch',
      {
        details: {
          sourceBranch: input.sourceBranch,
          sourceSha: input.sourceSha,
          productionBranch: input.productionBranch,
          productionSha: input.productionSha,
        },
      },
    )
  }

  if (ancestry.exitCode !== 0) {
    throw createGitWorkspaceFailure('git merge-base failed', ancestry.stderr)
  }
}

async function readSourceDelta(
  gitCommand: string,
  workspace: string,
  productionSha: string,
  sourceSha: string,
  timeoutMs: number,
  maximumCommitCount: number,
  signal: AbortSignal | undefined,
): Promise<readonly string[]> {
  if (productionSha === sourceSha) {
    return []
  }

  const result = await runGit(
    gitCommand,
    ['-C', workspace, 'rev-list', '--reverse', '--topo-order', `${productionSha}..${sourceSha}`],
    { timeoutMs, signal },
  )
  const shas = result.stdout
    .split('\n')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0)

  if (shas.length > maximumCommitCount) {
    throw new ProjectConfigurationValidationError(
      'external_state_unknown',
      `Repository source delta exceeds the ${maximumCommitCount} commit safety limit`,
      { details: { commitCount: shas.length, maximumCommitCount } },
    )
  }

  for (const sha of shas) {
    assertSha(sha, 'source delta commit SHA')
  }

  if (shas.at(-1) !== sourceSha) {
    throw createGitWorkspaceFailure('Source head is not the final commit in the Git range')
  }

  return shas
}

async function readMergeBase(
  gitCommand: string,
  workspace: string,
  productionSha: string,
  sourceSha: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const result = await runGit(
    gitCommand,
    ['-C', workspace, 'merge-base', productionSha, sourceSha],
    { timeoutMs, signal },
  )
  const mergeBaseSha = result.stdout.trim().toLowerCase()

  assertSha(mergeBaseSha, 'merge base SHA')

  return mergeBaseSha
}

async function readFirstParentHistory(
  gitCommand: string,
  workspace: string,
  productionSha: string,
  sourceSha: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<readonly string[]> {
  if (productionSha === sourceSha) {
    return []
  }

  const result = await runGit(
    gitCommand,
    ['-C', workspace, 'rev-list', '--first-parent', '--reverse', `${productionSha}..${sourceSha}`],
    { timeoutMs, signal },
  )

  return parseShaLines(result.stdout, 'first-parent commit SHA')
}

async function readIntegrationWindows(input: {
  readonly gitCommand: string
  readonly workspace: string
  readonly productionSha: string
  readonly deltaShas: readonly string[]
  readonly firstParentShas: readonly string[]
  readonly commits: readonly GitRepositoryCommit[]
  readonly timeoutMs: number
  readonly signal: AbortSignal | undefined
}): Promise<readonly GitIntegrationWindow[]> {
  if (input.deltaShas.length === 0) {
    return []
  }

  const deltaSet = new Set(input.deltaShas)
  const commits = new Map(input.commits.map((commit) => [commit.sha, commit] as const))
  const assigned = new Set<string>()
  const windows: GitIntegrationWindow[] = []

  for (const [firstParentPosition, integrationSha] of input.firstParentShas.entries()) {
    const integration = commits.get(integrationSha)

    if (integration === undefined) {
      throw createGitWorkspaceFailure(
        `First-parent integration commit ${integrationSha} is outside the source delta`,
      )
    }

    if (integration.sourceDeltaPosition === null) {
      throw createGitWorkspaceFailure(
        `First-parent integration commit ${integrationSha} is outside the source delta`,
      )
    }

    const firstParentSha = integration.parentShas[0]

    if (!firstParentSha) {
      throw createGitWorkspaceFailure(
        `First-parent integration commit ${integrationSha} has no first parent`,
      )
    }

    const secondParentSha = integration.parentShas[1] ?? null
    const windowResult = await runGit(
      input.gitCommand,
      [
        '-C',
        input.workspace,
        'rev-list',
        '--reverse',
        '--topo-order',
        `${firstParentSha}..${integrationSha}`,
      ],
      { timeoutMs: input.timeoutMs, signal: input.signal },
    )
    const windowShas = parseShaLines(windowResult.stdout, 'integration-window commit SHA').filter(
      (sha) => deltaSet.has(sha) && !assigned.has(sha),
    )

    if (!windowShas.includes(integrationSha)) {
      windowShas.push(integrationSha)
    }

    const introducedCommitShas = secondParentSha
      ? await readIntroducedCommits({
          gitCommand: input.gitCommand,
          workspace: input.workspace,
          firstParentSha,
          secondParentSha,
          timeoutMs: input.timeoutMs,
          signal: input.signal,
        })
      : []

    for (const sha of windowShas) {
      assigned.add(sha)
    }

    windows.push({
      integrationSha,
      firstParentSha,
      secondParentSha,
      firstParentPosition,
      commitShas: windowShas,
      introducedCommitShas,
    })
  }

  const unassigned = input.deltaShas.filter((sha) => !assigned.has(sha))

  if (unassigned.length > 0) {
    throw createGitWorkspaceFailure(
      `Source commits are outside every first-parent integration window: ${unassigned.join(', ')}`,
    )
  }

  return windows
}

async function readIntroducedCommits(input: {
  readonly gitCommand: string
  readonly workspace: string
  readonly firstParentSha: string
  readonly secondParentSha: string
  readonly timeoutMs: number
  readonly signal: AbortSignal | undefined
}): Promise<readonly string[]> {
  const result = await runGit(
    input.gitCommand,
    [
      '-C',
      input.workspace,
      'rev-list',
      '--reverse',
      '--topo-order',
      `${input.firstParentSha}..${input.secondParentSha}`,
    ],
    { timeoutMs: input.timeoutMs, signal: input.signal },
  )

  return parseShaLines(result.stdout, 'introduced commit SHA')
}

async function readProductionPatchEquivalence(input: {
  readonly gitCommand: string
  readonly workspace: string
  readonly productionSha: string
  readonly sourceSha: string
  readonly firstParentShas: readonly string[]
  readonly commits: readonly GitRepositoryCommit[]
  readonly timeoutMs: number
  readonly maximumCommitCount: number
  readonly signal: AbortSignal | undefined
  readonly environment: NodeJS.ProcessEnv
}): Promise<ReadonlySet<string>> {
  if (input.productionSha === input.sourceSha || input.firstParentShas.length === 0) {
    return new Set()
  }

  /*
   * `git cherry` drops production commits once production is merged back into source because
   * those commits are then reachable from both refs. Compare explicit stable patch IDs instead.
   */
  const firstIntegrationSha = input.firstParentShas[0]
  const firstIntegration = input.commits.find((commit) => commit.sha === firstIntegrationSha)
  const sourceBaselineSha = firstIntegration?.parentShas[0]

  if (!firstIntegration || !sourceBaselineSha) {
    throw createGitWorkspaceFailure(
      'Unable to determine the source baseline for production patch comparison',
    )
  }

  const comparisonBaseSha = await readMergeBase(
    input.gitCommand,
    input.workspace,
    input.productionSha,
    sourceBaselineSha,
    input.timeoutMs,
    input.signal,
  )
  const productionRange = `${comparisonBaseSha}..${input.productionSha}`
  const productionCommitCount = await countNonMergeCommits(
    input.gitCommand,
    input.workspace,
    productionRange,
    input.timeoutMs,
    input.signal,
  )

  if (productionCommitCount > input.maximumCommitCount) {
    throw new ProjectConfigurationValidationError(
      'external_state_unknown',
      `Production patch comparison exceeds the ${input.maximumCommitCount} commit safety limit`,
      {
        details: {
          commitCount: productionCommitCount,
          maximumCommitCount: input.maximumCommitCount,
          comparisonBaseSha,
          productionSha: input.productionSha,
        },
      },
    )
  }

  if (productionCommitCount === 0) {
    return new Set()
  }

  const productionPatchIds = await readStablePatchIdsForRange({
    ...input,
    range: productionRange,
  })
  const sourcePatchIds = await readStablePatchIdsForRange({
    ...input,
    range: `${input.productionSha}..${input.sourceSha}`,
  })
  const productionPatchIdSet = new Set(productionPatchIds.values())
  const equivalents = new Set<string>()

  for (const [commitSha, patchId] of sourcePatchIds) {
    if (productionPatchIdSet.has(patchId)) {
      equivalents.add(commitSha)
    }
  }

  return equivalents
}

async function countNonMergeCommits(
  gitCommand: string,
  workspace: string,
  range: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<number> {
  const result = await runGit(
    gitCommand,
    ['-C', workspace, 'rev-list', '--count', '--no-merges', range],
    { timeoutMs, signal },
  )
  const count = Number(result.stdout.trim())

  if (!Number.isSafeInteger(count) || count < 0) {
    throw createGitWorkspaceFailure(`Git returned an invalid commit count for ${range}`)
  }

  return count
}

async function readStablePatchIdsForRange(input: {
  readonly gitCommand: string
  readonly workspace: string
  readonly range: string
  readonly timeoutMs: number
  readonly signal: AbortSignal | undefined
  readonly environment: NodeJS.ProcessEnv
}): Promise<ReadonlyMap<string, string>> {
  if (input.signal?.aborted) {
    throw input.signal.reason instanceof Error
      ? input.signal.reason
      : new Error('Git workspace operation was aborted')
  }

  const environment = {
    ...process.env,
    ...input.environment,
  }
  const logProcess = spawn(
    input.gitCommand,
    [
      '-C',
      input.workspace,
      'log',
      '--no-merges',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--full-index',
      '--binary',
      '--diff-algorithm=myers',
      '--pretty=format:commit %H',
      '--patch',
      input.range,
    ],
    {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  const patchIdProcess = spawn(input.gitCommand, ['-C', input.workspace, 'patch-id', '--stable'], {
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  if (
    !logProcess.stdout ||
    !logProcess.stderr ||
    !patchIdProcess.stdin ||
    !patchIdProcess.stdout ||
    !patchIdProcess.stderr
  ) {
    terminateChildProcess(logProcess)
    terminateChildProcess(patchIdProcess)
    throw createGitWorkspaceFailure('Unable to create the Git patch-id comparison pipeline')
  }

  let timedOut = false
  const terminate = () => {
    terminateChildProcess(logProcess)
    terminateChildProcess(patchIdProcess)
  }
  const timeout = setTimeout(() => {
    timedOut = true
    terminate()
  }, input.timeoutMs)
  timeout.unref()
  const abort = () => terminate()
  input.signal?.addEventListener('abort', abort, { once: true })

  const logExit = waitForChildProcess(logProcess)
  const patchIdExit = waitForChildProcess(patchIdProcess)
  const pipeResult = pipeline(logProcess.stdout, patchIdProcess.stdin).then(
    () => undefined,
    (error: unknown) => error,
  )

  try {
    const [logExitCode, patchIdExitCode, output, logStderr, patchIdStderr, pipeError] =
      await Promise.all([
        logExit,
        patchIdExit,
        collectChildOutput(patchIdProcess.stdout, 'Git patch-id output'),
        collectChildOutput(logProcess.stderr, 'Git log stderr'),
        collectChildOutput(patchIdProcess.stderr, 'Git patch-id stderr'),
        pipeResult,
      ])

    if (input.signal?.aborted) {
      throw input.signal.reason instanceof Error
        ? input.signal.reason
        : new Error('Git workspace operation was aborted')
    }

    if (timedOut) {
      throw createGitWorkspaceFailure('Git patch-id comparison timed out')
    }

    if (logExitCode !== 0) {
      throw createGitWorkspaceFailure('Git log failed during patch-id comparison', logStderr)
    }

    if (patchIdExitCode !== 0) {
      throw createGitWorkspaceFailure(
        'Git patch-id failed during production comparison',
        patchIdStderr,
      )
    }

    if (pipeError !== undefined) {
      throw createGitWorkspaceFailure('Git patch-id pipeline failed', undefined, pipeError)
    }

    return parseStablePatchIds(output)
  } catch (error) {
    terminate()

    if (input.signal?.aborted) {
      throw input.signal.reason instanceof Error
        ? input.signal.reason
        : new Error('Git workspace operation was aborted')
    }

    if (timedOut) {
      throw createGitWorkspaceFailure('Git patch-id comparison timed out')
    }

    throw error
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener('abort', abort)
  }
}

function parseStablePatchIds(value: string): ReadonlyMap<string, string> {
  const patchIds = new Map<string, string>()

  for (const line of value.split('\n')) {
    const trimmed = line.trim()

    if (trimmed.length === 0) {
      continue
    }

    const match = /^([0-9a-f]{40,64})\s+([0-9a-f]{40,64})$/i.exec(trimmed)

    if (!match?.[1] || !match[2]) {
      throw createGitWorkspaceFailure(`Git returned an invalid patch-id record: ${trimmed}`)
    }

    const patchId = match[1].toLowerCase()
    const commitSha = match[2].toLowerCase()
    assertSha(patchId, 'stable patch ID')
    assertSha(commitSha, 'patch-id commit SHA')

    const existing = patchIds.get(commitSha)

    if (existing !== undefined && existing !== patchId) {
      throw createGitWorkspaceFailure(`Git returned conflicting patch IDs for commit ${commitSha}`)
    }

    patchIds.set(commitSha, patchId)
  }

  return patchIds
}

async function collectChildOutput(stream: Readable, name: string): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    size += chunk.length

    if (size > gitOutputLimitBytes) {
      throw createGitWorkspaceFailure(`${name} exceeded the ${gitOutputLimitBytes} byte limit`)
    }

    chunks.push(chunk)
  }

  return Buffer.concat(chunks, size).toString('utf8')
}

function waitForChildProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode) => resolve(exitCode))
  })
}

function terminateChildProcess(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
  }
}

function parseShaLines(value: string, name: string): string[] {
  const shas = value
    .split('\n')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0)

  for (const sha of shas) {
    assertSha(sha, name)
  }

  return shas
}

async function readCommit(
  gitCommand: string,
  workspace: string,
  sha: string,
  sourceDeltaPosition: number | null,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<GitRepositoryCommit> {
  const result = await runGit(
    gitCommand,
    [
      '-C',
      workspace,
      'show',
      '--no-patch',
      '--format=%H%x00%T%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B',
      sha,
    ],
    { timeoutMs, signal },
  )
  const parts = result.stdout.split('\0')

  if (parts.length < 10) {
    throw createGitWorkspaceFailure(`Git returned incomplete metadata for commit ${sha}`)
  }

  const [
    actualSha,
    treeSha,
    parentList,
    authorName,
    authorEmail,
    authoredAt,
    committerName,
    committerEmail,
    committedAt,
  ] = parts
  const message = parts.slice(9).join('\0').trimEnd()

  if (!actualSha || !treeSha || parentList === undefined || !committedAt) {
    throw createGitWorkspaceFailure(`Git returned invalid metadata for commit ${sha}`)
  }

  assertSha(actualSha, 'commit SHA')
  assertSha(treeSha, 'commit tree SHA')
  const parentShas = parentList.length === 0 ? [] : parentList.split(' ')

  for (const parentSha of parentShas) {
    assertSha(parentSha, 'commit parent SHA')
  }

  return {
    sha: actualSha.toLowerCase(),
    treeSha: treeSha.toLowerCase(),
    message,
    authorName: nullableText(authorName),
    authorEmail: nullableText(authorEmail),
    authoredAt: parseNullableDate(authoredAt, `authored time for ${sha}`),
    committerName: nullableText(committerName),
    committerEmail: nullableText(committerEmail),
    committedAt: parseRequiredDate(committedAt, `committed time for ${sha}`),
    parentShas: parentShas.map((parentSha) => parentSha.toLowerCase()),
    sourceDeltaPosition,
    firstParentPosition: null,
    integrationPointSha: null,
    productionPatchEquivalent: false,
  }
}

async function assertBranchNameWithGit(
  gitCommand: string,
  workspace: string,
  branch: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const result = await runGitWithStatus(
    gitCommand,
    ['-C', workspace, 'check-ref-format', '--branch', branch],
    { timeoutMs, signal },
  )

  if (result.exitCode !== 0) {
    throw new ProjectConfigurationValidationError(
      'invalid_branch_name',
      `Invalid Git branch name: ${branch}`,
    )
  }
}

async function readCommitSha(
  gitCommand: string,
  workspace: string,
  ref: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const result = await runGit(
    gitCommand,
    ['-C', workspace, 'rev-parse', '--verify', `${ref}^{commit}`],
    { timeoutMs, signal },
  )
  const sha = result.stdout.trim().toLowerCase()

  assertSha(sha, `fetched ${ref} SHA`)

  return sha
}

function createAuthenticatedGitEnvironment(token: string): NodeJS.ProcessEnv {
  if (token.length === 0 || token.includes('\r') || token.includes('\n') || token.includes('\0')) {
    throw new TypeError('GitHub installation token is invalid')
  }

  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    SSH_ASKPASS: '/bin/false',
    GCM_INTERACTIVE: 'Never',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(
      `x-access-token:${token}`,
      'utf8',
    ).toString('base64')}`,
    GIT_CONFIG_KEY_1: 'protocol.version',
    GIT_CONFIG_VALUE_1: '2',
  }
}

function normalizeCloneUrl(value: string, allowFileProtocol: boolean): string {
  let url: URL

  try {
    url = new URL(value)
  } catch (cause) {
    throw createGitWorkspaceFailure('GitHub clone URL is invalid', undefined, cause)
  }

  const allowed = url.protocol === 'https:' || (allowFileProtocol && url.protocol === 'file:')

  if (!allowed || url.username || url.password || url.search || url.hash) {
    throw createGitWorkspaceFailure('GitHub clone URL is not a safe read-only remote')
  }

  return url.href
}

async function runGit(
  command: string,
  args: readonly string[],
  options: GitExecutionOptions,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await runGitWithStatus(command, args, options)

  if (result.exitCode !== 0) {
    throw createGitWorkspaceFailure('Git workspace command failed', result.stderr)
  }

  return result
}

interface GitExecutionOptions {
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
  readonly environment?: NodeJS.ProcessEnv
}

async function runGitWithStatus(
  command: string,
  args: readonly string[],
  options: GitExecutionOptions,
): Promise<{
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}> {
  try {
    const result = await execFileAsync(command, [...args], {
      env: {
        ...process.env,
        ...options.environment,
      },
      timeout: options.timeoutMs,
      signal: options.signal,
      maxBuffer: gitOutputLimitBytes,
      encoding: 'utf8',
      windowsHide: true,
    })

    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error('Git workspace operation was aborted')
    }

    if (!isExecFileError(error)) {
      throw createGitWorkspaceFailure('Unable to execute Git', undefined, error)
    }

    return {
      exitCode: typeof error.code === 'number' ? error.code : 2,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error.stderr === 'string' ? error.stderr : '',
    }
  }
}

function createGitWorkspaceFailure(
  message: string,
  stderr?: string,
  cause?: unknown,
): ProjectConfigurationValidationError {
  const safeStderr = stderr?.trim().slice(0, 2_000)

  return new ProjectConfigurationValidationError('external_state_unknown', message, {
    ...(safeStderr ? { details: { gitError: safeStderr } } : {}),
    ...(cause !== undefined ? { cause } : {}),
  })
}

function assertSha(value: string, name: string): void {
  if (!/^[0-9a-f]{40,64}$/.test(value)) {
    throw createGitWorkspaceFailure(`${name} is not a valid commit SHA`)
  }
}

function nullableText(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null
}

function parseNullableDate(value: string | undefined, name: string): Date | null {
  return value && value.length > 0 ? parseRequiredDate(value, name) : null
}

function parseRequiredDate(value: string, name: string): Date {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    throw createGitWorkspaceFailure(`${name} is invalid`)
  }

  return date
}

function isExecFileError(value: unknown): value is {
  readonly code?: number | string
  readonly stdout?: string
  readonly stderr?: string
} {
  return typeof value === 'object' && value !== null
}
