# shellcheck shell=bash
# ═══════════════════════════════════════════════════════════════════════════════
# e2e-update-flow-rollback.sh — The update that has to fail and come back.
#
# Sourced by e2e-update-flow.sh for SCENARIO=rollback, from the install
# directory, once FROM is installed, healthy and seeded. The update it requests
# is TO's published template with one change: web's healthcheck can never pass.
# Everything before the readiness check therefore succeeds for real (pull,
# snapshot, convex-deploy of TO's functions, promote, `up`), and the release
# then fails readiness, which is the failure the updater must roll back.
#
# Restored data has to be proven, not assumed: rows the update left alone look
# the same whether or not anything was restored. So once the snapshot is taken
# and the release is up and on trial (journal `armed` with its deploy started,
# rollout phase `verifying`), the fixture changes both stores the snapshot
# holds: it deletes the seeded contact through TO's own functions and
# overwrites a Redis sentinel written at FROM, and reads both changes back.
# The readiness check is still waiting at that point (it gives web its whole
# bound before failing), and the fixture checks that afterwards: a change that
# landed after the rollback began would prove nothing, so it fails the run.
#
# After the answer: the rollback must have put back what FROM had, which is
# FROM's compose file, override and `.env` byte for byte, the same image on
# every service, the updater not replaced, web and the Convex deployment
# reporting FROM, the Redis sentinel's FROM value and every seeded Convex
# document (compared against FROM, so no TO rewrite allowance applies).
# ═══════════════════════════════════════════════════════════════════════════════

JOURNAL=.owlat-update-snapshot/snapshot.json
ROLLOUT_RECORD=.owlat-last-rollout.json
SENTINEL_KEY=owlat:e2e-update-flow:sentinel

# Writes template $1 to $2 with web's healthcheck replaced by one that always
# fails, or with that one added after web's image when web declares none
# (releases before web had a healthcheck). Only that block changes; a template
# without a web service is refused.
failing_web_template() {
	awk '
		function failing() {
			print "    healthcheck:"
			print "      # The update flow'"'"'s rollback scenario: a probe that never passes, so"
			print "      # this release fails the readiness check once it is up."
			print "      test: [\"CMD\", \"node\", \"-e\", \"process.exit(1)\"]"
			print "      interval: 5s"
			print "      timeout: 3s"
			print "      retries: 1"
			replaced++
		}
		/^[^ #]/ { service = "" }
		/^  [^ #]/ { service = $1 }
		NR == FNR {
			if (service == "web:" && /^    healthcheck:/) declared = 1
			next
		}
		skipping && /^    [^ #]/ { skipping = 0 }
		skipping { next }
		service == "web:" && declared && /^    healthcheck:/ {
			failing()
			skipping = 1
			next
		}
		{ print }
		service == "web:" && !declared && /^    image:/ { failing() }
		END { exit replaced == 1 ? 0 : 1 }
	' "$1" "$1" >"$2" || fail "$1 has no single web service to make fail"
}

# The resolved configuration of template $1, as this install interpolates it.
resolved_config() {
	docker compose --project-directory . -f "$1" config --format json | jq -S .
}

# Proves the failing template differs from TO's only in web's healthcheck.
check_failing_template() {
	local original="$1" failing="$2" a b
	a="$(resolved_config "$original" | jq -S 'del(.services.web.healthcheck)')" ||
		fail "cannot resolve $original"
	b="$(resolved_config "$failing" | jq -S 'del(.services.web.healthcheck)')" ||
		fail "cannot resolve $failing"
	[[ "$a" == "$b" ]] || fail "the failing template changes more than web's healthcheck"
	resolved_config "$failing" | jq -e '.services.web.healthcheck.test == ["CMD", "node", "-e", "process.exit(1)"]' \
		>/dev/null || fail "the failing template's web healthcheck is not the injected one"
	pass "the request is $TO's template with only web's healthcheck made to fail"
}

redis_cli() {
	local password
	password="$(grep -m1 '^REDIS_PASSWORD=' .env | cut -d= -f2-)"
	docker compose exec -T redis redis-cli -a "$password" --no-auth-warning "$@"
}

# One line per running service: `<service> <image id>`, sorted.
service_images() {
	# shellcheck disable=SC2046
	docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}} {{.Image}}' \
		$(docker compose ps -q) | sort
}

# What the rollback has to put back, kept in $1.
record_stack() {
	local dir="$1" file
	mkdir -p "$dir"
	for file in docker-compose.yml docker-compose.override.yml .env; do
		if [[ -e "$file" ]]; then cp -p "$file" "$dir/$file"; else : >"$dir/$file.absent"; fi
	done
	service_images >"$dir/images.txt"
}

# The injected failure has to be the release's own: a service already failing
# before the update would only be a warning (readiness.ts), web included.
wait_stack_healthy() {
	local unsettled=''
	for _ in $(seq 1 90); do
		unsettled="$(docker compose ps --format '{{.Service}} {{.State}} {{.Health}}' |
			awk '$2 != "running" || ($3 != "" && $3 != "healthy") {print $1}')"
		[[ -n "$unsettled" ]] || break
		sleep 2
	done
	[[ -z "$unsettled" ]] || fail "not healthy at $FROM: $unsettled"
	pass "every service is running and healthy at $FROM"
}

# The updater under test must be one that snapshots and rolls back.
check_rollback_support() {
	local status
	status="$(docker run --rm --network "$network" curlimages/curl:8.10.1 -sS -o /dev/null \
		-w '%{http_code}' -H "x-instance-secret: $INSTANCE_SECRET" http://updater:3200/snapshot)" || true
	case "$status" in
	200) pass "the updater under test ($updater_image) snapshots and rolls back" ;;
	404) untestable "the updater under test ($updater_image) predates snapshot and rollback (GET /snapshot answered 404)" ;;
	*) fail "GET /snapshot answered HTTP $status" ;;
	esac
}

# The release is deployed, promoted, started and waiting in the readiness
# check, with the snapshot still the one the update will roll back to.
on_trial() {
	jq -e '.state == "armed" and .deployStarted == true' "$JOURNAL" >/dev/null 2>&1 &&
		jq -e '.phase == "verifying"' "$ROLLOUT_RECORD" >/dev/null 2>&1
}

# Waits until the update in flight (PID $1) is on trial. Returns 1 when the
# request ended first.
wait_for_trial() {
	local request="$1"
	for _ in $(seq 1 600); do
		on_trial && return 0
		kill -0 "$request" 2>/dev/null || return 1
		sleep 2
	done
	fail "the update never reached the readiness check"
}

# The seeded contact's id, from the baseline in $1.
seeded_contact() {
	jq -er '.roles.contact | select(type == "string" and test("^[a-z0-9]+$"))' "$1"
}

# Changes both stores after the snapshot and proves the changes landed.
change_data_after_snapshot() {
	local baseline="$1" contact deleted reload
	contact="$(seeded_contact "$baseline")" || fail "the baseline names no contact"
	deleted="$(convex_cli convex run sampleData/index:deleteTaggedRows \
		"$(jq -cn --arg id "$contact" '{table: "contacts", ids: [$id]}')" </dev/null | tail -n1)" ||
		fail "could not delete the seeded contact through $TO's functions"
	[[ "$deleted" == "1" ]] || fail "deleting the seeded contact removed $deleted rows"
	reload="$(convex_query "$(data_reload_query "[\"$contact\"]")")" || fail "could not read the contact back"
	jq -e --arg id "$contact" '.docs[$id] == null' <<<"$reload" >/dev/null ||
		fail "the seeded contact is still there after deleting it"
	pass "deleted the seeded contact after the snapshot"

	redis_cli SET "$SENTINEL_KEY" "$sentinel-changed" >/dev/null || fail "could not overwrite the Redis sentinel"
	[[ "$(redis_cli GET "$SENTINEL_KEY")" == "$sentinel-changed" ]] || fail "the Redis sentinel did not change"
	pass "overwrote the Redis sentinel after the snapshot"

	on_trial || fail "the rollback began before the fixture's changes were in, so they prove nothing"
	pass "both changes landed while the release was still on trial"
}

# Everything FROM had is back, and nothing the update did after its snapshot.
verify_rolled_back() {
	local before="$1" baseline="$2" file
	jq -e '.state == "restored"' "$JOURNAL" >/dev/null || fail "the snapshot journal is $(jq -c .state "$JOURNAL")"
	pass "the snapshot journal says restored"

	for file in docker-compose.yml docker-compose.override.yml .env; do
		if [[ -e "$before/$file.absent" ]]; then
			[[ ! -e "$file" ]] || fail "$file exists, but $FROM had none"
		else
			cmp -s "$file" "$before/$file" || fail "$file is not $FROM's"
		fi
	done
	[[ ! -e docker-compose.next.yml ]] || fail "the staged template was left behind"
	pass "the compose file, override and .env are $FROM's, byte for byte"

	local not_running images
	not_running="$(docker compose ps --format '{{.Service}} {{.State}}' | awk '$2 != "running" {print $1}')"
	[[ -z "$not_running" ]] || fail "not running after the rollback: $not_running"
	images="$(service_images)"
	[[ "$images" == "$(cat "$before/images.txt")" ]] ||
		fail "the services do not run $FROM's images: $(diff <(cat "$before/images.txt") <(echo "$images") | grep '^[<>]' | tr '\n' ' ')"
	pass "every service is running on the image it ran at $FROM"

	[[ "$(docker inspect --format '{{.Id}}' owlat-updater-1)" == "$updater_before" ]] ||
		fail "the updater replaced itself after an automatic rollback"
	! docker ps -q --filter label=ink.wolves.owlat.role=self-update-helper | grep -q . ||
		fail "a self-update helper is running after an automatic rollback"
	pass "the updater did not replace itself"

	[[ "$(docker exec owlat-web-1 printenv OWLAT_VERSION)" == "$FROM" ]] || fail "web does not report $FROM"
	wait_for_web || fail "web does not answer after the rollback"
	pass "web answers at $FROM"
	check_backend_version "$FROM"

	[[ "$(redis_cli GET "$SENTINEL_KEY")" == "$sentinel" ]] ||
		fail "the Redis sentinel is $(redis_cli GET "$SENTINEL_KEY"), not the value written at $FROM"
	pass "Redis holds the sentinel written at $FROM"

	log "Checking the Convex data seeded at $FROM"
	verify_convex_data "$baseline" "$FROM"
}

run_rollback_update() {
	check_rollback_support
	wait_stack_healthy

	sentinel="before-$(openssl rand -hex 8)"
	redis_cli SET "$SENTINEL_KEY" "$sentinel" >/dev/null || fail "could not write the Redis sentinel"
	[[ "$(redis_cli GET "$SENTINEL_KEY")" == "$sentinel" ]] || fail "the Redis sentinel did not stick"
	pass "Redis sentinel written at $FROM"
	record_stack "$BASE/before"

	log "Updating $FROM → $TO with a release that fails readiness"
	local failing="$BASE/templates/failing-$TO.yml"
	failing_web_template "$BASE/templates/docker-compose-$TO.yml" "$failing"
	check_failing_template "$BASE/templates/docker-compose-$TO.yml" "$failing"
	jq -n --rawfile t "$failing" '{composeTemplate: $t}' >"$BASE/request.json"

	post_update request.json 1800 >"$BASE/http_status" &
	local request=$! on_trial_seen=0
	if wait_for_trial "$request"; then
		on_trial_seen=1
		pass "the release was deployed and started, and is failing readiness"
		[[ "$(docker inspect --format '{{.Config.Image}}' owlat-web-1)" == *"/web:$TO"* ]] ||
			fail "web is not on $TO while the release is on trial"
		change_data_after_snapshot "$BASE/convex-data.json"
	fi
	wait "$request" || true
	local http_status problems
	http_status="$(cat "$BASE/http_status")"
	[[ -f "$BASE/response.json" ]] || fail "no response from the updater (HTTP $http_status)"
	print_steps "$BASE/response.json"
	problems="$(update_verdict rollback "$BASE/response.json" "$http_status")"
	[[ $on_trial_seen -eq 1 ]] ||
		fail "the updater answered before its release was on trial, so nothing was changed after the snapshot: $(tr '\n' ';' <<<"${problems:-HTTP $http_status}")"
	[[ -z "$problems" ]] || fail "the update did not roll back as required: $(tr '\n' ';' <<<"$problems")"
	pass "the updater answered HTTP 500, rolled-back: the release failed readiness and the snapshot was restored"

	log "Verifying the stack is back on $FROM"
	verify_rolled_back "$BASE/before" "$BASE/convex-data.json"
	log "Update $FROM → $TO failed readiness and rolled back end to end"
}
