export const DEPENDENCY_BLOCK_START = '<!-- shipgate:dependencies -->'
export const DEPENDENCY_BLOCK_END = '<!-- /shipgate:dependencies -->'

export type ManagedDependencyBlockParseResult =
  | {
      readonly status: 'absent'
      readonly pullRequestNumbers: readonly number[]
    }
  | {
      readonly status: 'valid'
      readonly pullRequestNumbers: readonly number[]
    }
  | {
      readonly status: 'invalid'
      readonly code:
        | 'duplicate_block'
        | 'unmatched_marker'
        | 'invalid_block_contents'
        | 'invalid_pull_request_reference'
      readonly message: string
    }

export class ManagedDependencyBlockError extends Error {
  readonly code: Extract<ManagedDependencyBlockParseResult, { status: 'invalid' }>['code']

  constructor(
    code: Extract<ManagedDependencyBlockParseResult, { status: 'invalid' }>['code'],
    message: string,
  ) {
    super(message)
    this.name = 'ManagedDependencyBlockError'
    this.code = code
  }
}

interface SourceLine {
  readonly start: number
  readonly end: number
  readonly endWithNewline: number
  readonly text: string
}

interface ManagedBlockLocation {
  readonly status: 'absent' | 'located' | 'invalid'
  readonly start?: number
  readonly end?: number
  readonly contentStart?: number
  readonly contentEnd?: number
  readonly code?: ManagedDependencyBlockError['code']
  readonly message?: string
}

export function parseManagedDependencyBlock(
  body: string | null,
): ManagedDependencyBlockParseResult {
  const source = body ?? ''
  const location = locateManagedBlock(source)

  if (location.status === 'absent') {
    return { status: 'absent', pullRequestNumbers: [] }
  }

  if (location.status === 'invalid') {
    return {
      status: 'invalid',
      code: location.code ?? 'invalid_block_contents',
      message: location.message ?? 'Dependency managed block is invalid',
    }
  }

  const content = source.slice(location.contentStart, location.contentEnd)
  const meaningfulLines = scanLines(content)
    .map((line) => line.text.trim())
    .filter((line) => line.length > 0)

  if (meaningfulLines.length !== 1) {
    return {
      status: 'invalid',
      code: 'invalid_block_contents',
      message: 'Dependency managed block must contain exactly one Shipgate-Depends-On line',
    }
  }

  const match = /^Shipgate-Depends-On:\s*(.*)$/.exec(meaningfulLines[0] ?? '')

  if (!match) {
    return {
      status: 'invalid',
      code: 'invalid_block_contents',
      message: 'Dependency managed block must contain a Shipgate-Depends-On line',
    }
  }

  const references = match[1]?.trim() ?? ''

  if (references.length === 0) {
    return { status: 'valid', pullRequestNumbers: [] }
  }

  const pullRequestNumbers: number[] = []

  for (const rawReference of references.split(',')) {
    const reference = rawReference.trim()
    const referenceMatch = /^#([1-9][0-9]*)$/.exec(reference)
    const pullRequestNumber = referenceMatch ? Number(referenceMatch[1]) : Number.NaN

    if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) {
      return {
        status: 'invalid',
        code: 'invalid_pull_request_reference',
        message: `Invalid dependency pull request reference: ${reference || '<empty>'}`,
      }
    }

    pullRequestNumbers.push(pullRequestNumber)
  }

  return {
    status: 'valid',
    pullRequestNumbers: [...new Set(pullRequestNumbers)].toSorted((left, right) => left - right),
  }
}

export function synchronizeManagedDependencyBlock(
  body: string | null,
  pullRequestNumbers: readonly number[],
): string {
  const source = body ?? ''
  const normalizedPullRequestNumbers = normalizePullRequestNumbers(pullRequestNumbers)
  const location = locateManagedBlock(source)

  if (location.status === 'invalid') {
    throw new ManagedDependencyBlockError(
      location.code ?? 'invalid_block_contents',
      location.message ?? 'Dependency managed block is invalid',
    )
  }

  if (location.status === 'located') {
    const start = location.start ?? 0
    const end = location.end ?? start

    if (normalizedPullRequestNumbers.length === 0) {
      return source.slice(0, start) + source.slice(end)
    }

    return (
      source.slice(0, start) +
      renderManagedBlock(normalizedPullRequestNumbers, detectNewline(source)) +
      source.slice(end)
    )
  }

  if (normalizedPullRequestNumbers.length === 0) {
    return source
  }

  const newline = detectNewline(source)
  const separator = getAppendSeparator(source, newline)
  return `${source}${separator}${renderManagedBlock(normalizedPullRequestNumbers, newline)}`
}

function locateManagedBlock(source: string): ManagedBlockLocation {
  const lines = scanLines(source)
  const starts = lines.filter((line) => line.text.trim() === DEPENDENCY_BLOCK_START)
  const ends = lines.filter((line) => line.text.trim() === DEPENDENCY_BLOCK_END)

  if (starts.length === 0 && ends.length === 0) {
    return { status: 'absent' }
  }

  if (starts.length !== 1 || ends.length !== 1) {
    return {
      status: 'invalid',
      code: starts.length > 1 || ends.length > 1 ? 'duplicate_block' : 'unmatched_marker',
      message:
        starts.length > 1 || ends.length > 1
          ? 'PR body contains more than one dependency managed block'
          : 'PR body contains an unmatched dependency managed-block marker',
    }
  }

  const start = starts[0]
  const end = ends[0]

  if (!start || !end || start.start >= end.start || start.endWithNewline > end.start) {
    return {
      status: 'invalid',
      code: 'unmatched_marker',
      message: 'Dependency managed-block markers are out of order',
    }
  }

  return {
    status: 'located',
    start: start.start,
    end: end.end,
    contentStart: start.endWithNewline,
    contentEnd: end.start,
  }
}

function renderManagedBlock(pullRequestNumbers: readonly number[], newline: string): string {
  const references = pullRequestNumbers
    .map((pullRequestNumber) => `#${pullRequestNumber}`)
    .join(', ')

  return [DEPENDENCY_BLOCK_START, `Shipgate-Depends-On: ${references}`, DEPENDENCY_BLOCK_END].join(
    newline,
  )
}

function normalizePullRequestNumbers(values: readonly number[]): readonly number[] {
  const normalized = values.map((value) => {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError('Dependency pull request numbers must be positive safe integers')
    }

    return value
  })

  return [...new Set(normalized)].toSorted((left, right) => left - right)
}

function scanLines(source: string): readonly SourceLine[] {
  if (source.length === 0) {
    return [{ start: 0, end: 0, endWithNewline: 0, text: '' }]
  }

  const lines: SourceLine[] = []
  let start = 0

  while (start < source.length) {
    const newlineIndex = source.indexOf('\n', start)

    if (newlineIndex === -1) {
      const raw = source.slice(start)
      const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      lines.push({ start, end: source.length, endWithNewline: source.length, text })
      break
    }

    const end =
      newlineIndex > start && source[newlineIndex - 1] === '\r' ? newlineIndex - 1 : newlineIndex
    lines.push({
      start,
      end,
      endWithNewline: newlineIndex + 1,
      text: source.slice(start, end),
    })
    start = newlineIndex + 1
  }

  return lines
}

function detectNewline(source: string): string {
  return source.includes('\r\n') ? '\r\n' : '\n'
}

function getAppendSeparator(source: string, newline: string): string {
  if (source.length === 0) {
    return ''
  }

  if (source.endsWith(`${newline}${newline}`)) {
    return ''
  }

  if (source.endsWith(newline)) {
    return newline
  }

  return `${newline}${newline}`
}
