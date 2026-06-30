#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# Owlat Restore
#
# Restores a backup produced by scripts/backup.sh. The archive is verified
# and fully extracted BEFORE anything destructive happens; only then is the
# stack stopped, volumes wiped, and contents repopulated. .env is restored
# from the backup unless --keep-env is specified.
#
# Usage:
#   bash scripts/restore.sh path/to/owlat-20260101-123456.tar.gz
#   bash scripts/restore.sh --keep-env path/to/archive.tar.gz
#                                        # keep current .env (don't restore backup's)
#   OWLAT_RESTORE_YES=1 bash scripts/restore.sh ...   # skip confirmation
#
# This is DESTRUCTIVE. Existing volume data is replaced. A timestamped copy
# of the current .env is preserved at .env.before-restore-YYYYMMDD-HHMMSS.
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
			sed -n '4,17p' "$0" | sed 's/^# \{0,1\}//'
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

# Resolve to absolute path since we'll chdir via docker volume mount
ARCHIVE_ABS=$(cd "$(dirname "$ARCHIVE")" && pwd)/$(basename "$ARCHIVE")

# ── Verify checksum (when backup.sh's sidecar file is present) ────────────────
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

echo ""
sed 's/^/  /' "$STAGING/MANIFEST.txt"
echo ""

# ── Confirm ───────────────────────────────────────────────────────────────────
warn "This will STOP the stack and REPLACE volume data from $ARCHIVE."
if [[ "${OWLAT_RESTORE_YES:-0}" != "1" ]]; then
	read -r -p "Type 'yes' to continue: " ans
	[[ "$ans" == "yes" ]] || die "Aborted."
fi

# ── Stop stack ────────────────────────────────────────────────────────────────
info "Stopping stack…"
docker compose down || true
ok "Stack stopped"

# ── Preserve existing .env ────────────────────────────────────────────────────
if [[ -f .env ]]; then
	BACKUP_ENV=".env.before-restore-$(date -u +%Y%m%d-%H%M%S)"
	cp .env "$BACKUP_ENV"
	ok "Preserved current .env → $BACKUP_ENV"
fi

# ── Restore config files from archive ─────────────────────────────────────────
if [[ $KEEP_ENV -eq 1 ]]; then
	info ".env: keeping current (as requested)"
elif [[ -f "$STAGING/env" ]]; then
	cp "$STAGING/env" .env
	ok "Restored .env from archive"
else
	warn "Archive has no .env — keeping existing"
fi

# The override file carries the feature-profile selection — without it,
# profile-gated services (imap, mail-sync, clamav, …) won't come back up.
if [[ -f "$STAGING/docker-compose.override.yml" ]]; then
	cp "$STAGING/docker-compose.override.yml" docker-compose.override.yml
	ok "Restored docker-compose.override.yml (feature profiles)"
fi
if [[ -f "$STAGING/Caddyfile" ]]; then
	cp "$STAGING/Caddyfile" Caddyfile
	ok "Restored Caddyfile"
fi

# ── Restore volumes ───────────────────────────────────────────────────────────
restore_volume() {
	local volume="$1"
	local src_tar="$2"

	info "Restoring volume $volume…"

	# Recreate the volume (docker volume create is idempotent but we want a clean slate)
	docker volume rm -f "$volume" >/dev/null 2>&1 || true
	docker volume create "$volume" >/dev/null

	# Extract into the volume via a short-lived container
	docker run --rm \
		-v "$volume":/dst \
		-v "$(dirname "$src_tar")":/src:ro \
		busybox:latest \
		sh -c "cd /dst && tar -xf /src/$(basename "$src_tar")"

	ok "  → $volume restored"
}

# Restore every volume payload the archive carries (backup.sh discovers
# volumes dynamically, so this loop stays in sync with it by construction).
for dir in "${VOLUME_DIRS[@]}"; do
	suffix=$(basename "$dir")
	restore_volume "${PROJECT}_${suffix}" "$dir/volume.tar"
done

# ── Bring stack back up ───────────────────────────────────────────────────────
# Profiles come from COMPOSE_PROFILES in the restored .env and from the
# restored docker-compose.override.yml, so feature services return too.
info "Starting stack…"
docker compose up -d
ok "Stack started"

echo ""
printf '%b\n' "${GREEN}${BOLD}Restore complete.${RESET}"
echo "Wait 15–30 seconds for Convex to become healthy, then:"
echo "  • Check status:  docker compose ps"
echo "  • Run doctor:    bash scripts/setup.sh doctor"
echo ""
