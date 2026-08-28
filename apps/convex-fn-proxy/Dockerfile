# syntax=docker/dockerfile:1.7-labs

# Owlat Convex function-allowlist proxy — holds the deployment admin key and
# forwards only the code-worker's thirteen allowlisted codeWorkTasks/workerTasks
# calls to the real Convex backend, so the untrusted worker never holds admin.
# Built from the MONOREPO ROOT context (like web/mta/updater): the package.json
# uses bun workspace `catalog:` versions, which only resolve inside the
# workspace — a standalone `npm install` cannot parse them.

FROM oven/bun:1.3-alpine AS builder
WORKDIR /build
COPY package.json bun.lock* ./
COPY patches/ patches/
# ALL workspace manifests — bun validates the frozen lockfile against the full
# workspace shape (same idiom as apps/web/Dockerfile), examples/* and
# examples/plugins/* included.
COPY --parents apps/*/package.json packages/*/package.json examples/*/package.json examples/plugins/*/package.json ./
RUN bun install --frozen-lockfile --filter @owlat/convex-fn-proxy

COPY apps/convex-fn-proxy/tsconfig.json apps/convex-fn-proxy/
COPY apps/convex-fn-proxy/src apps/convex-fn-proxy/src
# The proxy has NO workspace runtime dependencies (node builtins + global fetch
# only), so `bun build` emits a fully self-contained dist/index.js and the
# runtime image needs no node_modules.
RUN cd apps/convex-fn-proxy && bun run build

FROM node:26-alpine

WORKDIR /app

# No node_modules: the proxy's only imports are node builtins, bundled into dist.
COPY --from=builder /build/apps/convex-fn-proxy/dist ./dist
COPY apps/convex-fn-proxy/package.json ./

# Version metadata — injected by CI on release
ARG OWLAT_VERSION=dev
ARG OWLAT_GIT_SHA=unknown
ARG OWLAT_BUILD_DATE=unknown

LABEL org.opencontainers.image.source="https://github.com/wolvesdotink/owlat" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.title="owlat-convex-fn-proxy" \
      org.opencontainers.image.description="Owlat Convex function-allowlist proxy for the code-worker" \
      org.opencontainers.image.version="${OWLAT_VERSION}" \
      org.opencontainers.image.revision="${OWLAT_GIT_SHA}" \
      org.opencontainers.image.created="${OWLAT_BUILD_DATE}"

ENV OWLAT_VERSION=${OWLAT_VERSION} \
    OWLAT_GIT_SHA=${OWLAT_GIT_SHA} \
    OWLAT_BUILD_DATE=${OWLAT_BUILD_DATE}

EXPOSE 3220

CMD ["node", "dist/index.js"]
