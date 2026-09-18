# First-party tinyproxy image: ghcr.io/wolvesdotink/tinyproxy
#
# The allowlisted egress forward-proxy for the untrusted code-worker
# (docker-compose.yml `code-worker-egress`; config in infra/code-worker/).
# Previously vimagick/tinyproxy, which is published for amd64 only. Wrapped
# under ghcr.io/wolvesdotink/ so the image string stays inside the prefix every
# shipped updater's compose allowlist accepts (see docker/clamav.Dockerfile).
#
# kalaksi/tinyproxy is multi-arch, runs unprivileged (uid 57981; tinyproxy then
# skips its own User/Group switch), and its entrypoint only templates a config
# from env when none exists — the mounted tinyproxy.conf is applied verbatim.
FROM kalaksi/tinyproxy:1.7
