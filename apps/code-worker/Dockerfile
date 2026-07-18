# syntax=docker/dockerfile:1.7-labs

# ── Build stage ──────────────────────────────────────────────────────
# Compiled via the bun workspace (like web/mta/updater/setup-cli): the
# package.json uses bun `catalog:` versions, which only resolve inside the
# workspace — a standalone `npm install` cannot parse them.
FROM oven/bun:1.3-alpine AS builder

WORKDIR /build

COPY package.json bun.lock* ./
COPY patches/ patches/
# ALL workspace manifests — bun validates the frozen lockfile against the full
# workspace shape (same idiom as apps/web/Dockerfile), examples/plugins/*
# included.
COPY --parents apps/*/package.json packages/*/package.json examples/plugins/*/package.json ./
# The worker imports the dist-shipping @owlat/plugin-kit workspace package, so it
# is filtered in as well — that pulls in plugin-kit's build toolchain so we can
# emit its dist before compiling the worker (tsc needs its types; the runtime
# needs its JS).
RUN bun install --frozen-lockfile --filter @owlat/code-worker --filter @owlat/plugin-kit

# Build @owlat/plugin-kit first: the worker's tsc build resolves it to dist/.
COPY packages/plugin-kit/ packages/plugin-kit/
RUN cd packages/plugin-kit && bun run build

COPY apps/code-worker/tsconfig.json apps/code-worker/
COPY apps/code-worker/src/ apps/code-worker/src/
RUN cd apps/code-worker && bun run build

# ── Runtime deps stage ───────────────────────────────────────────────
# Production-only install scoped to this package: yields a minimal
# node_modules (convex, octokit, execa + transitives) without devDeps.
FROM oven/bun:1.3-alpine AS proddeps

WORKDIR /build

COPY package.json bun.lock* ./
COPY patches/ patches/
# examples/plugins/* are workspaces too — bun's frozen-lockfile check needs
# their manifests to see the full workspace shape.
COPY --parents apps/*/package.json packages/*/package.json examples/plugins/*/package.json ./
RUN bun install --frozen-lockfile --production --filter @owlat/code-worker

# ── Runtime stage ────────────────────────────────────────────────────
FROM node:26-alpine

WORKDIR /app

# Install git and common build tools for workspace operations
RUN apk add --no-cache git bash curl

# Install OpenCode (if available via npm)
# Falls back gracefully if not available — the worker uses AI SDK as fallback
RUN npm install -g opencode 2>/dev/null || echo "OpenCode not available, using fallback"

COPY --from=builder /build/apps/code-worker/dist ./dist
COPY --from=proddeps /build/node_modules ./node_modules
COPY apps/code-worker/package.json ./
# node_modules/@owlat/plugin-kit is a workspace symlink pointing back at
# packages/plugin-kit; ship that package's built dist (+ manifest) at the path
# the symlink resolves to so the worker's `import '@owlat/plugin-kit'` loads at
# runtime.
COPY --from=builder /build/packages/plugin-kit/package.json ./packages/plugin-kit/package.json
COPY --from=builder /build/packages/plugin-kit/dist ./packages/plugin-kit/dist

# UID isolation for untrusted execution.
#
# The orchestrator (dist/index.js) holds the deployment admin key, GITHUB_TOKEN
# and the LLM key in its process env, but it spawns the UNTRUSTED coding agent
# (opencode) and `npx vitest` as a DISTINCT unprivileged uid (`sandbox`,
# uid=10001) via setuid — a hard cross-uid kernel boundary those children cannot
# cross to read /proc/<orchestrator>/environ or ptrace the orchestrator memory.
#
# Dropping to another uid requires the orchestrator itself to run as root, so
# this container runs as CONFINED root ONLY (cap_drop:ALL + a tiny cap_add of
# SETUID/SETGID/CHOWN, read-only rootfs, no-new-privileges — see compose).
# Untrusted code NEVER runs as root: it always runs as uid 10001.
#
# The `sandbox` account has no login shell and no valid home. The toolchain
# (node/npx/opencode/git) is installed world-executable on PATH, so uid 10001
# can run it. /workspace + /app stay root-owned; /workspace is root-writable and
# the orchestrator chowns each per-task working tree to `sandbox` at runtime
# (keeping .git root-owned) so the agent can write while secrets stay unreadable.
RUN addgroup -S -g 10001 sandbox \
	&& adduser -S -D -H -G sandbox -u 10001 -s /sbin/nologin sandbox \
	&& mkdir -p /workspace

ENV NODE_ENV=production
ENV WORKSPACE_ROOT=/workspace

# NOTE: intentionally NO `USER` directive — the main process runs as root (uid 0)
# so it can setuid to `sandbox` for untrusted children (see comment above).

CMD ["node", "dist/index.js"]
