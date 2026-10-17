# First-party Convex backend image: ghcr.io/wolvesdotink/convex-backend
#
# Upstream moved its images from ghcr.io/get-convex/ to ghcr.io/convex/ and the
# old repository now refuses every pull, so the image string had to change —
# and the running updater on every existing install validates a release compose
# against a fixed allowlist BEFORE pulling anything (apps/updater/src/
# security.ts), which no updater shipped so far extends to ghcr.io/convex/.
# Wrapped under ghcr.io/wolvesdotink/, the one prefix every shipped updater
# accepts (see docker/clamav.Dockerfile), the release reaches those installs
# through the normal in-app update. Upstream is multi-arch, so one Dockerfile
# serves amd64 and arm64.
#
# `latest` floats upstream; each Owlat release freezes it via the digest-pinned
# compose. CONVEX_BACKEND_VERSION picks another upstream tag for a local build.
ARG CONVEX_BACKEND_VERSION=latest
FROM ghcr.io/convex/convex-backend:${CONVEX_BACKEND_VERSION}
