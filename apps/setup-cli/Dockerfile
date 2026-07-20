# syntax=docker/dockerfile:1.7-labs

# Owlat Setup CLI image — runs on the host via:
#   docker run --rm -it -v /opt/owlat:/opt/owlat owlat/setup:<version> setup
#
# Multi-stage so the final image stays small (~80MB).

FROM oven/bun:1.3-alpine AS builder
WORKDIR /build
COPY package.json bun.lock* ./
COPY patches/ patches/
# ALL workspace manifests (same idiom as apps/web/Dockerfile): bun validates the
# frozen lockfile against the full workspace shape, so a partial set of
# package.jsons reads as "lockfile had changes" and the install refuses to run.
# The set must include examples/* and examples/plugins/* — those are workspaces too.
COPY --parents apps/*/package.json packages/*/package.json examples/*/package.json examples/plugins/*/package.json ./
RUN bun install --frozen-lockfile --filter @owlat/setup-cli

COPY packages/shared packages/shared
COPY apps/setup-cli apps/setup-cli
RUN cd apps/setup-cli && bun run build

FROM oven/bun:1.3-alpine
WORKDIR /opt/setup

# The `quickstart` flow orchestrates the stack (docker compose up, the
# convex-deploy one-shot, `convex env set`, generate_admin_key.sh) by shelling
# out to `docker compose`. That needs the Docker CLI + compose plugin in the
# image; the host daemon is reached via the socket (`-v /var/run/docker.sock`)
# and `--network host`, both wired up by scripts/owlat at runtime.
RUN apk add --no-cache docker-cli docker-cli-compose

COPY --from=builder /build/apps/setup-cli/dist /opt/setup/dist
COPY --from=builder /build/packages/shared /opt/setup/packages/shared
COPY --from=builder /build/apps/setup-cli/package.json /opt/setup/package.json

ENV OWLAT_DIR=/opt/owlat
WORKDIR /opt/owlat

ENTRYPOINT ["bun", "run", "/opt/setup/dist/owlat-setup.js"]
CMD ["setup"]
