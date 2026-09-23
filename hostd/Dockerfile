# One recipe, two targets. The whole test suite runs in the shared stage, so an image whose tests fail is
# never built and a deploy can never replace a running container with one.

FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm test

FROM base AS api
# A named volume copies the ownership of the directory it is first mounted over, so this is what lets the
# unprivileged api write its audit log.
RUN mkdir -p /state && chown node:node /state
USER node
CMD ["node", "--import", "tsx", "src/api/index.ts"]

FROM base AS agent
# restic takes the backups; sqlite3 is how a sqlite database is copied safely under a concurrent writer.
# Neither belongs in api or fetcher: only the agent ever runs them.
# No buildx, deliberately. With it compose builds through BuildKit, which fetches registry tokens from
# the client, and this container has no network, so every base image not already on the host failed to
# pull. The legacy builder has the daemon pull instead. Its one gap, a repo that names its build file
# `dockerfile`, is covered by nameDockerfiles in src/agent/deploy.ts.
RUN apk add --no-cache docker-cli docker-cli-compose restic sqlite
CMD ["node", "--import", "tsx", "src/agent/index.ts"]

FROM base AS fetcher
RUN apk add --no-cache git
CMD ["node", "--import", "tsx", "src/fetcher/index.ts"]
