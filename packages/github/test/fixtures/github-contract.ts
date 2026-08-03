export const githubUserFixture = {
  id: 99,
  login: 'octocat',
  avatar_url: 'https://avatars.example/octocat.png',
  name: 'The Octocat',
  email: null,
  html_url: 'https://github.example/octocat',
} as const

export const githubRepositoryFixture = {
  id: 456,
  name: 'shipgate',
  full_name: 'octocat/shipgate',
  private: true,
  archived: false,
  disabled: false,
  default_branch: 'main',
  visibility: 'private',
  owner: {
    id: 99,
    login: 'octocat',
  },
  permissions: {
    pull: true,
    push: true,
  },
} as const

export function createOAuthTokenFixture(sequence: number) {
  return {
    access_token: `access-token-${sequence}`,
    expires_in: 60,
    refresh_token: `refresh-token-${sequence}`,
    refresh_token_expires_in: 86_400,
    token_type: 'bearer',
  } as const
}
