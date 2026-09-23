#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# e2e-update-flow.sh — Run a real in-app update, end to end, on this machine.
#
# Boots a fresh install at release FROM from its published compose template,
# asks the running updater to apply release TO (the same POST /update the web
# app sends when an operator clicks "Update now") and then checks what an
# operator would check: the updater answered success, every step it reports
# went through, the containers run TO's images and report TO's version, `.env`
# and the compose file moved with them, the updater replaced itself, and the
# web app still answers.
#
# Every in-app update bug so far lived in the gaps between those steps (a proxy
# that 403'd `compose up`, a version pin that never reached the containers, a
# disk that filled with superseded images), and unit tests mock exactly those
# gaps out. This drives real Docker, real images and a real Convex backend.
#
# Usage:
#   bash scripts/e2e-update-flow.sh <from-version> <to-version>
#
# Environment:
#   UPDATER_IMAGE  Run this image as the FROM install's updater instead of the
#                  one FROM shipped. This is how CI tests a change to the
#                  updater itself: the PR's updater performs a real FROM → TO
#                  rollout.
#   WORK_DIR       Where the install goes (default: a temp dir). Its basename
#                  is always `owlat`, so the compose project and container
#                  names match a production install.
#   KEEP=1         Leave the stack running afterwards, for debugging.
#
# Needs docker, docker compose, curl and jq. Uses ports 3000, 3210 and 3211.
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

FROM="${1:-}"
TO="${2:-}"
if [[ -z "$FROM" || -z "$TO" ]]; then
	echo "Usage: $0 <from-version> <to-version>" >&2
	exit 2
fi
FROM="${FROM#v}"
TO="${TO#v}"

REPO="${OWLAT_REPO:-wolvesdotink/owlat}"
BASE="${WORK_DIR:-$(mktemp -d)}"
INSTALL="$BASE/owlat"
mkdir -p "$INSTALL"
cd "$INSTALL"

log() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
fail() {
	printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2
	exit 1
}
pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }

# On any exit: show what the stack looked like, then take it down (unless KEEP).
on_exit() {
	local status=$?
	if [[ $status -ne 0 ]]; then
		log "Diagnostics"
		docker compose ps -a || true
		for service in updater web convex docker-socket-proxy; do
			echo "── logs: $service"
			docker compose logs --no-color --tail=80 "$service" 2>/dev/null || true
		done
		df -h / || true
		docker system df || true
	fi
	if [[ "${KEEP:-0}" != "1" ]]; then
		docker compose down -v --remove-orphans >/dev/null 2>&1 || true
	fi
	exit $status
}
trap on_exit EXIT

# ── 1. The two release templates, checksum-verified ──────────────────────────
fetch_template() {
	local version="$1"
	local url="https://github.com/$REPO/releases/download/v$version/docker-compose-$version.yml"
	curl -fsSL "$url" -o "docker-compose-$version.yml" || fail "cannot download $url"
	curl -fsSL "$url.sha256" -o "docker-compose-$version.yml.sha256" || fail "cannot download $url.sha256"
	local expected actual
	expected="$(awk '{print $1}' "docker-compose-$version.yml.sha256")"
	actual="$(sha256sum "docker-compose-$version.yml" | awk '{print $1}')"
	[[ "$expected" == "$actual" ]] || fail "checksum mismatch for docker-compose-$version.yml"
}

log "Fetching release templates $FROM and $TO"
fetch_template "$FROM"
fetch_template "$TO"
mkdir -p "$BASE/templates"
mv docker-compose-*.yml* "$BASE/templates/"
cp "$BASE/templates/docker-compose-$FROM.yml" docker-compose.yml

# ── 2. A fresh install at FROM ───────────────────────────────────────────────
log "Installing $FROM"
secret() { openssl rand -hex 32; }
cat >.env <<EOF
OWLAT_VERSION=$FROM
INSTANCE_SECRET=$(secret)
REDIS_PASSWORD=$(secret)
MTA_SECRET=$(secret)
BOUNCE_VERP_KEY=$(secret)
FBL_DEDUP_PROTOCOL=owned-v2
FBL_DEDUP_CUTOVER_ACK=fresh-install
COMPOSE_PROFILES=
EOF
chmod 600 .env
INSTANCE_SECRET="$(grep -m1 '^INSTANCE_SECRET=' .env | cut -d= -f2-)"

if [[ -n "${UPDATER_IMAGE:-}" ]]; then
	# Compose loads the override on every call, the updater's own included, so
	# the image under test also survives the updater's self-replacement.
	cat >docker-compose.override.yml <<EOF
services:
  updater:
    image: $UPDATER_IMAGE
EOF
	pass "updater under test: $UPDATER_IMAGE"
fi

docker compose up -d --wait convex
# The key is the last `name|hex` token the script prints (see parseAdminKey
# in apps/setup-cli/src/lib/convexDeploy.ts).
admin_key="$(docker compose exec -T convex ./generate_admin_key.sh | tr -s '[:space:]' '\n' | grep '|' | tail -n1)"
[[ -n "$admin_key" ]] || fail "generate_admin_key.sh printed no key"
echo "CONVEX_ADMIN_KEY=$admin_key" >>.env

docker compose up -d
docker compose --profile deploy run --rm convex-deploy >/dev/null
pass "Convex functions of $FROM deployed"

wait_for_web() {
	for _ in $(seq 1 60); do
		if curl -fsS -o /dev/null http://localhost:3000/; then return 0; fi
		sleep 2
	done
	return 1
}
wait_for_web || fail "web never answered on :3000 at $FROM"
pass "web answers at $FROM"

from_deploy_image="$(docker image inspect --format '{{.Id}}' \
	"$(grep -m1 -oE 'ghcr.io/[a-z0-9-]+/convex-deploy:[^[:space:]]+' docker-compose.yml)")"
updater_before="$(docker inspect --format '{{.Id}}' owlat-updater-1)"

# ── 3. The update, exactly as the web app requests it ────────────────────────
log "Updating $FROM → $TO through the updater"
jq -n --rawfile t "$BASE/templates/docker-compose-$TO.yml" '{composeTemplate: $t}' >"$BASE/request.json"
network="$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' owlat-web-1 | tr ' ' '\n' | grep -m1 default)"
http_status="$(docker run --rm --network "$network" -u "$(id -u):$(id -g)" -v "$BASE:/work" curlimages/curl:8.10.1 \
	-sS -o /work/response.json -w '%{http_code}' --max-time 900 \
	-X POST http://updater:3200/update \
	-H 'content-type: application/json' \
	-H "x-instance-secret: $INSTANCE_SECRET" \
	--data-binary @/work/request.json)" || true
[[ -f "$BASE/response.json" ]] || fail "no response from the updater (HTTP $http_status)"

jq -r '.steps[]? | "  \(if .ok == false then "✗" else "·" end) \(.step): \((.stdout // "") | split("\n")[0] | .[0:160])"' "$BASE/response.json"
if [[ "$http_status" != "200" ]] || [[ "$(jq -r '.success' "$BASE/response.json")" != "true" ]]; then
	jq -r '.steps[]? | select(.ok == false) | "── \(.step)\n\(.stderr)"' "$BASE/response.json" | tail -n 60
	fail "update answered HTTP $http_status: $(jq -r '.error // "no error"' "$BASE/response.json")"
fi
pass "updater reported success"

failed_steps="$(jq -r '[.steps[] | select(.ok == false) | .step] | join(", ")' "$BASE/response.json")"
[[ -z "$failed_steps" ]] || fail "update succeeded but reported failed steps: $failed_steps"
pass "no step reported a failure"

# ── 4. What an operator would check ──────────────────────────────────────────
log "Verifying the stack is on $TO"
cmp -s docker-compose.yml "$BASE/templates/docker-compose-$TO.yml" || fail "docker-compose.yml was not promoted to $TO"
pass "docker-compose.yml is the $TO template"

grep -qx "OWLAT_VERSION=$TO" .env || fail ".env still pins $(grep '^OWLAT_VERSION=' .env)"
pass ".env pins OWLAT_VERSION=$TO"

[[ ! -e docker-compose.next.yml ]] || fail "the staged template was left behind"

# Waits out the updater's self-replacement too: the helper recreates it ~10s
# after the response.
check_on_release() {
	local service="$1" container="owlat-$1-1"
	for _ in $(seq 1 45); do
		local image
		image="$(docker inspect --format '{{.Config.Image}}' "$container" 2>/dev/null || true)"
		if [[ "$image" == *"/$service:$TO"* ]]; then
			local reported
			reported="$(docker exec "$container" printenv OWLAT_VERSION || true)"
			[[ "$reported" == "$TO" ]] || fail "$service runs the $TO image but reports OWLAT_VERSION=$reported"
			pass "$service runs $TO and reports it"
			return 0
		fi
		sleep 2
	done
	fail "$service is not on $TO (image: $(docker inspect --format '{{.Config.Image}}' "$container" 2>/dev/null))"
}

check_on_release web
if [[ -n "${UPDATER_IMAGE:-}" ]]; then
	# The override pins the image under test, so "replaced itself" is a new
	# container, not a new image.
	for _ in $(seq 1 45); do
		[[ "$(docker inspect --format '{{.Id}}' owlat-updater-1 2>/dev/null)" != "$updater_before" ]] && break
		sleep 2
	done
	[[ "$(docker inspect --format '{{.Id}}' owlat-updater-1)" != "$updater_before" ]] || fail "the updater never replaced itself"
	[[ "$(docker exec owlat-updater-1 printenv OWLAT_VERSION)" == "$TO" ]] || fail "the replaced updater does not report $TO"
	pass "updater replaced itself and reports $TO"
else
	check_on_release updater
fi

for _ in $(seq 1 30); do
	docker ps -q --filter label=ink.wolves.owlat.role=self-update-helper | grep -q . || break
	sleep 2
done
! docker ps -q --filter label=ink.wolves.owlat.role=self-update-helper | grep -q . ||
	fail "the self-update helper never finished"

not_running="$(docker compose ps --format '{{.Service}} {{.State}}' | awk '$2 != "running" {print $1}')"
[[ -z "$not_running" ]] || fail "not running after the update: $not_running"
pass "every service is running"

wait_for_web || fail "web does not answer after the update"
pass "web answers at $TO"

health="$(docker run --rm --network "$network" curlimages/curl:8.10.1 -fsS --retry 10 --retry-all-errors \
	-H "x-instance-secret: $INSTANCE_SECRET" http://updater:3200/health)"
if [[ -n "${UPDATER_IMAGE:-}" ]]; then
	# The image under test is tagged `ci-<sha>`, which /health rightly calls
	# drift. Every OTHER Owlat container has to be on TO.
	behind="$(jq -r --arg to "$TO" '[.containers[] | select(.service != "updater")
		| select(.image | test("^ghcr.io/wolvesdotink/")) | select(.imageTag != $to) | .service] | join(", ")' <<<"$health")"
	[[ -z "$behind" ]] || fail "updater /health reports containers behind $TO: $behind"
	pass "updater /health sees every Owlat container on $TO"
else
	drift="$(jq -r '.versionDrift' <<<"$health")"
	[[ "$drift" == "false" ]] || fail "the replaced updater reports version drift: $drift"
	pass "updater /health reports no version drift"
fi

if docker image inspect "$from_deploy_image" >/dev/null 2>&1; then
	# Only an updater that reclaims space removes it; FROM's may predate that.
	reclaim="$(jq -r '.steps[] | select(.step == "reclaim-images") | .stdout' "$BASE/response.json")"
	[[ -z "$reclaim" ]] || fail "reclaim-images ran ($reclaim) but left $FROM's unused convex-deploy image"
	echo "  (this updater does not reclaim images; $FROM's convex-deploy image is still on disk)"
else
	pass "$FROM's unused convex-deploy image was reclaimed before the pull"
fi

log "Update $FROM → $TO works end to end"
