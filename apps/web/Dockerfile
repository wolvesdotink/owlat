# syntax=docker/dockerfile:1.7-labs

# Global ARG — referenced by stage 3's FROM. MUST live above every FROM line
# (Docker scopes per-stage ARGs locally, so a stage-2 ARG is empty by the time
# stage 3's FROM is resolved, which causes "base name should not be blank").
ARG RUNTIME_BASE=platformatic/node-caged:26-slim

# ── Stage 1: Install dependencies ──
FROM oven/bun:1.3-alpine AS deps

RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy workspace root files
COPY package.json bun.lock bunfig.toml ./
COPY patches/ patches/

# Copy all workspace package.json files for dependency resolution
COPY --parents apps/*/package.json packages/*/package.json ./

RUN bun install --frozen-lockfile

# ── Stage 2: Build ──
# node, not bun: the heavy JS (nuxt/vite build) runs on V8 here. Bun's JIT
# segfaults under CPU emulation (Rosetta/qemu), which the desktop dev flow
# relies on to cross-build amd64 images on arm Macs; node is stable there and
# produces identical artifacts natively.
FROM node:26-alpine AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/ui/node_modules ./packages/ui/node_modules

# Copy full source (filtered by .dockerignore)
COPY . .

ARG NITRO_PRESET=node-server
ENV NITRO_PRESET=${NITRO_PRESET}
ENV NODE_OPTIONS=--max-old-space-size=4096

RUN cd packages/ui && npx nuxi prepare
RUN cd apps/web && npx nuxt build

# ── Stage 3: Runtime ──
# RUNTIME_BASE is declared globally at the top of this file.
FROM ${RUNTIME_BASE} AS runtime

WORKDIR /app

COPY --from=build /app/apps/web/.output ./

# Version metadata — injected by CI on release (defaults for local dev builds)
ARG OWLAT_VERSION=dev
ARG OWLAT_GIT_SHA=unknown
ARG OWLAT_BUILD_DATE=unknown

LABEL org.opencontainers.image.source="https://github.com/wolvesdotink/owlat" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.title="owlat-web" \
      org.opencontainers.image.description="Owlat web app (Nuxt)" \
      org.opencontainers.image.version="${OWLAT_VERSION}" \
      org.opencontainers.image.revision="${OWLAT_GIT_SHA}" \
      org.opencontainers.image.created="${OWLAT_BUILD_DATE}"

ENV HOST=0.0.0.0 \
    PORT=3000 \
    OWLAT_VERSION=${OWLAT_VERSION} \
    OWLAT_GIT_SHA=${OWLAT_GIT_SHA} \
    OWLAT_BUILD_DATE=${OWLAT_BUILD_DATE}

EXPOSE 3000

CMD ["node", "server/index.mjs"]
