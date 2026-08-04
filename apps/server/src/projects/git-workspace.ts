import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { ProjectConfigurationValidationError } from './errors.js'

const execFileAsync = promisify(execFile)
const gitOutputLimitBytes = 256 * 1024
const defaultGitTimeoutMs = 120_000

export interface GitWorkspaceAncestryInput {
  readonly cloneUrl: string
  readonly installationToken: string
  readonly sourceBranch: string
  readonly productionBranch: string
  readonly sourceSha: string
  readonly productionSha: string
}

export interface ReadOnlyGitWorkspace {
  assertProductionAncestor(input: GitWorkspaceAncestryInput): Promise<void>
}

export function createReadOnlyGitWorkspace(
  options: {
    readonly gitCommand?: string
    readonly timeoutMs?: number
    readonly temporaryRoot?: string
    readonly allowFileProtocol?: boolean
  } = {},
): ReadOnlyGitWorkspace {
  const gitCommand = options.gitCommand ?? 'git'
  const timeoutMs = options.timeoutMs ?? defaultGitTimeoutMs
  const temporaryRoot = options.temporaryRoot ?? tmpdir()
  const allowFileProtocol = options.allowFileProtocol ?? false

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('Git workspace timeout must be a positive safe integer')
  }

  return {
    async assertProductionAncestor(input) {
      assertSha(input.sourceSha, 'source SHA')
      assertSha(input.productionSha, 'production SHA')
      const cloneUrl = normalizeCloneUrl(input.cloneUrl, allowFileProtocol)
      const workspace = await mkdtemp(path.join(temporaryRoot, 'shipgate-git-'))

      try {
        await chmod(workspace, 0o700)
        await runGit(gitCommand, ['init', '--bare', workspace], {
          timeoutMs,
        })
        await assertBranchNameWithGit(gitCommand, workspace, input.sourceBranch, timeoutMs)
        await assertBranchNameWithGit(gitCommand, workspace, input.productionBranch, timeoutMs)
        await runGit(gitCommand, ['-C', workspace, 'remote', 'add', 'origin', cloneUrl], {
          timeoutMs,
        })

        const authenticatedEnvironment = createAuthenticatedGitEnvironment(input.installationToken)

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
            environment: authenticatedEnvironment,
          },
        )

        const fetchedSourceSha = await readCommitSha(
          gitCommand,
          workspace,
          'refs/shipgate/source',
          timeoutMs,
        )
        const fetchedProductionSha = await readCommitSha(
          gitCommand,
          workspace,
          'refs/shipgate/production',
          timeoutMs,
        )

        if (fetchedSourceSha !== input.sourceSha || fetchedProductionSha !== input.productionSha) {
          throw new ProjectConfigurationValidationError(
            'repository_state_changed',
            'GitHub branch heads changed while release topology was being verified',
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

        const ancestry = await runGitWithStatus(
          gitCommand,
          ['-C', workspace, 'merge-base', '--is-ancestor', input.productionSha, input.sourceSha],
          {
            timeoutMs,
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
      } finally {
        await rm(workspace, {
          recursive: true,
          force: true,
          maxRetries: 3,
        })
      }
    },
  }
}

async function assertBranchNameWithGit(
  gitCommand: string,
  workspace: string,
  branch: string,
  timeoutMs: number,
): Promise<void> {
  const result = await runGitWithStatus(
    gitCommand,
    ['-C', workspace, 'check-ref-format', '--branch', branch],
    { timeoutMs },
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
): Promise<string> {
  const result = await runGit(
    gitCommand,
    ['-C', workspace, 'rev-parse', '--verify', `${ref}^{commit}`],
    { timeoutMs },
  )
  const sha = result.stdout.trim()

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
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`,
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
  options: {
    readonly timeoutMs: number
    readonly environment?: NodeJS.ProcessEnv
  },
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await runGitWithStatus(command, args, options)

  if (result.exitCode !== 0) {
    throw createGitWorkspaceFailure('Git workspace command failed', result.stderr)
  }

  return result
}

async function runGitWithStatus(
  command: string,
  args: readonly string[],
  options: {
    readonly timeoutMs: number
    readonly environment?: NodeJS.ProcessEnv
  },
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

function isExecFileError(value: unknown): value is {
  readonly code?: number | string
  readonly stdout?: string
  readonly stderr?: string
} {
  return typeof value === 'object' && value !== null
}
