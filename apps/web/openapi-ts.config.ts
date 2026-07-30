import { defineConfig } from '@hey-api/openapi-ts'

export default defineConfig({
  input: './openapi/shipgate.openapi.json',

  output: 'src/api/generated',

  plugins: [
    '@hey-api/typescript',

    {
      name: '@hey-api/client-fetch',

      runtimeConfigPath: './src/api/client-config.ts',
    },

    '@hey-api/sdk',

    {
      name: '@tanstack/react-query',

      queryOptions: true,
      queryKeys: true,
      mutationOptions: true,
      mutationKeys: true,
    },
  ],
})
