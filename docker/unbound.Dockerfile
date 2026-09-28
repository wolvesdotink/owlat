# First-party recursive resolver image: ghcr.io/wolvesdotink/unbound
#
# The MTA's blocklist lookups go through it (DNSBL_RESOLVER, see
# apps/mta/src/intelligence/dnsblResolver.ts): Spamhaus refuses queries relayed
# by shared resolvers, so the lookups have to leave from this server itself.
# Wrapped under ghcr.io/wolvesdotink/ so the image string stays inside the
# prefix every shipped updater's compose allowlist accepts (see
# docker/clamav.Dockerfile). Alpine is multi-arch, so one Dockerfile serves
# amd64 and arm64.
FROM alpine:3.22

RUN apk add --no-cache unbound

COPY unbound.conf /etc/unbound/unbound.conf
RUN unbound-checkconf /etc/unbound/unbound.conf

USER unbound
EXPOSE 5335/udp 5335/tcp

ENTRYPOINT ["unbound", "-d", "-c", "/etc/unbound/unbound.conf"]
