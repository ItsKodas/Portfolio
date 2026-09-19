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
RUN apk add --no-cache docker-cli docker-cli-compose
CMD ["node", "--import", "tsx", "src/agent/index.ts"]
