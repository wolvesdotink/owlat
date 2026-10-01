#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# Owlat Restore
#
# Restores a backup produced by scripts/backup.sh. The archive and every
# volume payload inside it are verified BEFORE anything destructive happens.
# Then the stack is stopped (the restore aborts if it will not stop), the
# current contents of each volume are copied to <volume>-pre-restore-<time>,
# and the volumes are repopulated. If any step fails, or the restore is
# interrupted (Ctrl-C), the old data is put back and the previous stack
# restarted. .env is restored from the backup unless --keep-env is specified;
# the override, Caddyfile and .owlat-flags.json (the CLI's copy of the feature
# flags) belong to the restored database and are restored either way.
# On a fresh host with no .env yet, Compose reads the archive's .env until the
# restored one is in place.
#
# The volumes are restored into the Compose project the RESTORED configuration
# starts (its .env, or the current one with --keep-env, plus its override),
# which can differ from the project running here now. The restore stops when
# that cannot be worked out before any volume is touched.
#
# Usage:
#   bash scripts/restore.sh path/to/owlat-20260101-123456.tar.gz
#   bash scripts/restore.sh --keep-env path/to/archive.tar.gz
#                                        # keep current .env (don't restore backup's)
#   OWLAT_RESTORE_YES=1 bash scripts/restore.sh ...   # skip confirmation
#
# This is DESTRUCTIVE. Existing volume data is replaced; the pre-restore
# copies need as much free disk as the volumes they copy and are kept until
# you remove them. The current .env, docker-compose.override.yml, Caddyfile
# and .owlat-flags.json are preserved as <file>.before-restore-YYYYMMDD-HHMMSS.
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Args ──────────────────────────────────────────────────────────────────────
KEEP_ENV=0
ARCHIVE=""

while [[ $# -gt 0 ]]; do
	case "$1" in
		--keep-env)
			KEEP_ENV=1
			shift
			;;
		--yes|-y)
			OWLAT_RESTORE_YES=1
			shift
			;;
		--help|-h)
			sed -n '4,31p' "$0" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		-*)
			echo "Unknown flag: $1" >&2
			exit 2
			;;
		*)
			ARCHIVE="$1"
			shift
			;;
	esac
done

# ── Colors ────────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
	CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
	BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
else
	CYAN=''; GREEN=''; YELLOW=''; RED=''; BOLD=''; DIM=''; RESET=''
fi

info()  { printf '%b\n' "${CYAN}${BOLD}[info]${RESET} $*"; }
ok()    { printf '%b\n' "${GREEN}${BOLD}[ ok ]${RESET} $*"; }
warn()  { printf '%b\n' "${YELLOW}${BOLD}[warn]${RESET} $*"; }
die()   { printf '%b\n' "${RED}${BOLD}[err ]${RESET} $*" >&2; exit 1; }

# ── Preflight ─────────────────────────────────────────────────────────────────
[[ -n "$ARCHIVE" ]]          || die "Usage: $0 [--keep-env] <archive.tar.gz>"
[[ -f "$ARCHIVE" ]]           || die "Archive not found: $ARCHIVE"
[[ -f docker-compose.yml ]]   || die "Run this from the Owlat repo root (docker-compose.yml not found)."
command -v docker >/dev/null  || die "Docker is required."
command -v tar >/dev/null     || die "tar is required to verify the archive."

# Resolve to absolute path since we'll chdir via docker volume mount
ARCHIVE_ABS=$(cd "$(dirname "$ARCHIVE")" && pwd)/$(basename "$ARCHIVE")
STAMP=$(date -u +%Y%m%d-%H%M%S)

# ── Verify checksum (when backup.sh's sidecar file is present) ────────────────
# The sidecar covers the whole archive, so it also vouches for every inner
# volume.tar — backup.sh writes no separate per-volume checksums.
if [[ -f "${ARCHIVE_ABS}.sha256" ]]; then
	EXPECTED=$(cut -d' ' -f1 < "${ARCHIVE_ABS}.sha256")
	if command -v sha256sum >/dev/null 2>&1; then
		ACTUAL=$(sha256sum "$ARCHIVE_ABS" | cut -d' ' -f1)
	elif command -v shasum >/dev/null 2>&1; then
		ACTUAL=$(shasum -a 256 "$ARCHIVE_ABS" | cut -d' ' -f1)
	else
		ACTUAL=""
	fi
	if [[ -n "$ACTUAL" ]]; then
		[[ "$ACTUAL" == "$EXPECTED" ]] || die "SHA256 mismatch — archive is corrupt or tampered with (expected ${EXPECTED}, got ${ACTUAL})."
		ok "Checksum verified"
	else
		warn "No sha256 tool available — skipping checksum verification"
	fi
else
	warn "No ${ARCHIVE_ABS}.sha256 next to the archive — skipping checksum verification"
fi

# ── Extract + validate BEFORE anything destructive ────────────────────────────
STAGING=$(mktemp -d -t owlat-restore-XXXXXX)
trap 'rm -rf "$STAGING"' EXIT

info "Extracting archive…"
tar -xzf "$ARCHIVE_ABS" -C "$STAGING" || die "Archive failed to extract — refusing to touch the running stack."

[[ -f "$STAGING/MANIFEST.txt" ]] || die "Archive is missing MANIFEST.txt — not an Owlat backup."

# Collect the volume payloads the archive actually carries.
VOLUME_DIRS=()
for dir in "$STAGING"/*/; do
	[[ -f "${dir}volume.tar" ]] && VOLUME_DIRS+=("${dir%/}")
done
[[ ${#VOLUME_DIRS[@]} -gt 0 ]] || die "Archive contains no volume payloads — refusing to wipe anything."
if [[ ! -f "$STAGING/convex-data/volume.tar" ]]; then
	warn "Archive has NO convex-data payload — the database will NOT be restored."
fi

# Every payload the manifest promises must be present: a backup copied
# offsite without its sidecar could have lost members and still extract.
while IFS= read -r listed; do
	[[ -f "$STAGING/$listed" ]] || die "MANIFEST.txt lists $listed but the archive does not contain it — refusing to restore a partial backup."
done < <(sed -n 's|^  \([^ /]*/volume\.tar\)$|\1|p' "$STAGING/MANIFEST.txt")

# Read every inner archive end to end. A truncated or corrupt payload must
# fail here, while the stack is still running on its current data, not
# halfway through replacing the volumes. backup.sh always archives `.`, so
# even an empty volume yields at least one entry; an empty listing means a
# zero-byte or blank payload that would silently restore nothing.
for dir in "${VOLUME_DIRS[@]}"; do
	suffix=$(basename "$dir")
	entries=$(tar -tf "$dir/volume.tar" 2>/dev/null | wc -l) \
		|| die "Payload ${suffix}/volume.tar is corrupt or truncated — refusing to touch the running stack."
	[[ "${entries// /}" -gt 0 ]] \
		|| die "Payload ${suffix}/volume.tar is empty — refusing to touch the running stack."
done
ok "All ${#VOLUME_DIRS[@]} volume payloads verified"

echo ""
sed 's/^/  /' "$STAGING/MANIFEST.txt"
echo ""

# ── Compose invocation ────────────────────────────────────────────────────────
# The compose file requires secrets (`${REDIS_PASSWORD:?…}` and others), so on
# a fresh host — the disaster-recovery case, where the repo was just cloned
# and there is no .env yet — every compose command fails. Until the restored
# .env is in place, give Compose the archive's copy instead.
HAD_ENV=0
[[ -f .env ]] && HAD_ENV=1
if [[ $HAD_ENV -eq 0 && $KEEP_ENV -eq 1 ]]; then
	die "--keep-env was given, but there is no .env here to keep. Run the restore without --keep-env."
fi
compose() {
	if [[ ! -f .env && -f "$STAGING/env" ]]; then
		docker compose --env-file "$STAGING/env" "$@"
	else
		docker compose "$@"
	fi
}

# The configuration `docker compose up` reads once the restore is done: the
# archive's .env (the current one with --keep-env) and the archive's override
# (the current one when the archive has none). Handing those files to Compose
# explicitly answers which project and volumes the restored stack mounts
# before a single volume is touched.
RESTORED_ENV=.env
[[ $KEEP_ENV -eq 0 && -f "$STAGING/env" ]] && RESTORED_ENV="$STAGING/env"
RESTORED_OVERRIDE=""
if [[ -f "$STAGING/docker-compose.override.yml" ]]; then
	RESTORED_OVERRIDE="$STAGING/docker-compose.override.yml"
elif [[ -f docker-compose.override.yml ]]; then
	RESTORED_OVERRIDE=docker-compose.override.yml
elif [[ -f docker-compose.override.yaml ]]; then
	RESTORED_OVERRIDE=docker-compose.override.yaml
fi
restored_compose() {
	local args=()
	[[ -f "$RESTORED_ENV" ]] && args+=(--env-file "$RESTORED_ENV")
	args+=(-f docker-compose.yml)
	[[ -n "$RESTORED_OVERRIDE" ]] && args+=(-f "$RESTORED_OVERRIDE")
	docker compose "${args[@]}" "$@"
}

# ── Detect project names (volume prefix) ──────────────────────────────────────
# Two identities matter. The CURRENT project is what `down` stops and what a
# rollback restarts. The RESTORED project is what `up` starts after the config
# files are replaced, so its volumes are the ones that receive the data. They
# differ when the archived .env or override names another project; restoring
# into the current project's volumes then left the data where the started
# stack never looks.
# Compose's own normalization: lowercase, only [a-z0-9_-], no leading _ or -.
normalize_project() { tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]//g;s/^[_-]*//'; }
unquote() { sed "s/^[[:space:]]*[\"']//;s/[\"'][[:space:]]*\$//"; }
# The last assignment of $1 in the env file $2, the way Compose reads it.
env_value() {
	sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}$1=//p" "$2" | tail -1 | unquote
}

# COMPOSE_FILE, or a compose.yaml that Compose prefers over
# docker-compose.yml, swaps the file set `up` reads for one this script cannot
# hand to Compose alongside the archived override.
if [[ -n "${COMPOSE_FILE:-}" ]] \
	|| { [[ -f "$RESTORED_ENV" ]] && [[ -n "$(env_value COMPOSE_FILE "$RESTORED_ENV")" ]]; }; then
	die "COMPOSE_FILE is set (in the shell or the .env being restored). The restore can only work out which volumes docker compose up mounts for docker-compose.yml plus docker-compose.override.yml. Unset COMPOSE_FILE and run the restore again — nothing was changed."
fi
for file in compose.yaml compose.yml; do
	[[ ! -f "$file" ]] \
		|| die "$file is present, and Compose reads it instead of docker-compose.yml. Move it away and run the restore again — nothing was changed."
done

# For when Compose cannot read a configuration (an archived .env that predates
# a variable the compose file now requires): Compose's precedence without -p
# is COMPOSE_PROJECT_NAME from the environment, then from the env file, then a
# top-level `name:` in the override, then in docker-compose.yml, then this
# directory's name. $1 is the env file, $2 the override ("" for none).
compose_derived_project() {
	local env_file="$1" override="$2" name="${COMPOSE_PROJECT_NAME:-}" file
	if [[ -z "$name" && -f "$env_file" ]]; then
		name=$(env_value COMPOSE_PROJECT_NAME "$env_file")
	fi
	for file in "$override" docker-compose.yml; do
		[[ -z "$name" && -n "$file" && -f "$file" ]] || continue
		name=$(sed -n 's/^name:[[:space:]]*//p' "$file" | head -1 | unquote)
	done
	# An interpolated name needs Compose itself, which just failed. Guessing
	# past it could put the data where nothing reads it.
	[[ "$name" != *'$'* ]] || return 1
	[[ -n "$name" ]] || name=$(basename "$PWD")
	printf '%s\n' "$name" | normalize_project
}
# `docker compose config` prints the resolved project as `name:` and every
# top-level volume an active service mounts with the name Docker knows it by,
# explicit `name:` or not. A payload whose volume no active service mounts
# keeps Compose's default "<project>_<key>" name.
config_project() { sed -n 's/^name: //p' | head -1; }
config_volumes() {
	awk '/^[^ ]/ { in_volumes = ($0 == "volumes:"); next }
		in_volumes && /^  [^ ]/ { key = $1; sub(/:$/, "", key); gsub(/["\047]/, "", key); next }
		in_volumes && /^    name: / { name = $2; gsub(/["\047]/, "", name); print key, name }'
}
# The live volume each archived payload goes into, "<compose key> <name>" per
# line in VOLUME_DIRS order. $1 is the project, $2 the config_volumes output.
# backup.sh names a payload after the volume minus the "<project>_" prefix, so
# an explicitly named volume's payload carries its full name.
volume_targets() {
	local project="$1" volumes="$2" dir suffix match
	for dir in "${VOLUME_DIRS[@]}"; do
		suffix=$(basename "$dir")
		match=$(awk -v s="$suffix" '$1 == s { print; exit }' <<<"$volumes")
		[[ -n "$match" ]] || match=$(awk -v s="$suffix" '$2 == s { print; exit }' <<<"$volumes")
		[[ -n "$match" ]] || match="$suffix ${project}_${suffix}"
		printf '%s\n' "$match"
	done
}

MANIFEST_PROJECT=$(sed -n 's/^Project name:[[:space:]]*//p' "$STAGING/MANIFEST.txt" | head -1 | normalize_project)
COMPOSE_ERR="$STAGING/compose-config.err"

CURRENT_ENV=.env
[[ -f .env ]] || CURRENT_ENV="$STAGING/env"
CURRENT_PROJECT=""
if CONFIG=$(compose config 2>/dev/null); then
	CURRENT_PROJECT=$(config_project <<<"$CONFIG")
fi
if [[ -z "$CURRENT_PROJECT" ]]; then
	CURRENT_PROJECT=$(compose_derived_project "$CURRENT_ENV" docker-compose.override.yml) \
		|| die "Could not determine the current Compose project name — nothing was changed. Set COMPOSE_PROJECT_NAME and run the restore again."
fi

PROJECT=""
RESTORED_VOLUMES=""
RESOLVED_BY_COMPOSE=0
if CONFIG=$(restored_compose config 2>"$COMPOSE_ERR"); then
	PROJECT=$(config_project <<<"$CONFIG")
	RESTORED_VOLUMES=$(config_volumes <<<"$CONFIG")
	RESOLVED_BY_COMPOSE=1
else
	warn "docker compose config failed for the configuration being restored:"
	sed 's/^/    /' "$COMPOSE_ERR" >&2
fi
if [[ -z "$PROJECT" ]]; then
	PROJECT=$(compose_derived_project "$RESTORED_ENV" "$RESTORED_OVERRIDE") \
		|| die "The restored configuration sets an interpolated project name that Compose could not resolve — nothing was changed. Set COMPOSE_PROJECT_NAME and run the restore again."
	warn "Could not resolve the project name from Compose; using '$PROJECT', the name docker compose up derives here."
fi
[[ -n "$PROJECT" ]] || die "Could not determine the Compose project name. Set COMPOSE_PROJECT_NAME and run the restore again."
if [[ -n "$MANIFEST_PROJECT" && "$MANIFEST_PROJECT" != "$PROJECT" ]]; then
	warn "The backup was taken from project '$MANIFEST_PROJECT'; this checkout is project '$PROJECT'. Restoring into ${PROJECT}_* volumes, which is what docker compose up uses here."
fi
if [[ $HAD_ENV -eq 1 && "$CURRENT_PROJECT" != "$PROJECT" ]]; then
	warn "This install runs as project '$CURRENT_PROJECT', but the restored configuration starts project '$PROJECT'. The data goes into the volumes '$PROJECT' mounts; the volumes of '$CURRENT_PROJECT' are left as they are."
fi
info "Project name: ${PROJECT}"

TARGETS=()        # live volume names, in restore order
TARGET_KEYS=()    # parallel to TARGETS: the volume's key in the compose file
while read -r key name; do
	TARGET_KEYS+=("$key")
	TARGETS+=("$name")
done < <(volume_targets "$PROJECT" "$RESTORED_VOLUMES")
[[ ${#TARGETS[@]} -eq ${#VOLUME_DIRS[@]} ]] \
	|| die "Could not map every volume payload to a volume of project '$PROJECT' — nothing was changed."
CLASHES=$(printf '%s\n' "${TARGETS[@]}" | sort | uniq -d)
[[ -z "$CLASHES" ]] \
	|| die "Several payloads in the archive map to the same volume (${CLASHES//$'\n'/, }) in the restored configuration — nothing was changed."
info "Restoring into: ${TARGETS[*]}"

# ── Confirm ───────────────────────────────────────────────────────────────────
warn "This will STOP the stack and REPLACE volume data from $ARCHIVE."
warn "Current volume data is copied to <volume>-pre-restore-${STAMP} first (needs free disk)."
if [[ "${OWLAT_RESTORE_YES:-0}" != "1" ]]; then
	read -r -p "Type 'yes' to continue: " ans
	[[ "$ans" == "yes" ]] || die "Aborted."
fi

# ── Volume helpers ────────────────────────────────────────────────────────────
# Each container gets its paths as positional arguments, never spliced into
# the command string, so volume and file names cannot change the command.
volume_exists() { docker volume inspect "$1" >/dev/null 2>&1; }
wipe_volume() {
	docker run --rm -v "$1":/dst busybox:latest \
		sh -c 'find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf {} +' sh /dst
}
copy_volume() {
	docker run --rm -v "$1":/from:ro -v "$2":/to busybox:latest \
		sh -c 'cp -a "$1"/. "$2"/' sh /from /to
}
extract_into_volume() {
	docker run --rm -v "$1":/dst -v "$(dirname "$2")":/src:ro busybox:latest \
		sh -c 'cd "$1" && tar -xf "$2"' sh /dst "/src/$(basename "$2")"
}

KEPT=()           # parallel to TARGETS: pre-restore copy, or "" when the volume did not exist
TOUCHED=0         # how many TARGETS have been (partly) overwritten

# Start the previous stack again after a failed or interrupted restore that
# has left (or put back) the original data. Without a .env before the restore
# there was no stack here to go back to.
restart_previous_and_die() {
	local reason="$1"
	if [[ $HAD_ENV -eq 0 ]]; then
		die "$reason There was no .env here before the restore, so there is no previous stack to restart."
	fi
	warn "Restarting the previous stack…"
	if docker compose up -d; then
		die "$reason The previous stack is running again on its original data.${2:-}"
	fi
	die "$reason The original data is in place, but the previous stack failed to start — run: docker compose up -d"
}

# None of the stack's data has changed: drop the half-made copies and bring the
# previous stack back as it was, then fail.
resume_and_die() {
	local reason="$1"
	local i
	for i in "${!KEPT[@]}"; do
		[[ -n "${KEPT[$i]}" ]] && docker volume rm "${KEPT[$i]}" >/dev/null 2>&1 || true
	done
	warn "No volume data was changed."
	restart_previous_and_die "$reason"
}

# Put back the pre-restore copy of every volume this run has touched so far.
rollback_and_die() {
	local reason="$1"
	local i vol keep failed=()
	warn "Putting the previous volume data back…"
	for ((i = 0; i < TOUCHED; i++)); do
		vol="${TARGETS[$i]}"
		keep="${KEPT[$i]}"
		if [[ -z "$keep" ]]; then
			# The volume did not exist before this restore.
			docker volume rm "$vol" >/dev/null 2>&1 || failed+=("$vol (created by this restore; remove it)")
		elif wipe_volume "$vol" && copy_volume "$keep" "$vol"; then
			ok "  → $vol put back"
		else
			failed+=("$vol (copy $keep back into it)")
		fi
	done
	if [[ ${#failed[@]} -gt 0 ]]; then
		printf '  %s\n' "${failed[@]}" >&2
		die "$reason Could not put back the volumes listed above. The stack is stopped; the pre-restore copies are kept."
	fi
	warn "Previous data is back in place."
	restart_previous_and_die "$reason" " The pre-restore copies (*-pre-restore-${STAMP}) can be removed with docker volume rm."
}

# The config files are only replaced after every volume is in, so a failure
# there leaves restored data and a stopped stack: say so, and what comes next.
config_die() {
	die "$1 The volumes are restored and the stack is stopped. Fix this, then run: docker compose up -d"
}

# Ctrl-C or a TERM must not leave a half-wiped volume behind silently: undo
# exactly what a failure at the same point would undo. A second signal during
# the rollback is ignored so the rollback can finish.
PHASE=prepare
on_signal() {
	trap '' INT TERM
	echo "" >&2
	case "$PHASE" in
		stopping | keeping) resume_and_die "Restore interrupted." ;;
		restoring) rollback_and_die "Restore interrupted." ;;
		config) config_die "Restore interrupted while restoring the config files (the previous ones are kept as *.before-restore-${STAMP})." ;;
		starting) die "Restore interrupted while starting the stack. The data and config are restored — run: docker compose up -d" ;;
		*) die "Restore interrupted — nothing was changed." ;;
	esac
}
trap on_signal INT TERM

# ── Stop stack ────────────────────────────────────────────────────────────────
PHASE=stopping
info "Stopping stack…"
DOWN_FAILED=0
compose down || DOWN_FAILED=1

# `down` exiting 0 is not proof: a container outside the active profiles, or
# one started by hand, can still hold a volume open and keep writing into it
# while it is being replaced. Equally, `down` failing is not a blocker when
# nothing of the project runs (a fresh host whose archived .env lacks a
# variable the compose file now requires): these checks are the proof. `down`
# stops the current project; a restored project of another name must not be
# running either, since its volumes are the ones being replaced.
STOPPED_PROJECTS=$(printf '%s\n' "$CURRENT_PROJECT" "$PROJECT" | sort -u)
for project in $STOPPED_PROJECTS; do
	RUNNING=$(docker ps -q --filter "label=com.docker.compose.project=${project}") \
		|| die "Could not list running containers — nothing was changed."
	if [[ -n "$RUNNING" && $DOWN_FAILED -eq 1 ]]; then
		die "docker compose down failed and containers of project '${project}' are still running — nothing was changed. Stop the stack and run the restore again."
	fi
	[[ -z "$RUNNING" ]] \
		|| die "Containers of project '${project}' are still running after docker compose down — nothing was changed. Stop them and run the restore again."
done
for vol in "${TARGETS[@]}"; do
	USERS=$(docker ps -q --filter "volume=${vol}") \
		|| die "Could not list running containers — nothing was changed."
	[[ -z "$USERS" ]] \
		|| die "Volume ${vol} is still in use by a running container — nothing was changed. Stop it and run the restore again."
done
if [[ $DOWN_FAILED -eq 1 ]]; then
	warn "docker compose down failed, but no container of project '${CURRENT_PROJECT}' is running and none uses the volumes being restored — continuing."
fi
ok "Stack stopped"

# ── Keep the current data ─────────────────────────────────────────────────────
# Docker cannot rename a volume, and Compose addresses volumes by name, so the
# restore has to write into the live names. Copy the current contents aside
# first; they stay until the operator removes them.
PHASE=keeping
for vol in "${TARGETS[@]}"; do
	if ! volume_exists "$vol"; then
		KEPT+=("")
		continue
	fi
	keep="${vol}-pre-restore-${STAMP}"
	info "Keeping current $vol as $keep…"
	KEPT+=("$keep")
	docker volume create --label "owlat.restore.source=${vol}" "$keep" >/dev/null \
		|| resume_and_die "Could not create $keep."
	copy_volume "$vol" "$keep" \
		|| resume_and_die "Could not copy $vol to $keep (out of disk space?)."
done

# ── Restore volumes ───────────────────────────────────────────────────────────
restore_volume() {
	local volume="$1"
	local key="$2"
	local src_tar="$3"

	info "Restoring volume $volume…"
	if volume_exists "$volume"; then
		# Empty it in place rather than removing it: the volume keeps the
		# Compose labels backup.sh discovers volumes by.
		wipe_volume "$volume" || return 1
	else
		docker volume create \
			--label "com.docker.compose.project=${PROJECT}" \
			--label "com.docker.compose.volume=${key}" \
			"$volume" >/dev/null || return 1
	fi
	extract_into_volume "$volume" "$src_tar" || return 1
	ok "  → $volume restored"
}

# Restore every volume payload the archive carries (backup.sh discovers
# volumes dynamically, so this loop stays in sync with it by construction).
PHASE=restoring
for i in "${!VOLUME_DIRS[@]}"; do
	dir="${VOLUME_DIRS[$i]}"
	TOUCHED=$((i + 1))
	restore_volume "${TARGETS[$i]}" "${TARGET_KEYS[$i]}" "$dir/volume.tar" \
		|| rollback_and_die "Restoring ${TARGETS[$i]} failed."
done

# ── Restore config files ──────────────────────────────────────────────────────
# Only once every volume is in: a failed volume restore rolls back to the old
# data, which must keep running with the old config.
PHASE=config
preserve() {
	[[ -f "$1" ]] || return 0
	cp "$1" "$1.before-restore-${STAMP}" || config_die "Could not preserve $1."
	ok "Preserved current $1 → $1.before-restore-${STAMP}"
}
preserve .env

if [[ $KEEP_ENV -eq 1 ]]; then
	info ".env: keeping current (as requested)"
elif [[ -f "$STAGING/env" ]]; then
	cp "$STAGING/env" .env || config_die "Could not restore .env from the archive."
	# The archived .env carries every deployment secret — restore it owner-only
	# (the archive may have been created before backups were chmod 600, or the
	# mode may have been lost in an offsite copy).
	chmod 600 .env || config_die "Could not make .env owner-only (chmod 600 .env); it holds every deployment secret."
	ok "Restored .env from archive"
else
	warn "Archive has no .env — keeping existing"
fi

# The override file carries the feature-profile selection — without it,
# profile-gated services (imap, mail-sync, clamav, …) won't come back up.
if [[ -f "$STAGING/docker-compose.override.yml" ]]; then
	preserve docker-compose.override.yml
	cp "$STAGING/docker-compose.override.yml" docker-compose.override.yml \
		|| config_die "Could not restore docker-compose.override.yml from the archive."
	ok "Restored docker-compose.override.yml (feature profiles)"
fi
if [[ -f "$STAGING/Caddyfile" ]]; then
	preserve Caddyfile
	cp "$STAGING/Caddyfile" Caddyfile || config_die "Could not restore Caddyfile from the archive."
	ok "Restored Caddyfile"
fi

# .owlat-flags.json is the CLI's copy of the feature flags the restored
# database holds; `owlat doctor`, `feature` and `pack` read it, and a toggle
# rewrites the override from it. It belongs to the restored database and
# override, so it is restored even with --keep-env (which keeps only .env).
# Owner-only, like the setup wizard and the updater write it.
FLAG_MIRROR=.owlat-flags.json
if [[ -f "$STAGING/owlat-flags.json" ]]; then
	preserve "$FLAG_MIRROR"
	cp "$STAGING/owlat-flags.json" "$FLAG_MIRROR" \
		|| config_die "Could not restore $FLAG_MIRROR from the archive."
	chmod 600 "$FLAG_MIRROR" || warn "Could not make $FLAG_MIRROR owner-only (chmod 600 $FLAG_MIRROR)."
	ok "Restored $FLAG_MIRROR (CLI feature flags)"
else
	# An archive from before backups carried the file. The current copy
	# describes the install being replaced, not the restored database: keep it
	# aside rather than let a later toggle rewrite the restored profiles from it.
	if [[ -f "$FLAG_MIRROR" ]]; then
		mv "$FLAG_MIRROR" "$FLAG_MIRROR.before-restore-${STAMP}" \
			|| config_die "Could not move the current $FLAG_MIRROR aside; it describes the install being replaced."
		ok "Moved current $FLAG_MIRROR → $FLAG_MIRROR.before-restore-${STAMP}"
	fi
	warn "The archive has no $FLAG_MIRROR (backups made before it was included). Until it is written again, owlat doctor, feature and pack assume the default feature flags, not the ones the restored database holds. Check the features in the web app (/dashboard/admin/instance/features) before running owlat feature or owlat pack; the next Apply & restart on that page writes the file again."
fi

# The files now in place must start exactly the project whose volumes were
# just restored. Compare before `up`, while the stack is still down.
if [[ $RESOLVED_BY_COMPOSE -eq 1 ]]; then
	CONFIG=$(compose config 2>"$COMPOSE_ERR") \
		|| config_die "docker compose config fails with the restored config files: $(head -1 "$COMPOSE_ERR")."
	FINAL_PROJECT=$(config_project <<<"$CONFIG")
	if [[ "$FINAL_PROJECT" != "$PROJECT" ]] \
		|| [[ "$(volume_targets "$FINAL_PROJECT" "$(config_volumes <<<"$CONFIG")")" != "$(volume_targets "$PROJECT" "$RESTORED_VOLUMES")" ]]; then
		config_die "The restored config files start project '${FINAL_PROJECT}', which does not mount the restored volumes (${TARGETS[*]})."
	fi
fi

# ── Bring stack back up ───────────────────────────────────────────────────────
# Profiles come from COMPOSE_PROFILES in the restored .env and from the
# restored docker-compose.override.yml, so feature services return too.
PHASE=starting
info "Starting stack…"
compose up -d \
	|| die "The data and config are restored, but the stack failed to start. Fix the error above and run: docker compose up -d"
ok "Stack started"

echo ""
printf '%b\n' "${GREEN}${BOLD}Restore complete.${RESET}"
echo "Wait 15–30 seconds for Convex to become healthy, then:"
echo "  • Check status:  docker compose ps"
echo "  • Run doctor:    bash scripts/setup.sh doctor"
for keep in "${KEPT[@]}"; do
	[[ -n "$keep" ]] || continue
	echo "  • Once satisfied, free the pre-restore copy:  docker volume rm $keep"
done
echo ""
