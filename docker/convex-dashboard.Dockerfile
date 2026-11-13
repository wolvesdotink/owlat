# First-party Convex dashboard image: ghcr.io/wolvesdotink/convex-dashboard
#
# The `dashboard` profile's admin UI. Wrapped under ghcr.io/wolvesdotink/ for
# the same reason as the backend: Convex moved its images to ghcr.io/convex/,
# which shipped updaters refuse (see docker/convex-backend.Dockerfile).
#
# A bare FROM keeps the upstream user (nextjs), command, PORT=6791 and working
# directory. Pinned by the digest of the multi-arch index; bump it together
# with the backend:
#   docker buildx imagetools inspect ghcr.io/convex/convex-dashboard:latest
FROM ghcr.io/convex/convex-dashboard:latest@sha256:caf95d3f2241cddc103a84b728294fa0777c6acc291a2c4612c1d06faaa1c43a
