import { describe, expect, it } from 'vitest'

import {
  parseManagedDependencyBlock,
  synchronizeManagedDependencyBlock,
} from './dependency-managed-block.js'

describe('dependency managed block', () => {
  it('parses only the managed block and ignores dependency-like prose outside it', () => {
    const body = [
      'Depends on #999 outside Shipgate and must be ignored.',
      '',
      '<!-- shipgate:dependencies -->',
      'Shipgate-Depends-On: #1440, #1421',
      '<!-- /shipgate:dependencies -->',
    ].join('\n')

    expect(parseManagedDependencyBlock(body)).toEqual({
      status: 'valid',
      pullRequestNumbers: [1421, 1440],
    })
    expect(parseManagedDependencyBlock('Depends on #123')).toEqual({
      status: 'absent',
      pullRequestNumbers: [],
    })
  })

  it('replaces only the managed block and preserves the rest of a CRLF body byte-for-byte', () => {
    const prefix = 'Heading\r\n\r\nKeep  two  spaces.\r\n'
    const suffix = '\r\nFooter without normalization.'
    const body = `${prefix}<!-- shipgate:dependencies -->\r\nShipgate-Depends-On: #1\r\n<!-- /shipgate:dependencies -->${suffix}`

    expect(synchronizeManagedDependencyBlock(body, [1440, 1421])).toBe(
      `${prefix}<!-- shipgate:dependencies -->\r\nShipgate-Depends-On: #1421, #1440\r\n<!-- /shipgate:dependencies -->${suffix}`,
    )
  })

  it('appends, removes and rejects ambiguous blocks deterministically', () => {
    const appended = synchronizeManagedDependencyBlock('Existing body', [12])
    expect(appended).toBe(
      'Existing body\n\n<!-- shipgate:dependencies -->\nShipgate-Depends-On: #12\n<!-- /shipgate:dependencies -->',
    )
    expect(synchronizeManagedDependencyBlock(appended, [])).toBe('Existing body\n\n')

    expect(
      parseManagedDependencyBlock(
        '<!-- shipgate:dependencies -->\nShipgate-Depends-On: #1\n<!-- /shipgate:dependencies -->\n<!-- shipgate:dependencies -->\nShipgate-Depends-On: #2\n<!-- /shipgate:dependencies -->',
      ),
    ).toMatchObject({ status: 'invalid', code: 'duplicate_block' })
  })
})
