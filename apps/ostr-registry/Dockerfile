# syntax=docker/dockerfile:1.7-labs

FROM oven/bun:1-alpine AS builder

WORKDIR /app

# Copy workspace root + all package.json files for dependency resolution
COPY package.json bun.lock ./
COPY patches/ patches/
COPY --parents apps/*/package.json packages/*/package.json examples/*/package.json examples/plugins/*/package.json ./

# Root-level filtered install (same idiom as apps/mail-sync): only this
# package's deps. A workspace-scoped install off the repo root is what lets the
# workspace dependency below resolve at all.
#
# --ignore-scripts is not optional here. better-sqlite3 is in the root
# manifest's `trustedDependencies`, so bun runs its `node-gyp rebuild` install
# script, and oven/bun:1-alpine ships no python — the install fails outright.
# Nothing in this stage needs the compiled binding: the typecheck reads
# @types/better-sqlite3, and the bundle leaves the module external. The runner
# stage installs the real thing against the Node that will load it.
RUN bun install --frozen-lockfile --ignore-scripts --filter @owlat/ostr-registry

# Copy the registry source + the workspace packages it imports (TypeScript
# source). @owlat/ostr-core is the only one, and it has no workspace
# dependencies of its own — it is a zero-dependency package by design, which is
# what keeps this list at one line.
COPY apps/ostr-registry/tsconfig.json apps/ostr-registry/
COPY apps/ostr-registry/src/ apps/ostr-registry/src/
COPY packages/ostr-core/ packages/ostr-core/

# Typecheck first, then bundle the full runtime dependency graph. Bun workspace
# node_modules entries are symlinks into the root install/package tree; copying
# only apps/ostr-registry/node_modules into a different runner path breaks every
# target (including @owlat/ostr-core).
#
# better-sqlite3 STAYS EXTERNAL. It is a native module: `bun build
# --target=node` can bundle its JavaScript but not its `.node` binding, and a
# bundled copy would fail at `require` time in the runner with a message about
# a missing binding rather than about the bundle. It is installed in the runner
# stage instead, against the Node that will actually run it.
RUN cd apps/ostr-registry && bun run build

# The exact better-sqlite3 the lockfile resolved, written out for the runner.
# Hard-pinning a second copy of the version in this file would let a lockfile
# bump make the runtime N-API binding a different version from the one this
# stage typechecked and bundled against, with nothing gating the drift — and the
# failure mode is an ABI or API mismatch that first appears at the first query
# inside the built image. bun.lock is the single source of truth for it.
# Found by path rather than by `require`: bun's isolated install puts the real
# package under node_modules/.bun/<name>@<version>/, and better-sqlite3's
# `exports` map does not expose ./package.json, so module resolution answers
# neither question. A `find` over the tree is layout-independent.
RUN set -eu; \
	manifest="$(find /app/node_modules -path '*/better-sqlite3/package.json' \
		-not -path '*/@types/*' | head -n 1)"; \
	test -n "$manifest"; \
	bun -e "console.log(JSON.parse(require('node:fs').readFileSync('$manifest','utf8')).version)" \
		> /app/better-sqlite3.version; \
	test -s /app/better-sqlite3.version; \
	cat /app/better-sqlite3.version

RUN bun build apps/ostr-registry/src/index.ts \
	--target=node \
	--external better-sqlite3 \
	--outdir=apps/ostr-registry/runtime \
	--sourcemap=external

FROM node:26-alpine AS runner

WORKDIR /app

# The one native dependency, at the exact version the builder stage resolved
# from bun.lock — never a second pin maintained by hand here. It ships N-API
# prebuilds for musl, so this needs no compiler and no node-gyp; the smoke check
# is here so that a version that ever stops shipping one fails the BUILD instead
# of the first request.
#
# ORDER MATTERS: this runs before the app manifest is copied. npm resolves the
# whole dependency tree of whatever package.json it finds, and this one carries
# `workspace:*` and `catalog:` specifiers that only bun understands — copying it
# first turns this line into an unresolvable install.
COPY --from=builder /app/better-sqlite3.version /tmp/better-sqlite3.version
RUN npm install --omit=dev --no-audit --no-fund --loglevel=error \
		"better-sqlite3@$(cat /tmp/better-sqlite3.version)" \
	&& node -e "import('better-sqlite3').then(({ default: D }) => { new D(':memory:').close(); })" \
	&& rm -rf /root/.npm /tmp/better-sqlite3.version

COPY --from=builder /app/apps/ostr-registry/runtime ./dist
COPY apps/ostr-registry/package.json ./

# The log and the aggregator each own a SQLite file under this directory, and
# the process writes them as `node`. Mount a volume here: the transparency log
# is append-only evidence, and losing it means the node cannot reproduce the
# heads it has already signed — which it refuses to start without.
ENV OSTR_DB_DIR=/app/data
RUN mkdir -p /app/data && chown -R node:node /app/data

ARG OWLAT_VERSION=dev
ARG OWLAT_GIT_SHA=unknown
ARG OWLAT_BUILD_DATE=unknown

LABEL org.opencontainers.image.source="https://github.com/wolvesdotink/owlat" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.title="owlat-ostr-registry" \
      org.opencontainers.image.description="Owlat OSTR registry node (transparency log + reference aggregator + query API)" \
      org.opencontainers.image.version="${OWLAT_VERSION}" \
      org.opencontainers.image.revision="${OWLAT_GIT_SHA}" \
      org.opencontainers.image.created="${OWLAT_BUILD_DATE}"

ENV OWLAT_VERSION=${OWLAT_VERSION} \
    OWLAT_GIT_SHA=${OWLAT_GIT_SHA} \
    OWLAT_BUILD_DATE=${OWLAT_BUILD_DATE}

USER node
EXPOSE 3300

# `--enable-source-maps` because the build emits `--sourcemap=external`: without
# it every stack trace out of this container is reported against bundled offsets
# and the shipped .map files are dead weight.
CMD ["node", "--enable-source-maps", "dist/index.js"]
