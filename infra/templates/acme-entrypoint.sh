#!/bin/sh
# ──────────────────────────────────────────────────────────────────
# ACME sidecar — issues + renews a TLS certificate for
# `mail.<slug>.owlat.app` and writes it into the shared mail-certs
# volume read by the IMAP server (port 993) and the MTA's inbound SMTP
# listener (port 25 STARTTLS), both via TLS_CERT_DIR. MTA submission
# (465/587) takes its own SUBMISSION_TLS_* material, not this volume.
#
# No restart is needed after a renewal: the IMAP server and the MTA's inbound
# SMTP listener re-read default.{crt,key} every five minutes and swap the new
# pair in (packages/shared/src/tlsCertReloader.ts).
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

# Stage one file next to its destination, already carrying its final mode and
# owner, so the rename that publishes it is the only step a reader can observe.
# $1 source, $2 destination, $3 mode. Prints the staged path (and nothing else
# on stdout: the caller captures it).
stage_file() {
  staged="$(dirname "$2")/.$(basename "$2").tmp.$$"
  if install -m "$3" "$1" "$staged" >&2 && chown "$IMAP_RUNTIME_USER" "$staged" >&2; then
    printf '%s\n' "$staged"
    return 0
  fi
  rm -f "$staged"
  return 1
}

publish_cert() {
  local cert="$LEGO_PATH/certificates/${ACME_DOMAIN}.crt"
  local key="$LEGO_PATH/certificates/${ACME_DOMAIN}.key"
  if [ ! -f "$cert" ] || [ ! -f "$key" ]; then
    echo "[acme] no certificate to publish yet" >&2
    return 1
  fi
  # Readers (packages/shared/src/tlsCertReloader.ts) poll these files, so an
  # in-place `install` could hand them a truncated file, a key still owned by
  # root, or a new cert next to the old key. Instead every file is staged in
  # the same directory with its final mode and owner, and only then renamed
  # over the live one (rename is atomic on one filesystem).
  #
  # Mode stays 0600 on the key — only the OWNER changes, so it is readable by
  # exactly one uid and never by group or world.
  #
  # The domain-named pair lets SNI multi-domain setups pick a cert by hostname.
  local key_tmp crt_tmp dkey_tmp dcrt_tmp
  if ! key_tmp=$(stage_file "$key" "$CERT_DIR/default.key" 0600) ||
    ! crt_tmp=$(stage_file "$cert" "$CERT_DIR/default.crt" 0644) ||
    ! dkey_tmp=$(stage_file "$key" "$CERT_DIR/${ACME_DOMAIN}.key" 0600) ||
    ! dcrt_tmp=$(stage_file "$cert" "$CERT_DIR/${ACME_DOMAIN}.crt" 0644); then
    rm -f "$CERT_DIR"/.*.tmp.$$
    echo "[acme] could not stage the certificate in $CERT_DIR; left the published pair as it was" >&2
    return 1
  fi
  # Key first, then cert, back to back: anything that notices a renewal by
  # the certificate changing finds the matching key already in place. A
  # reader landing between the two renames gets a mismatched pair, which the
  # reloader rejects (keeping the pair it serves) and retries once the cert
  # changes. If a rename fails, the rest stay unpublished.
  if ! { mv -f "$key_tmp" "$CERT_DIR/default.key" &&
    mv -f "$crt_tmp" "$CERT_DIR/default.crt" &&
    mv -f "$dkey_tmp" "$CERT_DIR/${ACME_DOMAIN}.key" &&
    mv -f "$dcrt_tmp" "$CERT_DIR/${ACME_DOMAIN}.crt"; }; then
    rm -f "$CERT_DIR"/.*.tmp.$$
    echo "[acme] publishing into $CERT_DIR failed part-way" >&2
    return 1
  fi
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
