# Shipgate

Shipgate is an early modular monolith for connecting GitHub repositories to a release control
plane. This repository contains the runtime and integration foundation; product capabilities are
added only when they have a concrete use case.

## Repository layout

- `apps/server` composes the API, background worker, and database migrator processes from one
  codebase.
- `apps/web` contains the React single-page application and its generated API client.
- `packages/config` validates runtime configuration and secrets.
- `packages/database` owns PostgreSQL connectivity, schema types, transactions, and migrations.
- `packages/github` is the external boundary for GitHub authentication and API clients.
- `packages/jobs` owns durable Graphile Worker jobs and worker lifecycle infrastructure.
- `packages/testing` provides shared PostgreSQL test-container support.

PostgreSQL is the source of truth. The API and worker are separate runtime processes but remain
parts of the same deployable system and share the packages above.

## Generated files

The OpenAPI document, generated web API client, and TanStack Router route tree are tracked so that
contract drift is visible in review. Regenerate them through the owning workspace commands; do not
edit generated files by hand. Local build output, coverage, and browser-test reports are ignored.

## Working with the repository

Use the Node version from `.nvmrc`, the pnpm version declared by the repository, and copy
`.env.example` to `.env` for local configuration.

Available commands are discoverable without duplicating script documentation here:

```bash
pnpm run
pnpm --filter @shipgate/server run
pnpm --filter @shipgate/web run
pnpm --filter @shipgate/database run
```

The root command list is the source of truth for repository-wide development and verification;
workspace command lists show package-specific entry points.
