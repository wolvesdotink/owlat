# syntax=docker/dockerfile:1.7-labs

# One-shot container that deploys Convex functions to a self-hosted backend.
# Usage: docker compose --profile deploy run --rm convex-deploy

FROM oven/bun:1.3.11-alpine AS deps

# Build tools needed for native deps that may show up transitively from the
# full workspace install (apps/docs uses better-sqlite3 as a devDep). Matches
# what apps/web/Dockerfile does.
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy workspace root files
COPY package.json bun.lock bunfig.toml ./
COPY patches/ patches/

# Copy all workspace package.json files for dependency resolution.
# Bun's `--frozen-lockfile` reconciliation walks the entire workspace graph
# (root package.json's `apps/*` glob), so all apps/*/package.json must be
# present even though only apps/api is actually built.
COPY --parents apps/*/package.json packages/*/package.json ./

RUN bun install --frozen-lockfile

# The generated Convex composition imports the plugin host, whose public
# contract dependency resolves through plugin-kit's built package exports.
# Build that contract from a clean context so deploys cannot rely on a local
# ignored dist/ directory.
COPY tsconfig.base.json ./
COPY packages/plugin-kit/ packages/plugin-kit/
RUN bun run --cwd packages/plugin-kit build

# Re-run static membership, provenance, boundary, manifest, and generated-file
# checks against the exact clean Docker context used by the deploy artifact.
FROM deps AS composition-check
COPY . .
COPY --from=deps /app/packages/plugin-kit/dist/ packages/plugin-kit/dist/
RUN bun run plugins:check

# ── Deploy stage ──
FROM node:26-alpine

# S6 (Phase 1.4): pin Convex CLI to an exact minor range. Silently rebuilding
# this image with a newer `convex@latest` has bitten us before — CLI schema-diff
# behaviour changes between minors. Bump this deliberately via a PR after
# testing, don't let `latest` float.
ARG CONVEX_CLI_VERSION=1.36.1
RUN npm install -g convex@${CONVEX_CLI_VERSION}

WORKDIR /app

# Copy installed dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/*/node_modules ./packages/

# Copy source for the api and its workspace deps — keep in sync with the
# `@owlat/*` imports under apps/api/convex (grep them when this fails with
# "Could not resolve @owlat/...").
COPY tsconfig.base.json ./
COPY apps/api/ apps/api/
# This copy makes the deploy stage depend on the successful clean composition
# check above and uses its verified generated backend module.
COPY --from=composition-check /app/apps/api/convex/plugins/plugins.generated.ts apps/api/convex/plugins/plugins.generated.ts
COPY packages/shared/ packages/shared/
COPY packages/email-renderer/ packages/email-renderer/
COPY packages/email-scanner/ packages/email-scanner/
COPY packages/channels/ packages/channels/
COPY packages/plugin-host/ packages/plugin-host/
COPY packages/plugin-kit/package.json packages/plugin-kit/package.json
COPY --from=deps /app/packages/plugin-kit/dist/ packages/plugin-kit/dist/
COPY packages/plugin-codegen/scripts/convexBundleSmoke.ts packages/plugin-codegen/scripts/convexBundleSmoke.ts

# Fail the image build if either package export points at an artifact that was
# not copied into the final deploy image.
RUN node --input-type=module -e "const { access } = await import('node:fs/promises'); const { fileURLToPath } = await import('node:url'); await Promise.all(['@owlat/plugin-host', '@owlat/plugin-kit'].map((specifier) => access(fileURLToPath(import.meta.resolve(specifier)))))"
RUN node packages/plugin-codegen/scripts/convexBundleSmoke.ts

# Version metadata — injected by CI on release
ARG OWLAT_VERSION=dev
ARG OWLAT_GIT_SHA=unknown
ARG OWLAT_BUILD_DATE=unknown

LABEL org.opencontainers.image.source="https://github.com/wolvesdotink/owlat" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.title="owlat-convex-deploy" \
      org.opencontainers.image.description="Owlat tenant Convex function deployer" \
      org.opencontainers.image.version="${OWLAT_VERSION}" \
      org.opencontainers.image.revision="${OWLAT_GIT_SHA}" \
      org.opencontainers.image.created="${OWLAT_BUILD_DATE}"

ENV OWLAT_VERSION=${OWLAT_VERSION} \
    OWLAT_GIT_SHA=${OWLAT_GIT_SHA} \
    OWLAT_BUILD_DATE=${OWLAT_BUILD_DATE}

WORKDIR /app/apps/api

CMD ["sh", "-c", "convex deploy --url $CONVEX_SELF_HOSTED_URL --admin-key $CONVEX_SELF_HOSTED_ADMIN_KEY"]
