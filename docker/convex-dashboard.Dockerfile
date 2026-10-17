# First-party Convex dashboard image: ghcr.io/wolvesdotink/convex-dashboard
#
# The `dashboard` profile is off by default, but the release compose still names
# the image and the updater validates every image it names — so the dashboard
# moves under ghcr.io/wolvesdotink/ for the same reason as the backend (see
# docker/convex-backend.Dockerfile).
ARG CONVEX_DASHBOARD_VERSION=latest
FROM ghcr.io/convex/convex-dashboard:${CONVEX_DASHBOARD_VERSION}
