# shellcheck shell=bash
# ═══════════════════════════════════════════════════════════════════════════════
# e2e-update-flow-lib.sh — What e2e-update-flow.sh decides its verdict with.
#
# Sourced by e2e-update-flow.sh. Kept apart from the Docker-driving steps so
# scripts/__tests__/e2e-update-flow-lib.test.ts can run the real functions:
# where a release template comes from and whether it is the one the release
# published, and what an answer from the updater has to say for a scenario to
# pass.
# ═══════════════════════════════════════════════════════════════════════════════

log() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
fail() {
	printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2
	exit 1
}
pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }

# A pair this run cannot test. A release gate (STRICT=1) must not pass on a
# test that never ran, so there it fails; a nightly run warns and stops green.
untestable() {
	[[ "${STRICT:-0}" != "1" ]] || fail "$* (STRICT=1: an untested update must not pass)"
	echo "::warning::$*"
	exit 0
}

# Puts release $1's compose template and its checksum file into directory $2
# and checks one against the other.
#
# With $3, both files must already be in that directory: a draft release has
# no anonymous download URL, so the release gate downloads its target with the
# workflow's credentials and hands the files over. A file missing there fails;
# it is never fetched from the published URL instead, where it may be absent or
# belong to another build. Without $3, both come from the published release.
fetch_template() {
	local version="$1" dir="$2" local_dir="${3:-}"
	local name="docker-compose-$version.yml"
	mkdir -p "$dir"
	if [[ -n "$local_dir" ]]; then
		[[ -f "$local_dir/$name" && -f "$local_dir/$name.sha256" ]] ||
			fail "$name or its checksum is missing from $local_dir"
		cp "$local_dir/$name" "$local_dir/$name.sha256" "$dir/"
	else
		local url="https://github.com/${REPO:?}/releases/download/v$version/$name"
		curl -fsSL "$url" -o "$dir/$name" || fail "cannot download $url"
		curl -fsSL "$url.sha256" -o "$dir/$name.sha256" || fail "cannot download $url.sha256"
	fi
	local expected actual
	expected="$(awk '{print $1; exit}' "$dir/$name.sha256")"
	actual="$(sha256sum "$dir/$name" | awk '{print $1}')"
	[[ -n "$expected" && "$expected" == "$actual" ]] || fail "checksum mismatch for $name"
}

# The image reference template $2 pins for Owlat service $1, digest included.
template_image() {
	grep -m1 -oE "ghcr\.io/[a-z0-9-]+/$1:[^[:space:]\"']+" "$2"
}

# The steps of answer $1 that the updater reported as failed, comma-separated.
failed_steps() {
	jq -r '[.steps[]? | select(.ok == false) | .step] | join(", ")' "$1"
}

# What answer $2 (HTTP status $3) gets wrong for scenario $1. One line per
# problem; silent when the answer is the one the scenario requires.
#
#   success   HTTP 200, `success: true`, and no step failed.
#   rollback  The release was deployed and started, failed the readiness check
#             and was rolled back: HTTP 500 with rollout `rolled-back`, the
#             snapshot, convex-deploy and up steps succeeded, readiness did not,
#             and the restore, the restored release's up and its readiness
#             check all succeeded. Any other failure (a refused template, a
#             pull, a deploy or an `up` that failed, a rollback that did not
#             finish) is not the failure this scenario injects.
update_verdict() {
	local scenario="$1" response="$2" status="$3"
	if ! jq -e 'type == "object"' "$response" >/dev/null 2>&1; then
		echo "the updater's answer is not a JSON object"
		return 0
	fi
	case "$scenario" in
	success)
		[[ "$status" == "200" ]] || echo "HTTP $status, not 200"
		jq -r '
			(if .success != true then "success is \(.success | tojson), not true" else empty end),
			([.steps[]? | select(.ok == false) | .step] | select(length > 0)
			 | "steps failed: \(join(", "))")
		' "$response"
		;;
	rollback)
		[[ "$status" == "500" ]] || echo "HTTP $status, not 500"
		jq -r '
			def step($name): [.steps[]? | select(.step == $name)] | last;
			def ran($name):
				step($name) as $s
				| if $s == null then "no \($name) step"
				  elif $s.ok == false then "\($name) failed: \($s.stderr // "" | split("\n")[0])"
				  else empty end;
			(if .rollout != "rolled-back" then "rollout is \(.rollout | tojson), not \"rolled-back\"" else empty end),
			(if .success == true then "the answer claims success" else empty end),
			(step("snapshot") as $s
			 | if ($s.stdout // "" | startswith("Snapshot ")) | not then "no snapshot was taken" else empty end),
			ran("snapshot"), ran("convex-deploy"), ran("write-compose"), ran("up"),
			(step("readiness") as $s
			 | if $s == null then "the release never reached the readiness check"
			   elif $s.ok != false then "the release passed the readiness check it was built to fail"
			   else empty end),
			(step("rollback-restore") as $s
			 | if $s == null then "nothing was restored"
			   elif $s.ok != true then "the restore failed: \($s.stderr // "" | split("\n")[0])"
			   else empty end),
			ran("rollback-up"),
			(step("rollback-readiness") as $s
			 | if $s == null then "the restored release was never checked"
			   elif $s.ok != true then "the restored release is not ready: \($s.stderr // "")"
			   else empty end)
		' "$response"
		;;
	*)
		echo "unknown scenario $scenario"
		;;
	esac
}
