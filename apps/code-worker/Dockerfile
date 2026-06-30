# syntax=docker/dockerfile:1.7-labs

# ── Build stage ──────────────────────────────────────────────────────
# Compiled via the bun workspace (like web/mta/updater/setup-cli): the
# package.json uses bun `catalog:` versions, which only resolve inside the
# workspace — a standalone `npm install` cannot parse them.
FROM oven/bun:1.3-alpine AS builder

WORKDIR /build

COPY package.json bun.lock* ./
# ALL workspace manifests — bun validates the frozen lockfile against the full
# workspace shape (same idiom as apps/web/Dockerfile).
COPY --parents apps/*/package.json packages/*/package.json ./
RUN bun install --frozen-lockfile --filter @owlat/code-worker

COPY apps/code-worker/tsconfig.json apps/code-worker/
COPY apps/code-worker/src/ apps/code-worker/src/
RUN cd apps/code-worker && bun run build

# ── Runtime deps stage ───────────────────────────────────────────────
# Production-only install scoped to this package: yields a minimal
# node_modules (convex, octokit, execa + transitives) without devDeps.
FROM oven/bun:1.3-alpine AS proddeps

WORKDIR /build

COPY package.json bun.lock* ./
COPY --parents apps/*/package.json packages/*/package.json ./
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

# Defense-in-depth: run as an unprivileged user so a compromised coding agent
# (or git/test subprocess) does not execute as root. The workspace volume and
# app dir are owned by this user so git clones, branch checkouts and commits
# keep working.
RUN addgroup -S worker && adduser -S -G worker -h /home/worker worker \
	&& mkdir -p /workspace \
	&& chown -R worker:worker /workspace /app /home/worker

ENV NODE_ENV=production
ENV WORKSPACE_ROOT=/workspace

USER worker

CMD ["node", "dist/index.js"]
