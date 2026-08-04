import { createHash } from 'node:crypto'

import type { InstallationGitHubClient } from '@shipgate/github'

import { ProjectConfigurationValidationError } from './errors.js'
import type { GitRepositorySnapshot } from './git-workspace.js'
import type {
  ChangeProjection,
  RepositoryCommitProjection,
  RepositorySyncIssueProjection,
} from './model.js'

const pageSize = 100
const maximumPages = 100

interface RepositoryIdentity {
  readonly ownerLogin: string
  readonly name: string
}

interface PullCandidate {
  readonly number: number
  readonly baseBranch: string
  readonly mergedAt: Date
}

interface CommitPullEvidence {
  readonly candidates: ReadonlySet<number>
  readonly contradictory: boolean
  readonly restCandidates: readonly number[]
  readonly graphCandidates: readonly number[]
}

interface AssociatedPullRequestsQuery {
  readonly repository: {
    readonly object: {
      readonly associatedPullRequests: {
        readonly nodes: readonly {
          readonly number: number
          readonly merged: boolean
          readonly mergedAt: string | null
          readonly baseRefName: string
        }[]
        readonly pageInfo: {
          readonly hasNextPage: boolean
          readonly endCursor: string | null
        }
      }
    } | null
  } | null
}

interface PullRequestCommitsQuery {
  readonly repository: {
    readonly pullRequest: {
      readonly commits: {
        readonly nodes: readonly { readonly commit: { readonly oid: string } }[]
        readonly pageInfo: {
          readonly hasNextPage: boolean
          readonly endCursor: string | null
        }
      }
    } | null
  } | null
}

interface PullMetadata {
  readonly githubPullRequestId: number
  readonly number: number
  readonly title: string
  readonly url: string | null
  readonly authorId: number | null
  readonly authorLogin: string | null
  readonly baseBranch: string
  readonly mergedAt: Date
  readonly finalHeadSha: string
  readonly mergeCommitSha: string | null
  readonly originalCommitShas: readonly string[]
}

interface AttributedPull {
  readonly change: ChangeProjection
  readonly managedCommitShas: readonly string[]
  readonly issues: readonly RepositorySyncIssueProjection[]
}

class PullAttributionConflict extends Error {
  readonly code: string
  readonly details: AttributionFailure['details']

  constructor(code: string, message: string, details: AttributionFailure['details']) {
    super(message)
    this.name = 'PullAttributionConflict'
    this.code = code
    this.details = details
  }
}

interface AttributionFailure {
  readonly code: string
  readonly message: string
  readonly commitShas: readonly string[]
  readonly details: Readonly<Record<string, string | number | boolean | readonly string[]>>
}

export async function attributePullRequestChanges(input: {
  readonly client: InstallationGitHubClient
  readonly repository: RepositoryIdentity
  readonly sourceBranch: string
  readonly git: GitRepositorySnapshot
  readonly commits: readonly RepositoryCommitProjection[]
}): Promise<{
  readonly commits: readonly RepositoryCommitProjection[]
  readonly changes: readonly ChangeProjection[]
  readonly issues: readonly RepositorySyncIssueProjection[]
}> {
  const deltaCommits = input.commits
    .filter((commit) => commit.sourceDeltaPosition !== null)
    .toSorted(compareCommitPosition)
  const commitBySha = new Map(deltaCommits.map((commit) => [commit.sha, commit] as const))
  const evidenceBySha = new Map<string, CommitPullEvidence>()
  const ambiguous = new Map<string, AttributionFailure>()
  const provisionalByPull = new Map<number, string[]>()

  for (const commit of deltaCommits) {
    const evidence = await loadCommitPullEvidence({
      client: input.client,
      repository: input.repository,
      sourceBranch: input.sourceBranch,
      commitSha: commit.sha,
    })
    evidenceBySha.set(commit.sha, evidence)

    const candidates = [...evidence.candidates]

    if (evidence.contradictory) {
      ambiguous.set(commit.sha, {
        code: 'github_pr_evidence_contradiction',
        message: `GitHub REST and GraphQL disagree about pull requests for commit ${commit.sha}`,
        commitShas: [commit.sha],
        details: {
          restCandidates: evidence.restCandidates.map(String),
          graphCandidates: evidence.graphCandidates.map(String),
        },
      })
      continue
    }

    if (candidates.length > 1) {
      ambiguous.set(commit.sha, {
        code: 'multiple_pull_request_candidates',
        message: `Commit ${commit.sha} is associated with multiple merged pull requests`,
        commitShas: [commit.sha],
        details: { pullRequestNumbers: candidates.map(String) },
      })
      continue
    }

    const pullNumber = candidates[0]

    if (pullNumber !== undefined) {
      const shas = provisionalByPull.get(pullNumber) ?? []
      shas.push(commit.sha)
      provisionalByPull.set(pullNumber, shas)
    }
  }

  const pullMetadata = new Map<number, PullMetadata>()

  for (const pullNumber of provisionalByPull.keys()) {
    try {
      pullMetadata.set(
        pullNumber,
        await loadPullMetadata({
          client: input.client,
          repository: input.repository,
          sourceBranch: input.sourceBranch,
          pullNumber,
        }),
      )
    } catch (error) {
      if (!(error instanceof PullAttributionConflict)) {
        throw error
      }

      const failure: AttributionFailure = {
        code: error.code,
        message: error.message,
        commitShas: provisionalByPull.get(pullNumber) ?? [],
        details: {
          pullRequestNumber: pullNumber,
          ...error.details,
        },
      }

      for (const sha of failure.commitShas) {
        ambiguous.set(sha, failure)
      }
    }
  }

  const proposals = new Map<number, AttributedPull>()
  const orderedPulls = [...pullMetadata.values()].toSorted(
    (left, right) =>
      left.mergedAt.getTime() - right.mergedAt.getTime() || left.number - right.number,
  )

  for (const pull of orderedPulls) {
    const provisionalShas = provisionalByPull.get(pull.number) ?? []
    const result = attributePull({
      pull,
      provisionalShas,
      git: input.git,
      commitBySha,
      evidenceBySha,
    })

    if ('code' in result) {
      for (const sha of result.commitShas) {
        ambiguous.set(sha, result)
      }
      continue
    }

    proposals.set(pull.number, result)
  }

  const pullNumbersByCommit = new Map<string, number[]>()

  for (const [pullNumber, proposal] of proposals) {
    for (const sha of proposal.managedCommitShas) {
      const owners = pullNumbersByCommit.get(sha) ?? []
      owners.push(pullNumber)
      pullNumbersByCommit.set(sha, owners)
    }
  }

  const invalidPulls = new Set<number>()

  for (const [sha, pullNumbers] of pullNumbersByCommit) {
    if (pullNumbers.length <= 1 && !ambiguous.has(sha)) {
      continue
    }

    const involvedPulls = new Set(pullNumbers)

    for (const pullNumber of involvedPulls) {
      invalidPulls.add(pullNumber)
    }

    const affectedShas = [...involvedPulls]
      .flatMap((pullNumber) => proposals.get(pullNumber)?.managedCommitShas ?? [])
      .filter((value, index, values) => values.indexOf(value) === index)
    const failure: AttributionFailure = {
      code: 'overlapping_pull_request_commit_sets',
      message: `Commit ${sha} belongs to overlapping or contradictory pull request commit sets`,
      commitShas: affectedShas,
      details: { pullRequestNumbers: [...involvedPulls].map(String) },
    }

    for (const affectedSha of affectedShas) {
      ambiguous.set(affectedSha, failure)
    }
  }

  const proposalsByIntegrationOrder = [...proposals]
    .filter(([pullNumber]) => !invalidPulls.has(pullNumber))
    .toSorted(([, left], [, right]) => {
      const leftPosition =
        input.commits.find((commit) => commit.sha === left.change.sourceIntegrationSha)
          ?.sourceDeltaPosition ?? -1
      const rightPosition =
        input.commits.find((commit) => commit.sha === right.change.sourceIntegrationSha)
          ?.sourceDeltaPosition ?? -1

      return leftPosition - rightPosition
    })

  for (let index = 1; index < proposalsByIntegrationOrder.length; index += 1) {
    const previous = proposalsByIntegrationOrder[index - 1]
    const current = proposalsByIntegrationOrder[index]

    if (previous === undefined || current === undefined) {
      continue
    }

    if (current[1].change.mergedAt.getTime() >= previous[1].change.mergedAt.getTime()) {
      continue
    }

    const involvedPulls = [previous[0], current[0]]
    const affectedShas = [
      ...new Set([...previous[1].managedCommitShas, ...current[1].managedCommitShas]),
    ]
    const conflict = failure(
      'pull_merge_time_conflicts_with_integration_order',
      [
        `Pull request #${current[0]} was reported merged before pull request #${previous[0]},`,
        'but appears later in source first-parent topology',
      ].join(' '),
      affectedShas,
      { pullRequestNumbers: involvedPulls.map(String) },
    )

    for (const pullNumber of involvedPulls) {
      invalidPulls.add(pullNumber)
    }

    for (const sha of affectedShas) {
      ambiguous.set(sha, conflict)
    }
  }

  const validProposals = [...proposals]
    .filter(
      ([pullNumber, proposal]) =>
        !invalidPulls.has(pullNumber) &&
        proposal.managedCommitShas.every((sha) => !ambiguous.has(sha)),
    )
    .map(([, proposal]) => proposal)
  const managed = new Map<string, number>()

  for (const proposal of validProposals) {
    for (const sha of proposal.managedCommitShas) {
      managed.set(sha, proposal.change.pullRequestNumber)
    }
  }

  const projectedCommits = input.commits.map((commit): RepositoryCommitProjection => {
    if (commit.sourceDeltaPosition === null) {
      return { ...commit, attributionState: 'unmanaged' }
    }

    return {
      ...commit,
      attributionState: ambiguous.has(commit.sha)
        ? 'ambiguous'
        : managed.has(commit.sha)
          ? 'managed'
          : 'unmanaged',
    }
  })
  const stateIssues: RepositorySyncIssueProjection[] = []

  for (const commit of projectedCommits) {
    if (commit.sourceDeltaPosition === null) {
      continue
    }

    const failure = ambiguous.get(commit.sha)

    if (failure) {
      stateIssues.push({
        severity: 'error',
        code: 'ambiguous_commit_attribution',
        scope: 'commit',
        subjectId: commit.sha,
        message: failure.message,
        details: {
          reason: failure.code,
          ...failure.details,
        },
      })
    } else if (!managed.has(commit.sha)) {
      const evidence = evidenceBySha.get(commit.sha)
      stateIssues.push({
        severity: 'warning',
        code: 'unmanaged_commit',
        scope: 'commit',
        subjectId: commit.sha,
        message: `Commit ${commit.sha} cannot be safely attributed to a merged pull request`,
        details: {
          candidatePullRequestNumbers: evidence ? [...evidence.candidates].map(String) : [],
        },
      })
    }
  }

  return {
    commits: projectedCommits,
    changes: validProposals
      .map((proposal) => proposal.change)
      .toSorted(compareChangeIntegrationOrder(projectedCommits)),
    issues: [...stateIssues, ...validProposals.flatMap((proposal) => proposal.issues)],
  }
}

function attributePull(input: {
  readonly pull: PullMetadata
  readonly provisionalShas: readonly string[]
  readonly git: GitRepositorySnapshot
  readonly commitBySha: ReadonlyMap<string, RepositoryCommitProjection>
  readonly evidenceBySha: ReadonlyMap<string, CommitPullEvidence>
}): AttributedPull | AttributionFailure {
  const provisional = input.provisionalShas
    .map((sha) => input.commitBySha.get(sha))
    .filter((commit): commit is RepositoryCommitProjection => commit !== undefined)
    .toSorted(compareCommitPosition)
  const mergeCommit = input.pull.mergeCommitSha
    ? input.commitBySha.get(input.pull.mergeCommitSha)
    : undefined

  if (mergeCommit && mergeCommit.parentShas.length > 1) {
    return attributeMergeCommitPull({ ...input, mergeCommit })
  }

  return attributeLinearPull({ ...input, provisional })
}

function attributeMergeCommitPull(input: {
  readonly pull: PullMetadata
  readonly provisionalShas: readonly string[]
  readonly git: GitRepositorySnapshot
  readonly commitBySha: ReadonlyMap<string, RepositoryCommitProjection>
  readonly evidenceBySha: ReadonlyMap<string, CommitPullEvidence>
  readonly mergeCommit: RepositoryCommitProjection
}): AttributedPull | AttributionFailure {
  const window = input.git.integrationWindows.find(
    (candidate) => candidate.integrationSha === input.mergeCommit.sha,
  )

  if (window === undefined) {
    return failure(
      'merge_window_missing',
      `Merge commit ${input.mergeCommit.sha} has no deterministic integration window`,
      input.provisionalShas,
      { pullRequestNumber: input.pull.number },
    )
  }

  if (window.secondParentSha === null) {
    return failure(
      'merge_window_missing',
      `Merge commit ${input.mergeCommit.sha} has no deterministic integration window`,
      input.provisionalShas,
      { pullRequestNumber: input.pull.number },
    )
  }

  const introducedSet = new Set(window.introducedCommitShas)
  const missingOriginalShas = input.pull.originalCommitShas.filter((sha) => !introducedSet.has(sha))

  if (missingOriginalShas.length > 0) {
    return failure(
      'pull_commits_missing_from_merge_window',
      `Pull request #${input.pull.number} contains commits outside its local merge window`,
      window.commitShas,
      {
        pullRequestNumber: input.pull.number,
        missingOriginalCommitShas: missingOriginalShas,
        introducedCommitShas: window.introducedCommitShas,
      },
    )
  }

  if (!isSubsequence(input.pull.originalCommitShas, window.introducedCommitShas)) {
    return failure(
      'pull_commit_order_conflicts_with_git',
      `Pull request #${input.pull.number} commit order contradicts the local merge topology`,
      window.commitShas,
      {
        pullRequestNumber: input.pull.number,
        originalCommitShas: input.pull.originalCommitShas,
        introducedCommitShas: window.introducedCommitShas,
      },
    )
  }

  const originalSet = new Set(input.pull.originalCommitShas)
  const managedCommitShas = window.commitShas
    .filter((sha) => {
      if (sha === input.mergeCommit.sha || originalSet.has(sha)) {
        return true
      }

      const evidence = input.evidenceBySha.get(sha)
      return evidence?.candidates.size === 1 && evidence.candidates.has(input.pull.number)
    })
    .toSorted(compareShaPosition(input.commitBySha))
  const unexplained = window.commitShas.filter((sha) => !managedCommitShas.includes(sha))

  if (unexplained.length > 0) {
    return failure(
      'merge_window_contains_unexplained_commits',
      `Merge window for pull request #${input.pull.number} contains commits owned by another or no pull request`,
      window.commitShas,
      {
        pullRequestNumber: input.pull.number,
        unexplainedCommitShas: unexplained,
      },
    )
  }

  const introducedCommits = window.introducedCommitShas
    .map((sha) => input.commitBySha.get(sha))
    .filter((commit): commit is RepositoryCommitProjection => commit !== undefined)
  if (introducedCommits.length !== window.introducedCommitShas.length) {
    return failure(
      'merge_window_commit_missing_from_projection',
      `Merge window for pull request #${input.pull.number} is incomplete`,
      window.commitShas,
      {
        pullRequestNumber: input.pull.number,
        introducedCommitShas: window.introducedCommitShas,
      },
    )
  }

  const productionPresence =
    window.introducedCommitShas.length === 0
      ? 'released'
      : classifyProductionPresence(
          introducedCommits.map((commit) => commit.productionPatchEquivalent),
        )
  const issues = createProductionPresenceIssues(input.pull, productionPresence, managedCommitShas)

  return {
    managedCommitShas,
    issues,
    change: createChange({
      pull: input.pull,
      mergeMethod: 'merge',
      commitShas: managedCommitShas,
      sourceIntegrationSha: input.mergeCommit.sha,
      integrationFirstParentSha: window.firstParentSha,
      integrationSecondParentSha: window.secondParentSha,
      productionPresence,
    }),
  }
}

function attributeLinearPull(input: {
  readonly pull: PullMetadata
  readonly provisional: readonly RepositoryCommitProjection[]
}): AttributedPull | AttributionFailure {
  if (input.provisional.length === 0) {
    return failure(
      'pull_has_no_source_commits',
      `Pull request #${input.pull.number} has no commits in the unreleased source range`,
      [],
      { pullRequestNumber: input.pull.number },
    )
  }

  const commitShas = input.provisional.map((commit) => commit.sha)

  if (!areContiguous(input.provisional)) {
    return failure(
      'rebase_commit_group_not_contiguous',
      `Pull request #${input.pull.number} commits are not contiguous in source history`,
      commitShas,
      { pullRequestNumber: input.pull.number },
    )
  }

  if (
    input.provisional.some(
      (commit) =>
        commit.parentShas.length !== 1 ||
        commit.firstParentPosition === null ||
        commit.integrationPointSha !== commit.sha,
    ) ||
    !hasContiguousFirstParentPositions(input.provisional)
  ) {
    return failure(
      'linear_pull_contains_non_first_parent_commits',
      `Pull request #${input.pull.number} has a non-linear source integration group`,
      commitShas,
      { pullRequestNumber: input.pull.number },
    )
  }

  const originalCount = input.pull.originalCommitShas.length
  let mergeMethod: 'squash' | 'rebase' | 'unknown'

  if (commitShas.length === 1 && originalCount > 1) {
    mergeMethod = 'squash'
  } else if (commitShas.length > 1 && commitShas.length === originalCount) {
    mergeMethod = 'rebase'
  } else if (commitShas.length === 1 && originalCount === 1) {
    mergeMethod = 'unknown'
  } else {
    return failure(
      'pull_commit_count_conflicts_with_source_group',
      `Pull request #${input.pull.number} commit count contradicts its source integration group`,
      commitShas,
      {
        pullRequestNumber: input.pull.number,
        originalCommitCount: originalCount,
        sourceCommitCount: commitShas.length,
      },
    )
  }

  const sourceIntegration = input.provisional.at(-1)
  const firstCommit = input.provisional[0]

  if (!sourceIntegration || !firstCommit?.parentShas[0]) {
    return failure(
      'linear_integration_parent_missing',
      `Pull request #${input.pull.number} has incomplete linear integration topology`,
      commitShas,
      { pullRequestNumber: input.pull.number },
    )
  }

  const productionPresence = classifyProductionPresence(
    input.provisional.map((commit) => commit.productionPatchEquivalent),
  )

  return {
    managedCommitShas: commitShas,
    issues: [
      ...createProductionPresenceIssues(input.pull, productionPresence, commitShas),
      ...createMergeMethodIssues(input.pull, mergeMethod, commitShas),
    ],
    change: createChange({
      pull: input.pull,
      mergeMethod,
      commitShas,
      sourceIntegrationSha: sourceIntegration.sha,
      integrationFirstParentSha: firstCommit.parentShas[0],
      integrationSecondParentSha: null,
      productionPresence,
    }),
  }
}

function createChange(input: {
  readonly pull: PullMetadata
  readonly mergeMethod: 'merge' | 'squash' | 'rebase' | 'unknown'
  readonly commitShas: readonly string[]
  readonly sourceIntegrationSha: string
  readonly integrationFirstParentSha: string
  readonly integrationSecondParentSha: string | null
  readonly productionPresence: 'unreleased' | 'partially_present' | 'released' | 'unknown'
}): ChangeProjection {
  return {
    githubPullRequestId: input.pull.githubPullRequestId,
    pullRequestNumber: input.pull.number,
    title: input.pull.title,
    url: input.pull.url,
    authorId: input.pull.authorId,
    authorLogin: input.pull.authorLogin,
    baseBranch: input.pull.baseBranch,
    mergedAt: input.pull.mergedAt,
    finalHeadSha: input.pull.finalHeadSha,
    mergeCommitSha: input.pull.mergeCommitSha,
    sourceIntegrationSha: input.sourceIntegrationSha,
    integrationFirstParentSha: input.integrationFirstParentSha,
    integrationSecondParentSha: input.integrationSecondParentSha,
    mergeMethod: input.mergeMethod,
    commitSetFingerprint: createHash('sha256').update(input.commitShas.join('\0')).digest('hex'),
    synchronizationState: 'known',
    productionPresence: input.productionPresence,
    commitShas: input.commitShas,
  }
}

function createMergeMethodIssues(
  pull: PullMetadata,
  mergeMethod: 'squash' | 'rebase' | 'unknown',
  commitShas: readonly string[],
): readonly RepositorySyncIssueProjection[] {
  return mergeMethod === 'unknown'
    ? [
        {
          severity: 'warning',
          code: 'linear_merge_method_ambiguous',
          scope: 'change',
          subjectId: String(pull.githubPullRequestId),
          message: `Pull request #${pull.number} is managed, but a one-commit squash cannot be distinguished from a one-commit rebase`,
          details: { pullRequestNumber: pull.number, commitShas },
        },
      ]
    : []
}

function createProductionPresenceIssues(
  pull: PullMetadata,
  productionPresence: 'unreleased' | 'partially_present' | 'released' | 'unknown',
  commitShas: readonly string[],
): readonly RepositorySyncIssueProjection[] {
  return productionPresence === 'partially_present'
    ? [
        {
          severity: 'error',
          code: 'change_partially_present_in_production',
          scope: 'change',
          subjectId: String(pull.githubPullRequestId),
          message: `Pull request #${pull.number} is only partially present in production`,
          details: { pullRequestNumber: pull.number, commitShas },
        },
      ]
    : []
}

function classifyProductionPresence(
  values: readonly boolean[],
): 'unreleased' | 'partially_present' | 'released' | 'unknown' {
  if (values.length === 0) {
    return 'unknown'
  }

  const present = values.filter(Boolean).length

  if (present === 0) {
    return 'unreleased'
  }

  return present === values.length ? 'released' : 'partially_present'
}

async function loadCommitPullEvidence(input: {
  readonly client: InstallationGitHubClient
  readonly repository: RepositoryIdentity
  readonly sourceBranch: string
  readonly commitSha: string
}): Promise<CommitPullEvidence> {
  const [rest, graph] = await Promise.all([
    listCommitPullRequestsRest(input),
    listCommitPullRequestsGraphql(input),
  ])
  const restNumbers = candidateNumbers(rest)
  const graphNumbers = candidateNumbers(graph)
  const candidates = new Set([...restNumbers, ...graphNumbers])
  const contradictory =
    restNumbers.length > 0 && graphNumbers.length > 0 && !sameNumberSet(restNumbers, graphNumbers)

  return {
    candidates,
    contradictory,
    restCandidates: restNumbers,
    graphCandidates: graphNumbers,
  }
}

async function listCommitPullRequestsRest(input: {
  readonly client: InstallationGitHubClient
  readonly repository: RepositoryIdentity
  readonly sourceBranch: string
  readonly commitSha: string
}): Promise<readonly PullCandidate[]> {
  const results: PullCandidate[] = []

  for (let page = 1; page <= maximumPages; page += 1) {
    const response = await input.client.request(
      'GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls',
      {
        owner: input.repository.ownerLogin,
        repo: input.repository.name,
        commit_sha: input.commitSha,
        per_page: pageSize,
        page,
      },
    )
    const items = requireArray(response.data, `pull requests for commit ${input.commitSha}`)

    for (const item of items) {
      const pull = requireRecord(item, 'commit pull request')
      const base = requireRecord(pull.base, 'commit pull request base')
      const mergedAt = nullableDate(pull.merged_at)

      if (mergedAt && base.ref === input.sourceBranch) {
        results.push({
          number: requirePositiveInteger(pull.number, 'pull request number'),
          baseBranch: input.sourceBranch,
          mergedAt,
        })
      }
    }

    if (items.length < pageSize) {
      return results
    }
  }

  throw incompletePaginationError(`REST pull requests for commit ${input.commitSha}`)
}

async function listCommitPullRequestsGraphql(input: {
  readonly client: InstallationGitHubClient
  readonly repository: RepositoryIdentity
  readonly sourceBranch: string
  readonly commitSha: string
}): Promise<readonly PullCandidate[]> {
  const results: PullCandidate[] = []
  let cursor: string | null = null

  for (let page = 1; page <= maximumPages; page += 1) {
    const response: AssociatedPullRequestsQuery =
      await input.client.graphql<AssociatedPullRequestsQuery>(
        `query ShipgateAssociatedPullRequests(
        $owner: String!
        $name: String!
        $oid: GitObjectID!
        $cursor: String
      ) {
        repository(owner: $owner, name: $name) {
          object(oid: $oid) {
            ... on Commit {
              associatedPullRequests(first: 100, after: $cursor) {
                nodes {
                  number
                  merged
                  mergedAt
                  baseRefName
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }
      }`,
        {
          owner: input.repository.ownerLogin,
          name: input.repository.name,
          oid: input.commitSha,
          cursor,
        },
      )
    const connection = response.repository?.object?.associatedPullRequests

    if (!connection) {
      return results
    }

    for (const pull of connection.nodes) {
      const mergedAt = nullableDate(pull.mergedAt)

      if (pull.merged && mergedAt && pull.baseRefName === input.sourceBranch) {
        results.push({
          number: pull.number,
          baseBranch: pull.baseRefName,
          mergedAt,
        })
      }
    }

    if (!connection.pageInfo.hasNextPage) {
      return results
    }

    if (!connection.pageInfo.endCursor) {
      throw incompletePaginationError(`GraphQL pull requests for commit ${input.commitSha}`)
    }

    cursor = connection.pageInfo.endCursor
  }

  throw incompletePaginationError(`GraphQL pull requests for commit ${input.commitSha}`)
}

async function loadPullMetadata(input: {
  readonly client: InstallationGitHubClient
  readonly repository: RepositoryIdentity
  readonly sourceBranch: string
  readonly pullNumber: number
}): Promise<PullMetadata> {
  const response = await input.client.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: input.repository.ownerLogin,
    repo: input.repository.name,
    pull_number: input.pullNumber,
  })
  const pull = requireRecord(response.data, `pull request #${input.pullNumber}`)
  const base = requireRecord(pull.base, 'pull request base')
  const head = requireRecord(pull.head, 'pull request head')
  const author = isRecord(pull.user) ? pull.user : undefined
  const mergedAt = requireDate(pull.merged_at, 'pull request merged time')
  const baseBranch = requireString(base.ref, 'pull request base branch')

  if (baseBranch !== input.sourceBranch) {
    throw new PullAttributionConflict(
      'pull_request_base_branch_conflict',
      `Pull request #${input.pullNumber} does not target the configured source branch`,
      {
        expectedBaseBranch: input.sourceBranch,
        actualBaseBranch: baseBranch,
      },
    )
  }

  const originalCommitShas = await listPullCommitShasGraphql(input)
  const advertisedCommitCount = nullablePositiveInteger(pull.commits)

  if (advertisedCommitCount !== null && advertisedCommitCount !== originalCommitShas.length) {
    throw new PullAttributionConflict(
      'pull_request_commit_count_conflict',
      `Pull request #${input.pullNumber} commit metadata is inconsistent`,
      {
        advertisedCommitCount,
        loadedCommitCount: originalCommitShas.length,
      },
    )
  }

  return {
    githubPullRequestId: requirePositiveInteger(pull.id, 'pull request ID'),
    number: requirePositiveInteger(pull.number, 'pull request number'),
    title: requireString(pull.title, 'pull request title'),
    url: nullableString(pull.html_url),
    authorId: author ? nullablePositiveInteger(author.id) : null,
    authorLogin: author ? nullableString(author.login) : null,
    baseBranch,
    mergedAt,
    finalHeadSha: requireSha(head.sha, 'pull request final head SHA'),
    mergeCommitSha: nullableSha(pull.merge_commit_sha),
    originalCommitShas,
  }
}

async function listPullCommitShasGraphql(input: {
  readonly client: InstallationGitHubClient
  readonly repository: RepositoryIdentity
  readonly pullNumber: number
}): Promise<readonly string[]> {
  const shas: string[] = []
  let cursor: string | null = null

  for (let page = 1; page <= maximumPages; page += 1) {
    const response: PullRequestCommitsQuery = await input.client.graphql<PullRequestCommitsQuery>(
      `query ShipgatePullRequestCommits(
        $owner: String!
        $name: String!
        $number: Int!
        $cursor: String
      ) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            commits(first: 100, after: $cursor) {
              nodes {
                commit { oid }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      }`,
      {
        owner: input.repository.ownerLogin,
        name: input.repository.name,
        number: input.pullNumber,
        cursor,
      },
    )
    const connection = response.repository?.pullRequest?.commits

    if (!connection) {
      throw new PullAttributionConflict(
        'pull_request_commits_missing',
        `GitHub did not return commits for pull request #${input.pullNumber}`,
        { pullRequestNumber: input.pullNumber },
      )
    }

    for (const node of connection.nodes) {
      shas.push(requireSha(node.commit.oid, 'pull request commit SHA'))
    }

    if (!connection.pageInfo.hasNextPage) {
      return shas
    }

    if (!connection.pageInfo.endCursor) {
      throw incompletePaginationError(`pull request #${input.pullNumber} commits`)
    }

    cursor = connection.pageInfo.endCursor
  }

  throw incompletePaginationError(`pull request #${input.pullNumber} commits`)
}

function candidateNumbers(candidates: readonly PullCandidate[]): number[] {
  return [...new Set(candidates.map((candidate) => candidate.number))].toSorted((a, b) => a - b)
}

function sameNumberSet(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function isSubsequence(needle: readonly string[], haystack: readonly string[]): boolean {
  let index = 0

  for (const value of haystack) {
    if (needle[index] === value) {
      index += 1
    }
  }

  return index === needle.length
}

function areContiguous(commits: readonly RepositoryCommitProjection[]): boolean {
  return commits.every((commit, index) => {
    if (index === 0) {
      return true
    }

    const previous = commits[index - 1]

    return (
      previous !== undefined &&
      previous.sourceDeltaPosition !== null &&
      commit.sourceDeltaPosition !== null &&
      commit.sourceDeltaPosition === previous.sourceDeltaPosition + 1
    )
  })
}

function hasContiguousFirstParentPositions(
  commits: readonly RepositoryCommitProjection[],
): boolean {
  return commits.every((commit, index) => {
    if (commit.firstParentPosition === null) {
      return false
    }

    if (index === 0) {
      return true
    }

    const previous = commits[index - 1]

    return (
      previous !== undefined &&
      previous.firstParentPosition !== null &&
      commit.firstParentPosition === previous.firstParentPosition + 1
    )
  })
}

function compareCommitPosition(
  left: RepositoryCommitProjection,
  right: RepositoryCommitProjection,
): number {
  return (left.sourceDeltaPosition ?? -1) - (right.sourceDeltaPosition ?? -1)
}

function compareShaPosition(
  commits: ReadonlyMap<string, RepositoryCommitProjection>,
): (left: string, right: string) => number {
  return (left, right) => {
    const leftPosition = commits.get(left)?.sourceDeltaPosition ?? -1
    const rightPosition = commits.get(right)?.sourceDeltaPosition ?? -1
    return leftPosition - rightPosition
  }
}

function compareChangeIntegrationOrder(
  commits: readonly RepositoryCommitProjection[],
): (left: ChangeProjection, right: ChangeProjection) => number {
  const positions = new Map(
    commits.map((commit) => [commit.sha, commit.sourceDeltaPosition ?? -1] as const),
  )

  return (left, right) =>
    (positions.get(left.sourceIntegrationSha ?? '') ?? -1) -
      (positions.get(right.sourceIntegrationSha ?? '') ?? -1) ||
    left.pullRequestNumber - right.pullRequestNumber
}

function failure(
  code: string,
  message: string,
  commitShas: readonly string[],
  details: AttributionFailure['details'],
): AttributionFailure {
  return { code, message, commitShas, details }
}

function incompletePaginationError(subject: string): ProjectConfigurationValidationError {
  return new ProjectConfigurationValidationError(
    'external_state_unknown',
    `GitHub pagination safety limit was exceeded while loading ${subject}`,
  )
}

function requireArray(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} is not an array`)
  }

  return value
}

function requireRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new Error(`${name} is not an object`)
  }

  return value
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} is invalid`)
  }

  return value
}

function nullablePositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is invalid`)
  }

  return value
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function requireSha(value: unknown, name: string): string {
  const sha = requireString(value, name).toLowerCase()

  if (!/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new Error(`${name} is invalid`)
  }

  return sha
}

function nullableSha(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }

  return requireSha(value, 'nullable commit SHA')
}

function requireDate(value: unknown, name: string): Date {
  const date = nullableDate(value)

  if (!date) {
    throw new Error(`${name} is invalid`)
  }

  return date
}

function nullableDate(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}
