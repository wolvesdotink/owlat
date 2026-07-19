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

# Copy IMAP source + the workspace packages it imports (@owlat/shared, TS source).
# @owlat/shared's mailMime.ts re-exports from @owlat/mail-message/headers, so its
# source must be present for tsc to resolve the subpath during the build.
COPY apps/imap/tsconfig.json apps/imap/
COPY apps/imap/src/ apps/imap/src/
COPY packages/shared/ packages/shared/
COPY packages/mail-message/ packages/mail-message/
COPY packages/mail-canon/ packages/mail-canon/

# Typecheck first, then bundle the complete runtime graph. App-local Bun
# workspace node_modules entries are symlinks into root-owned paths and cannot
# be relocated into the runner independently.
RUN cd apps/imap && bun run build
RUN bun build apps/imap/src/index.ts \
	--target=node \
	--outdir=apps/imap/runtime \
	--sourcemap=external

FROM node:26-alpine AS runner

WORKDIR /app
COPY --from=builder /app/apps/imap/runtime ./dist
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
