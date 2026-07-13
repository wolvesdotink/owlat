# syntax=docker/dockerfile:1.7-labs

FROM oven/bun:1-alpine AS builder

WORKDIR /app

# Copy workspace root + all package.json files for dependency resolution
COPY package.json bun.lock ./
COPY patches/ patches/
COPY --parents apps/*/package.json packages/*/package.json ./

# Root-level filtered install (same idiom as web/updater/setup-cli): only this
# package's deps — a workspace-wide install would run unrelated packages'
# postinstall scripts (e.g. @owlat/ui's), which fail in a sources-less context.
RUN bun install --frozen-lockfile --filter @owlat/mta

# Copy MTA source + workspace packages it imports (TypeScript source)
COPY apps/mta/tsconfig.json apps/mta/
COPY apps/mta/src/ apps/mta/src/
COPY packages/email-scanner/ packages/email-scanner/
COPY packages/shared/ packages/shared/

RUN cd apps/mta && bun run build

FROM node:26-alpine AS runner

WORKDIR /app
COPY --from=builder /app/apps/mta/dist ./dist
COPY --from=builder /app/apps/mta/node_modules ./node_modules
COPY apps/mta/package.json ./

# Version metadata — injected by CI on release
ARG OWLAT_VERSION=dev
ARG OWLAT_GIT_SHA=unknown
ARG OWLAT_BUILD_DATE=unknown

LABEL org.opencontainers.image.source="https://github.com/wolvesdotink/owlat" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.title="owlat-mta" \
      org.opencontainers.image.description="Owlat MTA (mail transfer agent)" \
      org.opencontainers.image.version="${OWLAT_VERSION}" \
      org.opencontainers.image.revision="${OWLAT_GIT_SHA}" \
      org.opencontainers.image.created="${OWLAT_BUILD_DATE}"

ENV OWLAT_VERSION=${OWLAT_VERSION} \
    OWLAT_GIT_SHA=${OWLAT_GIT_SHA} \
    OWLAT_BUILD_DATE=${OWLAT_BUILD_DATE}

USER node
EXPOSE 3100 25

CMD ["node", "dist/index.js"]
