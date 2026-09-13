#!/usr/bin/env bash
# Prove the built web image serves a SPA shell the browser will actually EXECUTE,
# carrying the config of the deployment it is RUNNING IN.
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
#   5. the shell's runtime config reflects RUN-time env, not build-time env
#
# (5) is its own trap: nuxt.config.ts is evaluated at image build, and Nitro only
# overlays env named NUXT_PUBLIC_*, so a key reading any other name is frozen in
# every published image. `owlatVersion` read OWLAT_VERSION and so was always
# "dev", which made the admin page hide the in-app updater on every release.
#
# Usage: bash scripts/check-web-csp-shell.sh <image>
#   EXPECTED_VERSION=<v>  assert the shell reports this version (CI passes the
#                         same value it built the image with)
set -euo pipefail

IMAGE="${1:?usage: check-web-csp-shell.sh <image>}"
PORT="${PORT:-31789}"
CONVEX_URL="http://convex.smoke.invalid:3210"
NAME="owlat-csp-shell-$$"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Whatever goes wrong below, the container's own log is the thing that explains
# it — and the EXIT trap is about to delete it.
dump_logs() {
	echo "--- docker logs ($IMAGE) ---"
	docker logs "$NAME" 2>&1 | tail -40 || true
	echo "--- end docker logs ---"
}

# SETUP_MODE is deliberately the non-default value: it only proves anything if
# the shell had to have picked it up at run time.
docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:3000" \
	-e NUXT_PUBLIC_CONVEX_URL="$CONVEX_URL" \
	-e NUXT_PUBLIC_CONVEX_SITE_URL="http://convex-site.smoke.invalid:3211" \
	-e NUXT_PUBLIC_SITE_URL="http://localhost:${PORT}" \
	-e NUXT_PUBLIC_SETUP_MODE=true \
	"$IMAGE" >/dev/null

ready=false
for _ in $(seq 1 60); do
	if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then
		ready=true
		break
	fi
	sleep 2
done
if [ "$ready" != true ]; then
	echo "::error::web image never served a response on :${PORT} within 120s"
	dump_logs
	exit 1
fi

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
# `|| true` on both: under `pipefail` a grep -v that selects nothing exits 1,
# which would abort the script instead of reaching the messages below.
inline_total=$(printf '%s' "$html" | grep -o '<script[^>]*>' | grep -v ' src=' | grep -v 'type="application/json"' | wc -l | tr -d ' ' || true)
inline_nonced=$(printf '%s' "$html" | grep -o '<script[^>]*>' | grep -v ' src=' | grep -v 'type="application/json"' | grep -c "nonce=\"${nonce}\"" || true)
inline_total=${inline_total:-0}
inline_nonced=${inline_nonced:-0}

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

# The shell inlines runtime config as `window.__NUXT__.config` (devalue output:
# unquoted keys, quoted string values).
case "$html" in
	*'setupMode:true'*) ;;
	*)
		echo "::error::the shell ignored NUXT_PUBLIC_SETUP_MODE=true — runtime config is baked at image build, so every deployment gets the build's value"
		exit 1
		;;
esac

if [ -n "${EXPECTED_VERSION:-}" ]; then
	case "$html" in
		*"owlatVersion:\"${EXPECTED_VERSION}\""*) ;;
		*)
			reported=$(printf '%s' "$html" | grep -o 'owlatVersion:"[^"]*"' | head -1)
			echo "::error::the shell reports ${reported:-no owlatVersion} but the image was built as ${EXPECTED_VERSION}; the admin page hides the updater whenever this reads dev"
			exit 1
			;;
	esac
fi

echo "✓ shell is executable: ${inline_total} inline script(s) nonced, connect-src and runtime config follow the running deployment"
