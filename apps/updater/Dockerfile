# syntax=docker/dockerfile:1.7-labs

# Owlat updater sidecar — drives `docker compose pull && up -d` on behalf of
# the web app. Built from the MONOREPO ROOT context (like web/mta/setup-cli):
# the package.json uses bun workspace `catalog:` versions, which only resolve
# inside the workspace — a standalone `npm install` cannot parse them.

FROM oven/bun:1.3-alpine AS builder
WORKDIR /build
COPY package.json bun.lock* ./
# ALL workspace manifests — bun validates the frozen lockfile against the full
# workspace shape (same idiom as apps/web/Dockerfile).
COPY --parents apps/*/package.json packages/*/package.json ./
RUN bun install --frozen-lockfile --filter @owlat/updater

COPY apps/updater/tsconfig.json apps/updater/
COPY apps/updater/src apps/updater/src
RUN cd apps/updater && bun run build

FROM node:26-alpine

# The updater needs docker CLI to drive `docker compose pull && up -d` on the host.
# The docker.sock is mounted from the host (see docker-compose.yml).
RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /app

# No node_modules: the updater has zero runtime dependencies.
COPY --from=builder /build/apps/updater/dist ./dist
COPY apps/updater/package.json ./

# Version metadata — injected by CI on release
ARG OWLAT_VERSION=dev
ARG OWLAT_GIT_SHA=unknown
ARG OWLAT_BUILD_DATE=unknown

LABEL org.opencontainers.image.source="https://github.com/wolvesdotink/owlat" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.title="owlat-updater" \
      org.opencontainers.image.description="Owlat in-place update sidecar" \
      org.opencontainers.image.version="${OWLAT_VERSION}" \
      org.opencontainers.image.revision="${OWLAT_GIT_SHA}" \
      org.opencontainers.image.created="${OWLAT_BUILD_DATE}"

ENV OWLAT_VERSION=${OWLAT_VERSION} \
    OWLAT_GIT_SHA=${OWLAT_GIT_SHA} \
    OWLAT_BUILD_DATE=${OWLAT_BUILD_DATE}

EXPOSE 3200

CMD ["node", "dist/index.js"]
