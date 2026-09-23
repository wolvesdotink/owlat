#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# Owlat Restore
#
# Restores a backup produced by scripts/backup.sh. The archive and every
# volume payload inside it are verified BEFORE anything destructive happens.
# Then the stack is stopped (the restore aborts if it will not stop), the
# current contents of each volume are copied to <volume>-pre-restore-<time>,
# and the volumes are repopulated. If any step fails, the old data is put back
# and the previous stack restarted. .env is restored from the backup unless
# --keep-env is specified.
#
# Usage:
#   bash scripts/restore.sh path/to/owlat-20260101-123456.tar.gz
#   bash scripts/restore.sh --keep-env path/to/archive.tar.gz
#                                        # keep current .env (don't restore backup's)
#   OWLAT_RESTORE_YES=1 bash scripts/restore.sh ...   # skip confirmation
#
# This is DESTRUCTIVE. Existing volume data is replaced; the pre-restore
# copies need as much free disk as the volumes they copy and are kept until
# you remove them. The current .env, docker-compose.override.yml and
# Caddyfile are preserved as <file>.before-restore-YYYYMMDD-HHMMSS.
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
			sed -n '4,22p' "$0" | sed 's/^# \{0,1\}//'
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

# ── Detect project name (volume prefix) — same logic as backup.sh ─────────────
PROJECT=$(docker compose config 2>/dev/null | sed -n 's/^name: //p' | head -1)
if [[ -z "$PROJECT" ]]; then
	PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}"
	PROJECT=$(echo "$PROJECT" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]//g;s/^[_-]*//')
	warn "Could not resolve project name from compose — falling back to '$PROJECT'"
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

TARGETS=()        # live volume names, in restore order
KEPT=()           # parallel to TARGETS: pre-restore copy, or "" when the volume did not exist
TOUCHED=0         # how many TARGETS have been (partly) overwritten
for dir in "${VOLUME_DIRS[@]}"; do
	TARGETS+=("${PROJECT}_$(basename "$dir")")
done

# The stack was running before the restore and none of its data has changed:
# bring it back as it was, then fail.
resume_and_die() {
	local reason="$1"
	local i
	for i in "${!KEPT[@]}"; do
		[[ -n "${KEPT[$i]}" ]] && docker volume rm "${KEPT[$i]}" >/dev/null 2>&1 || true
	done
	warn "No volume data was changed. Restarting the previous stack…"
	if docker compose up -d; then
		die "$reason The previous stack is running again on its original data."
	fi
	die "$reason No data was changed, but the previous stack failed to start — run: docker compose up -d"
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
	warn "Previous data is back in place. Restarting the previous stack…"
	if docker compose up -d; then
		die "$reason The previous stack is running again on its original data. The pre-restore copies (*-pre-restore-${STAMP}) can be removed with docker volume rm."
	fi
	die "$reason Previous data is back in place, but the stack failed to start — run: docker compose up -d"
}

# ── Stop stack ────────────────────────────────────────────────────────────────
info "Stopping stack…"
docker compose down \
	|| die "docker compose down failed — nothing was changed. Stop the stack and run the restore again."

# `down` exiting 0 is not proof: a container outside the active profiles, or
# one started by hand, can still hold a volume open and keep writing into it
# while it is being replaced.
RUNNING=$(docker ps -q --filter "label=com.docker.compose.project=${PROJECT}") \
	|| die "Could not list running containers — nothing was changed."
[[ -z "$RUNNING" ]] \
	|| die "Containers of project '${PROJECT}' are still running after docker compose down — nothing was changed. Stop them and run the restore again."
for vol in "${TARGETS[@]}"; do
	USERS=$(docker ps -q --filter "volume=${vol}") \
		|| die "Could not list running containers — nothing was changed."
	[[ -z "$USERS" ]] \
		|| die "Volume ${vol} is still in use by a running container — nothing was changed. Stop it and run the restore again."
done
ok "Stack stopped"

# ── Keep the current data ─────────────────────────────────────────────────────
# Docker cannot rename a volume, and Compose addresses volumes by name, so the
# restore has to write into the live names. Copy the current contents aside
# first; they stay until the operator removes them.
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
	local suffix="$2"
	local src_tar="$3"

	info "Restoring volume $volume…"
	if volume_exists "$volume"; then
		# Empty it in place rather than removing it: the volume keeps the
		# Compose labels backup.sh discovers volumes by.
		wipe_volume "$volume" || return 1
	else
		docker volume create \
			--label "com.docker.compose.project=${PROJECT}" \
			--label "com.docker.compose.volume=${suffix}" \
			"$volume" >/dev/null || return 1
	fi
	extract_into_volume "$volume" "$src_tar" || return 1
	ok "  → $volume restored"
}

# Restore every volume payload the archive carries (backup.sh discovers
# volumes dynamically, so this loop stays in sync with it by construction).
for i in "${!VOLUME_DIRS[@]}"; do
	dir="${VOLUME_DIRS[$i]}"
	TOUCHED=$((i + 1))
	restore_volume "${TARGETS[$i]}" "$(basename "$dir")" "$dir/volume.tar" \
		|| rollback_and_die "Restoring ${TARGETS[$i]} failed."
done

# ── Restore config files ──────────────────────────────────────────────────────
# Only once every volume is in: a failed volume restore rolls back to the old
# data, which must keep running with the old config.
preserve() {
	[[ -f "$1" ]] || return 0
	cp "$1" "$1.before-restore-${STAMP}" || die "Could not preserve $1."
	ok "Preserved current $1 → $1.before-restore-${STAMP}"
}
preserve .env

if [[ $KEEP_ENV -eq 1 ]]; then
	info ".env: keeping current (as requested)"
elif [[ -f "$STAGING/env" ]]; then
	cp "$STAGING/env" .env || die "Could not restore .env (volumes are restored)."
	# The archived .env carries every deployment secret — restore it owner-only
	# (the archive may have been created before backups were chmod 600, or the
	# mode may have been lost in an offsite copy).
	chmod 600 .env
	ok "Restored .env from archive"
else
	warn "Archive has no .env — keeping existing"
fi

# The override file carries the feature-profile selection — without it,
# profile-gated services (imap, mail-sync, clamav, …) won't come back up.
if [[ -f "$STAGING/docker-compose.override.yml" ]]; then
	preserve docker-compose.override.yml
	cp "$STAGING/docker-compose.override.yml" docker-compose.override.yml \
		|| die "Could not restore docker-compose.override.yml (volumes are restored)."
	ok "Restored docker-compose.override.yml (feature profiles)"
fi
if [[ -f "$STAGING/Caddyfile" ]]; then
	preserve Caddyfile
	cp "$STAGING/Caddyfile" Caddyfile || die "Could not restore Caddyfile (volumes are restored)."
	ok "Restored Caddyfile"
fi

# ── Bring stack back up ───────────────────────────────────────────────────────
# Profiles come from COMPOSE_PROFILES in the restored .env and from the
# restored docker-compose.override.yml, so feature services return too.
info "Starting stack…"
docker compose up -d \
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
