# Shipgate

Shipgate is in its second development stage. The repository currently provides the runtime
foundation for a modular monolith; it does not yet contain the release and deployment domain
planned for later stages.

## Current architecture

- `apps/server` is the composition root for three processes built from one codebase:
  `api`, `worker`, and `migrate`.
- `apps/web` is a React SPA. Its API client is generated from the Fastify OpenAPI document.
- `packages/config` validates process environment values at runtime.
- `packages/database` owns the PostgreSQL pool, Kysely schema, transactions, readiness, locks,
  and application migrations.
- `packages/jobs` owns durable Graphile Worker infrastructure and the current diagnostic job.
- `packages/testing` contains shared PostgreSQL test-container setup.

PostgreSQL is the single source of truth. The API and worker are separate runtime processes,
but they are packaged and deployed from the same modular-monolith image. New packages should be
introduced only when a real capability or external boundary exists.

## Local development

Use Node from `.nvmrc` and pnpm from `packageManager`.

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

`pnpm dev` starts PostgreSQL, applies Graphile Worker and application migrations, and then runs
the API, worker, and Vite development server.

Internal diagnostic and metrics endpoints are enabled by default outside production. In
production they require explicit `API_DIAGNOSTICS_ENABLED=true` or
`API_METRICS_ENABLED=true`; expose them only on a trusted network.

## Verification

```bash
pnpm ci
pnpm compose:up
pnpm test:e2e
pnpm compose:down
```

`pnpm ci` checks formatting, package boundaries, lint, types, unit and integration behavior,
generated API and route artifacts, and all workspace builds. The compose-based end-to-end test
also verifies the production image, migrations, API, worker, and SPA together.
