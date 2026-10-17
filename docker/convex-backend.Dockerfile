# First-party Convex backend image: ghcr.io/wolvesdotink/convex-backend
#
# Why a wrapper at all: Convex moved its images from ghcr.io/get-convex/ to
# ghcr.io/convex/, and the old repository now refuses anonymous pulls. The
# running updater on every existing install validates a downloaded release
# compose against a fixed image allowlist (apps/updater/src/security.ts) BEFORE
# pulling anything. Releases up to v0.6.13 only allow ghcr.io/get-convex/ and
# ghcr.io/wolvesdotink/, so a compose naming ghcr.io/convex/ would be refused
# by every shipped updater. ghcr.io/wolvesdotink/ is the one prefix all of them
# accept (the same reason as docker/clamav.Dockerfile).
#
# A bare FROM keeps the upstream image as it is: entrypoint (run_backend.sh),
# working directory (/convex, where generate_admin_key.sh lives), the
# /convex/data volume, the root user that owns it, exposed ports 3210/3211 and
# curl for the compose healthcheck. Volumes created by the get-convex image
# keep working unchanged.
#
# Pinned by the digest of the multi-arch index (amd64 + arm64), so a release
# rebuild gets the same backend. Convex publishes only `latest` and per-commit
# tags. To move the pin, take the digest of the new index:
#   docker buildx imagetools inspect ghcr.io/convex/convex-backend:latest
# and keep docker/convex-dashboard.Dockerfile at a build from the same time.
# Dependabot (docker, /docker) proposes the same bump when `latest` moves.
FROM ghcr.io/convex/convex-backend:latest@sha256:d715e9ec088784407ca4ba2d3db592702cd328d02c76cdca3852c0018f2a76b4
