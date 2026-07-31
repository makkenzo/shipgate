import { loadGitHubRuntimeConfig } from '@shipgate/config'
import { createGitHubAppManifest } from '@shipgate/github'

const runtimeConfig = loadGitHubRuntimeConfig()

if (!runtimeConfig.appOrigin) {
  process.stderr.write('APP_ORIGIN is required to render the production GitHub App manifest\n')
  process.exitCode = 1
} else {
  const manifest = createGitHubAppManifest(runtimeConfig.appOrigin)

  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
}
