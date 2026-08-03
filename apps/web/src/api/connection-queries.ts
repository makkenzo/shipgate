import { queryOptions } from '@tanstack/react-query'

import {
  getAuthSession,
  getConnectionConfiguration,
  getInstallation,
  getInstallations,
} from './connection'

export const authSessionQueryKey = ['connection', 'session'] as const
export const connectionConfigurationQueryKey = ['connection', 'configuration'] as const
export const installationsQueryKey = ['connection', 'installations'] as const

export const authSessionOptions = () =>
  queryOptions({
    queryKey: authSessionQueryKey,
    queryFn: getAuthSession,
    staleTime: 15_000,
  })

export const connectionConfigurationOptions = () =>
  queryOptions({
    queryKey: connectionConfigurationQueryKey,
    queryFn: getConnectionConfiguration,
    staleTime: 5 * 60_000,
  })

export const installationsOptions = () =>
  queryOptions({
    queryKey: installationsQueryKey,
    queryFn: getInstallations,
    staleTime: 15_000,
    refetchInterval: 15_000,
  })

export const installationOptions = (installationId: number, enabled = true) =>
  queryOptions({
    queryKey: [...installationsQueryKey, installationId] as const,
    queryFn: () => getInstallation(installationId),
    staleTime: 15_000,
    refetchInterval: enabled ? 15_000 : false,
    enabled,
  })
