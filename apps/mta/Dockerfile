# syntax=docker/dockerfile:1.7-labs

FROM oven/bun:1-alpine AS builder

WORKDIR /app

# Copy workspace root + all package.json files for dependency resolution. The
# manifest set must cover every workspace the root package.json globs in
# (examples/* and examples/plugins/* included), or bun's frozen-lockfile check rejects the
# partial workspace shape.
COPY package.json bun.lock ./
COPY patches/ patches/
COPY --parents apps/*/package.json packages/*/package.json examples/*/package.json examples/plugins/*/package.json ./

# Root-level filtered install (same idiom as web/updater/setup-cli): only this
# package's deps — a workspace-wide install would run unrelated packages'
# postinstall scripts (e.g. @owlat/ui's), which fail in a sources-less context.
RUN bun install --frozen-lockfile --filter @owlat/mta

# Copy MTA source + workspace packages it imports (TypeScript source)
COPY apps/mta/tsconfig.json apps/mta/
COPY apps/mta/src/ apps/mta/src/
COPY packages/email-scanner/ packages/email-scanner/
COPY packages/shared/ packages/shared/
COPY packages/mail-auth/ packages/mail-auth/
COPY packages/mail-canon/ packages/mail-canon/
COPY packages/mail-message/ packages/mail-message/
COPY packages/smtp-client/ packages/smtp-client/
COPY packages/smtp-listener/ packages/smtp-listener/

# Keep the TypeScript build as the container-local type/declaration check, then
# produce one self-contained Node bundle for the runtime stage. Copying an
# app-local node_modules directory is unsafe with Bun workspaces: its entries are
# symlinks into the root .bun store and packages/ tree, and relocating only the
# links leaves a release image full of dangling dependencies.
RUN cd apps/mta && bun run build
RUN bun build apps/mta/src/index.ts \
	--target=node \
	--outdir=apps/mta/runtime \
	--sourcemap=external

FROM node:26-alpine AS runner

WORKDIR /app
COPY --from=builder /app/apps/mta/runtime ./dist
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
