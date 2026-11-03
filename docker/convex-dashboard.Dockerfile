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
FROM ghcr.io/convex/convex-dashboard:latest@sha256:a55bf8abca1332f787bc4d4a79850182175027be7b70aa230be4389a1d3268e2
