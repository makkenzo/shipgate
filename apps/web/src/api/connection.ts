import { createCsrfHeaders } from './csrf'
import {
  deleteLocalAccount as deleteLocalAccountRequest,
  disconnectGitHub as disconnectGitHubRequest,
  getAuthSession as getAuthSessionRequest,
  getConnectionConfiguration as getConnectionConfigurationRequest,
  getInstallation as getInstallationRequest,
  getInstallations as getInstallationsRequest,
  logout as logoutRequest,
} from './generated/sdk.gen'
import type {
  GetAuthSessionResponse,
  GetConnectionConfigurationResponse,
  GetInstallationResponse,
  GetInstallationsResponse,
} from './generated/types.gen'

export type AuthSession = GetAuthSessionResponse
export type ConnectionConfiguration = GetConnectionConfigurationResponse
export type InstallationDetail = GetInstallationResponse
export type InstallationSummary = GetInstallationsResponse['installations'][number]

export async function getAuthSession(): Promise<AuthSession> {
  const { data } = await getAuthSessionRequest({ throwOnError: true })

  return data
}

export async function getConnectionConfiguration(): Promise<ConnectionConfiguration> {
  const { data } = await getConnectionConfigurationRequest({ throwOnError: true })

  return data
}

export async function getInstallations(): Promise<readonly InstallationSummary[]> {
  const { data } = await getInstallationsRequest({ throwOnError: true })

  return data.installations
}

export async function getInstallation(installationId: number): Promise<InstallationDetail> {
  const { data } = await getInstallationRequest({
    path: {
      installationId: String(installationId),
    },
    throwOnError: true,
  })

  return data
}

export async function logout(): Promise<void> {
  await logoutRequest({
    body: {},
    headers: createCsrfHeaders(),
    throwOnError: true,
  })
}

export async function disconnectGitHub(): Promise<void> {
  await disconnectGitHubRequest({
    body: {},
    headers: createCsrfHeaders(),
    throwOnError: true,
  })
}

export async function deleteLocalAccount(): Promise<void> {
  await deleteLocalAccountRequest({
    headers: createCsrfHeaders(),
    throwOnError: true,
  })
}
