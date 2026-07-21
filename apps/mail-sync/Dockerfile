# syntax=docker/dockerfile:1.7-labs

FROM oven/bun:1-alpine AS builder

WORKDIR /app

# Copy workspace root + all package.json files for dependency resolution
COPY package.json bun.lock ./
COPY patches/ patches/
COPY --parents apps/*/package.json packages/*/package.json examples/*/package.json examples/plugins/*/package.json ./

# Root-level filtered install (same idiom as apps/mta): only this package's deps.
# mail-sync now has its first workspace dependency (@owlat/smtp-client), which the
# old `cd apps/mail-sync && bun install` could not resolve — a workspace-scoped
# install off the repo root can.
RUN bun install --frozen-lockfile --filter @owlat/mail-sync

# Copy mail-sync source + the workspace packages it imports (TypeScript source).
# @owlat/mail-message is the ingest parser; it pulls in @owlat/mail-canon
# (transitive workspace dep) for DKIM canonicalization, so both must be present
# or tsc fails to resolve the module.
COPY apps/mail-sync/tsconfig.json apps/mail-sync/
COPY apps/mail-sync/src/ apps/mail-sync/src/
COPY packages/smtp-client/ packages/smtp-client/
COPY packages/mail-message/ packages/mail-message/
COPY packages/mail-canon/ packages/mail-canon/

# Typecheck first, then bundle the full runtime dependency graph. Bun workspace
# node_modules entries are symlinks into the root install/package tree; copying
# only apps/mail-sync/node_modules into a different runner path breaks every
# target (including @owlat/smtp-client).
RUN cd apps/mail-sync && bun run build
RUN bun build apps/mail-sync/src/index.ts \
	--target=node \
	--outdir=apps/mail-sync/runtime \
	--sourcemap=external

FROM node:26-alpine AS runner

WORKDIR /app
COPY --from=builder /app/apps/mail-sync/runtime ./dist
COPY apps/mail-sync/package.json ./

ARG OWLAT_VERSION=dev
ARG OWLAT_GIT_SHA=unknown
ARG OWLAT_BUILD_DATE=unknown

LABEL org.opencontainers.image.source="https://github.com/wolvesdotink/owlat" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.title="owlat-mail-sync" \
      org.opencontainers.image.description="Owlat mail-sync worker (external IMAP/SMTP accounts)" \
      org.opencontainers.image.version="${OWLAT_VERSION}" \
      org.opencontainers.image.revision="${OWLAT_GIT_SHA}" \
      org.opencontainers.image.created="${OWLAT_BUILD_DATE}"

ENV OWLAT_VERSION=${OWLAT_VERSION} \
    OWLAT_GIT_SHA=${OWLAT_GIT_SHA} \
    OWLAT_BUILD_DATE=${OWLAT_BUILD_DATE}

USER node
EXPOSE 3200

CMD ["node", "dist/index.js"]
