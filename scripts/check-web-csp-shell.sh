#!/usr/bin/env bash
# Prove the built web image serves a SPA shell the browser will actually EXECUTE.
#
# The shell's inline scripts carry a per-request nonce, and one of them
# (`window.__NUXT__.config`) is load-bearing — block it and the app never mounts,
# so the user gets a blank window rather than a degraded page. The nonce reaches
# the CSP header only through the literal `'nonce-{{nonce}}'` source in
# apps/web/nuxt.config.ts, which nuxt-security substitutes per request. Drop that
# token and everything still builds, still starts, still answers 200 — and every
# browser refuses to run the app. That is how it shipped, unnoticed, up to 0.4.5.
#
# So this asserts the two halves agree, against a REAL container:
#   1. script-src carries a concrete 'nonce-<value>'
#   2. every executable inline script tag carries that same value
#   3. there IS at least one inline script (otherwise 1+2 pass vacuously)
#   4. connect-src names the backend given at RUN time, not at build time
#
# Usage: bash scripts/check-web-csp-shell.sh <image>
set -euo pipefail

IMAGE="${1:?usage: check-web-csp-shell.sh <image>}"
PORT="${PORT:-31789}"
CONVEX_URL="http://convex.smoke.invalid:3210"
NAME="owlat-csp-shell-$$"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:3000" \
	-e NUXT_PUBLIC_CONVEX_URL="$CONVEX_URL" \
	-e NUXT_PUBLIC_CONVEX_SITE_URL="http://convex-site.smoke.invalid:3211" \
	-e NUXT_PUBLIC_SITE_URL="http://localhost:${PORT}" \
	"$IMAGE" >/dev/null

for _ in $(seq 1 60); do
	curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null && break
	sleep 2
done

# ONE request for both halves: the nonce is minted per request, so headers from
# one response and HTML from another can never match, and the check would fail
# on a perfectly good build.
hdr_file=$(mktemp)
body_file=$(mktemp)
trap 'cleanup; rm -f "$hdr_file" "$body_file"' EXIT
curl -fsS -D "$hdr_file" -o "$body_file" "http://127.0.0.1:${PORT}/auth/login"
headers=$(cat "$hdr_file")
html=$(cat "$body_file")

csp=$(printf '%s' "$headers" | tr -d '\r' | grep -i '^content-security-policy:' || true)
if [ -z "$csp" ]; then
	echo "::error::no Content-Security-Policy header on the SPA shell"
	exit 1
fi

script_src=$(printf '%s' "$csp" | tr ';' '\n' | grep -E '(^|[[:space:]])script-src ' || true)
nonce=$(printf '%s' "$script_src" | grep -oE "'nonce-[A-Za-z0-9+/=]+'" | head -1 | tr -d "'" | sed 's/^nonce-//')
if [ -z "$nonce" ]; then
	echo "::error::script-src carries no nonce, so every inline script in the shell is blocked and the app cannot mount. Got:${script_src}"
	exit 1
fi

# Executable inline scripts: no src=, and not a data block (application/json).
inline_total=$(printf '%s' "$html" | grep -o '<script[^>]*>' | grep -v ' src=' | grep -v 'type="application/json"' | wc -l | tr -d ' ')
inline_nonced=$(printf '%s' "$html" | grep -o '<script[^>]*>' | grep -v ' src=' | grep -v 'type="application/json"' | grep -c "nonce=\"${nonce}\"" || true)

if [ "$inline_total" -eq 0 ]; then
	echo "::error::no executable inline script in the shell — this check would pass vacuously; update it to match how Nuxt now renders the shell"
	exit 1
fi
if [ "$inline_nonced" -ne "$inline_total" ]; then
	echo "::error::${inline_nonced}/${inline_total} inline scripts carry the header's nonce; the rest are blocked"
	exit 1
fi

connect_src=$(printf '%s' "$csp" | tr ';' '\n' | grep -E '(^|[[:space:]])connect-src ' || true)
case "$connect_src" in
	*"$CONVEX_URL"*) ;;
	*)
		echo "::error::connect-src does not name the backend supplied at RUN time (${CONVEX_URL}); a published image would block its own Convex socket. Got:${connect_src}"
		exit 1
		;;
esac

echo "✓ shell is executable: ${inline_total} inline script(s) nonced, connect-src follows runtime config"
