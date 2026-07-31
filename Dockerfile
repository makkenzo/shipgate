# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24.18.0


FROM node:${NODE_VERSION}-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"

RUN apt-get update \
  && apt-get install \
    --yes \
    --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /workspace


FROM base AS dependencies

RUN apt-get update \
  && apt-get install \
    --yes \
    --no-install-recommends \
    git \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY pnpm-lock.yaml ./
COPY pnpm-workspace.yaml ./

COPY apps/server/package.json \
  apps/server/package.json

COPY apps/web/package.json \
  apps/web/package.json

COPY packages/config/package.json \
  packages/config/package.json

COPY packages/database/package.json \
  packages/database/package.json

COPY packages/github/package.json \
  packages/github/package.json

COPY packages/jobs/package.json \
  packages/jobs/package.json

COPY packages/testing/package.json \
  packages/testing/package.json

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install \
    --frozen-lockfile


FROM dependencies AS build

COPY . .

RUN pnpm build

RUN pnpm \
  --filter @shipgate/server \
  --prod \
  deploy \
  /out/server


FROM base AS runtime

ENV NODE_ENV=production

WORKDIR /app/apps/server

COPY \
  --from=build \
  --chown=node:node \
  /out/server/package.json \
  ./package.json

COPY \
  --from=build \
  --chown=node:node \
  /out/server/dist \
  ./dist

COPY \
  --from=build \
  --chown=node:node \
  /out/server/node_modules \
  /app/node_modules

COPY \
  --from=build \
  --chown=node:node \
  /workspace/apps/web/dist \
  /app/apps/web/dist

USER node

EXPOSE 3000

CMD ["node", "dist/api.js"]
