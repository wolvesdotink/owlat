#!/bin/sh
# ──────────────────────────────────────────────────────────────────
# ACME sidecar — issues + renews a TLS certificate for
# `mail.<slug>.owlat.app` and writes it into the shared mail-certs
# volume read by the IMAP server (port 993) and the MTA submission
# server (ports 465/587).
#
# Uses lego (https://go-acme.github.io/lego) with DNS-01 challenges so
# we don't need to open port 80 on the VPS. The Hetzner DNS provider
# expects $HETZNER_API_TOKEN; swap to another provider by adjusting
# LEGO_PROVIDER + the provider-specific env vars.
#
# Required env:
#   ACME_DOMAIN          — e.g. mail.acme.owlat.app
#   ACME_CONTACT_EMAIL   — Let's Encrypt account contact
#   LEGO_PROVIDER        — e.g. hetzner, route53, cloudflare (lego DNS provider name)
# Optional:
#   ACME_STAGING=1       — use Let's Encrypt staging URL
#   RENEW_INTERVAL_HOURS — default 24
#   IMAP_RUNTIME_USER    — uid:gid that must be able to READ the published key
#                          (default 1000:1000, the imap image's `node` user)
# ──────────────────────────────────────────────────────────────────

set -eu

CERT_DIR="${TLS_CERT_DIR:-/opt/owlat/certs}"
# lego runs as root, so a 0600 key it publishes lands as root:root — unreadable
# by the imap container (uid 1000), which mounts mail-certs :ro and therefore
# cannot repair it. That is a silent, permanent `EACCES … default.key` crash-loop
# on every renewal, so every publish re-asserts ownership. Same contract as
# docker-compose.yml's imap-cert-init; keep the default in step with
# apps/imap/Dockerfile's build-time uid assertion.
IMAP_RUNTIME_USER="${IMAP_RUNTIME_USER:-1000:1000}"
LEGO_PATH="${LEGO_PATH:-/data/lego}"
RENEW_INTERVAL_HOURS="${RENEW_INTERVAL_HOURS:-24}"

mkdir -p "$CERT_DIR" "$LEGO_PATH"

if [ -z "${ACME_DOMAIN:-}" ]; then
  echo "[acme] ACME_DOMAIN is required" >&2
  exit 1
fi
if [ -z "${ACME_CONTACT_EMAIL:-}" ]; then
  echo "[acme] ACME_CONTACT_EMAIL is required" >&2
  exit 1
fi
if [ -z "${LEGO_PROVIDER:-}" ]; then
  echo "[acme] LEGO_PROVIDER is required" >&2
  exit 1
fi

SERVER_FLAG=""
if [ "${ACME_STAGING:-0}" = "1" ]; then
  SERVER_FLAG="--server=https://acme-staging-v02.api.letsencrypt.org/directory"
fi

publish_cert() {
  local cert="$LEGO_PATH/certificates/${ACME_DOMAIN}.crt"
  local key="$LEGO_PATH/certificates/${ACME_DOMAIN}.key"
  if [ ! -f "$cert" ] || [ ! -f "$key" ]; then
    echo "[acme] no certificate to publish yet" >&2
    return 1
  fi
  install -m 0644 "$cert" "$CERT_DIR/default.crt"
  install -m 0600 "$key" "$CERT_DIR/default.key"
  # Also publish under the domain name so SNI multi-domain setups can
  # pick a specific cert by hostname.
  install -m 0644 "$cert" "$CERT_DIR/${ACME_DOMAIN}.crt"
  install -m 0600 "$key" "$CERT_DIR/${ACME_DOMAIN}.key"
  # Mode stays 0600 — only the OWNER changes, so the key is still readable by
  # exactly one uid and never by group or world.
  chown "$IMAP_RUNTIME_USER" \
    "$CERT_DIR/default.crt" "$CERT_DIR/default.key" \
    "$CERT_DIR/${ACME_DOMAIN}.crt" "$CERT_DIR/${ACME_DOMAIN}.key"
  echo "[acme] published $CERT_DIR/default.{crt,key} owned by $IMAP_RUNTIME_USER"
}

issue_or_renew() {
  if [ -f "$LEGO_PATH/certificates/${ACME_DOMAIN}.crt" ]; then
    echo "[acme] renewing $ACME_DOMAIN"
    lego \
      --path "$LEGO_PATH" \
      --email "$ACME_CONTACT_EMAIL" \
      --domains "$ACME_DOMAIN" \
      --dns "$LEGO_PROVIDER" \
      $SERVER_FLAG \
      --accept-tos \
      renew --days 30 || echo "[acme] renew skipped or failed"
  else
    echo "[acme] issuing $ACME_DOMAIN"
    lego \
      --path "$LEGO_PATH" \
      --email "$ACME_CONTACT_EMAIL" \
      --domains "$ACME_DOMAIN" \
      --dns "$LEGO_PROVIDER" \
      $SERVER_FLAG \
      --accept-tos \
      run
  fi
  publish_cert || true
}

# First-time issuance
issue_or_renew

# Periodic renewal loop
while true; do
  sleep "$((RENEW_INTERVAL_HOURS * 3600))"
  issue_or_renew
done
