# syntax=docker/dockerfile:1.7-labs

FROM oven/bun:1-alpine AS builder

WORKDIR /app

# Copy workspace root + all package.json files for dependency resolution
COPY package.json bun.lock ./
COPY patches/ patches/
COPY --parents apps/*/package.json packages/*/package.json ./

# Root-level filtered install (same idiom as mta/web): only this package's deps —
# a workspace-wide install would run unrelated packages' postinstall scripts in a
# sources-less context.
RUN bun install --frozen-lockfile --filter @owlat/imap

# Copy IMAP source + the workspace package it imports (@owlat/shared, TS source)
COPY apps/imap/tsconfig.json apps/imap/
COPY apps/imap/src/ apps/imap/src/
COPY packages/shared/ packages/shared/

RUN cd apps/imap && bun run build

FROM node:26-alpine AS runner

WORKDIR /app
COPY --from=builder /app/apps/imap/dist ./dist
COPY --from=builder /app/apps/imap/node_modules ./node_modules
COPY apps/imap/package.json ./

ARG OWLAT_VERSION=dev
ARG OWLAT_GIT_SHA=unknown
ARG OWLAT_BUILD_DATE=unknown

LABEL org.opencontainers.image.source="https://github.com/wolvesdotink/owlat" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.title="owlat-imap" \
      org.opencontainers.image.description="Owlat IMAP server" \
      org.opencontainers.image.version="${OWLAT_VERSION}" \
      org.opencontainers.image.revision="${OWLAT_GIT_SHA}" \
      org.opencontainers.image.created="${OWLAT_BUILD_DATE}"

ENV OWLAT_VERSION=${OWLAT_VERSION} \
    OWLAT_GIT_SHA=${OWLAT_GIT_SHA} \
    OWLAT_BUILD_DATE=${OWLAT_BUILD_DATE}

USER node
EXPOSE 993

CMD ["node", "dist/index.js"]
