# First-party ClamAV image: ghcr.io/wolvesdotink/clamav
#
# Why a wrapper at all: the running updater on every existing install validates
# a downloaded release compose against a fixed image allowlist (apps/updater/
# src/security.ts) BEFORE pulling anything, and `ghcr.io/wolvesdotink/` is the
# one prefix every updater ever shipped accepts. Upstream ClamAV publishes its
# alpine image (clamav/clamav) for amd64 only and its arm64 build under a
# different repository (clamav/clamav-debian), so an arm64-capable release
# would otherwise have to change the image string — which old updaters reject.
#
# Per-architecture base, chosen by buildx via TARGETARCH:
#   amd64 → clamav/clamav (alpine): the image every existing install already
#           runs; clamav is uid 100, matching the ownership of their
#           signature-DB volume.
#   arm64 → clamav/clamav-debian: same entrypoint, healthcheck helper
#           (clamdcheck.sh) and env contract; clamav is uid 1000, which is fine
#           because arm64 installs are new by definition.
# `stable` floats upstream (ClamAV deletes old minor tags, so a numeric pin rots
# into a 404); each Owlat release freezes it via the digest-pinned compose.
ARG TARGETARCH
FROM clamav/clamav:stable AS base-amd64
FROM clamav/clamav-debian:stable AS base-arm64
FROM base-${TARGETARCH}
