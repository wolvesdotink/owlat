#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# e2e-update-flow.sh — Run a real in-app update, end to end, on this machine.
#
# Boots a fresh install at release FROM from its published compose template,
# seeds Convex data through it (a named contact, sent campaign, draft campaign
# and queued Send, with sending off: scripts/e2e-update-flow-data.sh), then asks
# the running updater to apply release TO (the same POST /update the web app
# sends when an operator clicks "Update now"). Two scenarios:
#
#   success   TO's template as published. The updater has to answer success
#             with every step through, and the stack has to be what an operator
#             would check: TO's images and version on every container, `.env`
#             and the compose file moved with them, the updater replaced
#             itself, the web app answers, and the seeded data is intact.
#   rollback  TO's template with web's healthcheck made to fail, so the release
#             deploys and starts and then fails the readiness check. The
#             updater has to roll it back to the snapshot it took, and the
#             stack has to be FROM again, data included
#             (scripts/e2e-update-flow-rollback.sh).
#
# Every in-app update bug so far lived in the gaps between those steps (a proxy
# that 403'd `compose up`, a version pin that never reached the containers, a
# disk that filled with superseded images), and unit tests mock exactly those
# gaps out. This drives real Docker, real images and a real Convex backend.
#
# It drives the Docker daemon it is pointed at, names its compose project
# `owlat` like a production install, ends with `docker compose down -v`, and
# the updater it runs prunes images. Run it inside a dedicated daemon, which is
# what scripts/e2e-update-flow-dind.sh does.
#
# Usage:
#   bash scripts/e2e-update-flow.sh <from-version> <to-version>
#
# Environment:
#   SCENARIO       success (default) or rollback.
#   UPDATER_IMAGE  Run this image as the FROM install's updater. This is how CI
#                  tests a change to the updater itself: the PR's updater
#                  performs a real FROM → TO rollout. Without it, `success`
#                  runs the updater FROM shipped (what an operator clicking
#                  "Update now" runs) and `rollback` runs TO's, since FROM's
#                  may predate rollback.
#   TEMPLATE_DIR   Take TO's template and checksum from this directory instead
#                  of TO's published release. The release gate tests a draft
#                  release, which has no anonymous download URL.
#   STRICT=1       Fail where a pair cannot be tested (a TO naming images that no
#                  longer pull, an updater without rollback) instead of warning
#                  and passing. The release gate and pull requests set it.
#   WORK_DIR       Where the install goes (default: a temp dir). Its basename
#                  is always `owlat`, so the compose project and container
#                  names match a production install.
#   KEEP=1         Leave the stack running afterwards, for debugging.
#
# Needs docker, docker compose, curl, jq and openssl. Uses ports 3000, 3210
# and 3211.
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

FROM="${1:-}"
TO="${2:-}"
SCENARIO="${SCENARIO:-success}"
if [[ -z "$FROM" || -z "$TO" || ! "$SCENARIO" =~ ^(success|rollback)$ ]]; then
	echo "Usage: SCENARIO=success|rollback $0 <from-version> <to-version>" >&2
	exit 2
fi
FROM="${FROM#v}"
TO="${TO#v}"

REPO="${OWLAT_REPO:-wolvesdotink/owlat}"
HERE="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/e2e-update-flow-lib.sh
source "$HERE/e2e-update-flow-lib.sh"
# shellcheck source=scripts/e2e-update-flow-data.sh
source "$HERE/e2e-update-flow-data.sh"
# shellcheck source=scripts/e2e-update-flow-rollback.sh
source "$HERE/e2e-update-flow-rollback.sh"
if [[ -n "${TEMPLATE_DIR:-}" ]]; then TEMPLATE_DIR="$(cd "$TEMPLATE_DIR" && pwd)"; fi
BASE="${WORK_DIR:-$(mktemp -d)}"
INSTALL="$BASE/owlat"
mkdir -p "$INSTALL"
cd "$INSTALL"

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
log "Fetching release templates $FROM and $TO"
fetch_template "$FROM" "$BASE/templates"
fetch_template "$TO" "$BASE/templates" "${TEMPLATE_DIR:-}"
cp "$BASE/templates/docker-compose-$FROM.yml" docker-compose.yml

# Convex moved its images from ghcr.io/get-convex/ to ghcr.io/convex/, and the
# old repository now refuses anonymous pulls. Releases up to v0.6.13 name the
# old one, and their published templates cannot change. As FROM, such a release
# is booted from the same upstream image under its new name: the updater only
# validates and pulls the TO template, so this edit never reaches the rollout.
# As TO, there is nothing to test, because no updater can pull that template.
if grep -q 'ghcr\.io/get-convex/' "$BASE/templates/docker-compose-$TO.yml"; then
	untestable "$TO names ghcr.io/get-convex/, which no longer pulls; an update to it cannot be tested"
fi
if grep -q 'ghcr\.io/get-convex/' docker-compose.yml; then
	sed -i 's#ghcr\.io/get-convex/#ghcr.io/convex/#g' docker-compose.yml
	pass "$FROM boots Convex from ghcr.io/convex/ (its ghcr.io/get-convex/ images no longer pull)"
fi

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

updater_image="${UPDATER_IMAGE:-}"
if [[ -z "$updater_image" && "$SCENARIO" == rollback ]]; then
	updater_image="$(template_image updater "$BASE/templates/docker-compose-$TO.yml")" ||
		fail "$TO's template pins no updater image"
fi
if [[ -n "$updater_image" ]]; then
	# Compose loads the override on every call, the updater's own included, so
	# the image under test also survives the updater's self-replacement.
	cat >docker-compose.override.yml <<EOF
services:
  updater:
    image: $updater_image
EOF
	pass "updater under test: $updater_image"
else
	updater_image="$(template_image updater docker-compose.yml)"
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

# ── 2b. Convex data the update has to keep ───────────────────────────────────
log "Seeding Convex data at $FROM"
# Nothing may send it: no MTA, no provider. The queued Send stays unattempted
# only because of that, and its invariant checks it did.
! grep -qE '^(EMAIL_PROVIDER|COMPOSE_PROFILES=.+)' .env || fail "this install must not be able to send mail"
seed_convex_data "$BASE/convex-data.json"

from_deploy_image="$(docker image inspect --format '{{.Id}}' \
	"$(grep -m1 -oE 'ghcr.io/[a-z0-9-]+/convex-deploy:[^[:space:]]+' docker-compose.yml)")"
updater_before="$(docker inspect --format '{{.Id}}' owlat-updater-1)"
network="$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' owlat-web-1 | tr ' ' '\n' | grep -m1 default)"

# POST /update with the request in $BASE/$1, waiting at most $2 seconds.
# Writes the answer to $BASE/response.json and prints the HTTP status.
post_update() {
	docker run --rm --network "$network" -u "$(id -u):$(id -g)" -v "$BASE:/work" curlimages/curl:8.10.1 \
		-sS -o /work/response.json -w '%{http_code}' --max-time "$2" \
		-X POST http://updater:3200/update \
		-H 'content-type: application/json' \
		-H "x-instance-secret: $INSTANCE_SECRET" \
		--data-binary "@/work/$1" || true
}

print_steps() {
	jq -r '.steps[]? | "  \(if .ok == false then "✗" else "·" end) \(.step): \((.stdout // "") | split("\n")[0] | .[0:160])"' "$1"
}

# Convex functions read OWLAT_VERSION from the deployment, not from `.env`;
# the convex-deploy command sets it after a successful deploy. A release whose
# deploy image predates that command leaves it where it was, so it is only
# checked when the running release's image runs the command.
deployment_version() {
	docker compose --profile deploy run --rm -T convex-deploy \
		sh -c 'convex env get OWLAT_VERSION </dev/null' 2>/dev/null | tail -n1
}
check_backend_version() {
	local version="$1" image backend_version
	image="$(grep -m1 -oE 'ghcr.io/[a-z0-9-]+/convex-deploy:[^[:space:]]+' docker-compose.yml)"
	if [[ "$(docker image inspect --format '{{json .Config.Cmd}}' "$image" 2>/dev/null || true)" != *owlat-convex-deploy* ]]; then
		echo "  ($version's convex-deploy image does not set the deployment's OWLAT_VERSION)"
		return 0
	fi
	backend_version="$(deployment_version)" ||
		fail "could not read OWLAT_VERSION from the Convex deployment"
	[[ "$backend_version" == "$version" ]] ||
		fail "the Convex deployment reports OWLAT_VERSION=$backend_version, not $version"
	pass "the Convex deployment reports OWLAT_VERSION=$version"
}

if [[ "$SCENARIO" == rollback ]]; then
	run_rollback_update
	exit 0
fi

# ── 3. The update, exactly as the web app requests it ────────────────────────
log "Updating $FROM → $TO through the updater"
jq -n --rawfile t "$BASE/templates/docker-compose-$TO.yml" '{composeTemplate: $t}' >"$BASE/request.json"
http_status="$(post_update request.json 900)"
[[ -f "$BASE/response.json" ]] || fail "no response from the updater (HTTP $http_status)"
print_steps "$BASE/response.json"
problems="$(update_verdict success "$BASE/response.json" "$http_status")"
if [[ -n "$problems" ]]; then
	jq -r '.steps[]? | select(.ok == false) | "── \(.step)\n\(.stderr)"' "$BASE/response.json" | tail -n 60
	fail "update answered HTTP $http_status ($(tr '\n' ';' <<<"$problems")): $(jq -r '.error // "no error"' "$BASE/response.json")"
fi
pass "updater reported success, and no step reported a failure"

# ── 4. What an operator would check ──────────────────────────────────────────
log "Verifying the stack is on $TO"
cmp -s docker-compose.yml "$BASE/templates/docker-compose-$TO.yml" || fail "docker-compose.yml was not promoted to $TO"
pass "docker-compose.yml is the $TO template"

grep -qx "OWLAT_VERSION=$TO" .env || fail ".env still pins $(grep '^OWLAT_VERSION=' .env)"
pass ".env pins OWLAT_VERSION=$TO"

[[ ! -e docker-compose.next.yml ]] || fail "the staged template was left behind"
# An updater that snapshots keeps the snapshot of a confirmed release for
# `owlat rollback`, and never leaves it armed for an automatic one.
if [[ -e "$JOURNAL" ]]; then
	jq -e '.state == "kept"' "$JOURNAL" >/dev/null || fail "the snapshot journal is $(jq -c .state "$JOURNAL") after a confirmed release"
	pass "the snapshot of $FROM is kept for owlat rollback"
fi

# Waits out the updater's self-replacement too: the helper recreates it once
# the response has been sent.
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

check_backend_version "$TO"

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

log "Checking the Convex data seeded at $FROM"
verify_convex_data "$BASE/convex-data.json" "$TO"

log "Update $FROM → $TO works end to end"
