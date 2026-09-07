#!/usr/bin/env bash
#
# Compose wiring invariants for the code worker, in both shipped stacks.
#
# The worker drives internal Convex functions but must never hold the admin key
# (security review M4): it authenticates to the convex-fn-proxy sidecar with
# CODE_WORKER_PROXY_TOKEN, the proxy holds CONVEX_ADMIN_KEY, and the worker's
# egress goes through the allowlisted forward proxy. `codeWorkTasks.reclaimStale`
# requeues every running row when a worker starts, so a second replica would rip
# the first one's in-flight task away: the worker is pinned to one replica.

set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
ok() { echo "ok:   $1"; }
bad() { echo "FAIL: $1" >&2; fail=1; }

# The first top-level service block named $2 in compose file $1.
service_block() {
	awk -v name="$2" '
		$0 == "  " name ":" && !seen { p=1; seen=1; print; next }
		p && /^  [a-z][a-z0-9-]*:$/ { exit }
		p { print }
	' "$1"
}

for compose in docker-compose.yml infra/templates/docker-compose.vps.yml; do
	worker=$(service_block "$compose" code-worker)
	proxy=$(service_block "$compose" convex-fn-proxy)
	[ -n "$worker" ] || { bad "$compose: no code-worker service"; continue; }
	[ -n "$proxy" ] || { bad "$compose: no convex-fn-proxy service"; continue; }

	if grep -qE '^ {6}CONVEX_URL: http://convex-fn-proxy:3220$' <<<"$worker" \
		&& grep -qE '^ {6}CODE_WORKER_CONVEX_KEY: \$\{CODE_WORKER_PROXY_TOKEN(:-)?\}$' <<<"$worker" \
		&& ! grep -qE '^ {6}CONVEX_ADMIN_KEY:' <<<"$worker"; then
		ok "$compose: code-worker reaches Convex through convex-fn-proxy with the proxy token, not the admin key"
	else bad "$compose: code-worker must use CONVEX_URL=http://convex-fn-proxy:3220 and CODE_WORKER_CONVEX_KEY=\${CODE_WORKER_PROXY_TOKEN} and carry no CONVEX_ADMIN_KEY"; fi

	if grep -qE '^ {6}HTTPS_PROXY: http://code-worker-egress:8888$' <<<"$worker"; then
		ok "$compose: code-worker egress is forced through code-worker-egress"
	else bad "$compose: code-worker must set HTTPS_PROXY=http://code-worker-egress:8888"; fi

	if grep -qE '^ {6}CONVEX_URL: http://convex:3210$' <<<"$proxy" \
		&& grep -qE '^ {6}CONVEX_ADMIN_KEY: \$\{CONVEX_ADMIN_KEY(:-)?\}$' <<<"$proxy" \
		&& grep -qE '^ {6}CODE_WORKER_PROXY_TOKEN: \$\{CODE_WORKER_PROXY_TOKEN(:-)?\}$' <<<"$proxy"; then
		ok "$compose: convex-fn-proxy holds the admin key and validates the proxy token"
	else bad "$compose: convex-fn-proxy must set CONVEX_URL=http://convex:3210, CONVEX_ADMIN_KEY and CODE_WORKER_PROXY_TOKEN"; fi

	if grep -Pzq '\n {4}deploy:\n {6}replicas: 1\n' <<<"$worker"; then
		ok "$compose: code-worker is pinned to a single replica"
	else bad "$compose: code-worker must declare deploy.replicas: 1"; fi
done

exit $fail
