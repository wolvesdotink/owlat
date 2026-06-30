#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# Owlat Backup
#
# Snapshots the stateful pieces of a self-hosted install into a timestamped
# tarball:
#   • every Docker volume of the compose project (convex-data, redis-data,
#     mail-certs, …) — discovered dynamically, so newly added volumes are
#     never silently missed
#   • .env, docker-compose.override.yml, Caddyfile (when present)
#
# Usage:
#   bash scripts/backup.sh                  # creates ./backups/owlat-YYYYMMDD-HHMMSS.tar.gz
#   bash scripts/backup.sh /custom/path     # writes to /custom/path/owlat-...tar.gz
#   OWLAT_BACKUP_INCLUDE_CLAMAV=0 bash scripts/backup.sh   # skip ClamAV DB (smaller)
#   OWLAT_BACKUP_INCLUDE_OLLAMA=1 bash scripts/backup.sh   # include Ollama models (huge)
#   OWLAT_BACKUP_HOT=1 bash scripts/backup.sh              # do NOT pause convex/redis (risky)
#
# Consistency: the self-hosted Convex backend stores state in SQLite, and
# Redis 7 uses a multi-part AOF — hot-copying either while writers are active
# can produce a silently corrupt snapshot that only fails at restore time.
# By default this script briefly STOPS the convex and redis containers around
# the volume copy (seconds of downtime) and restarts exactly the ones that
# were running. OWLAT_BACKUP_HOT=1 skips the pause; only use it if you accept
# possibly-torn snapshots.
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
BACKUP_DIR="${1:-$PWD/backups}"
INCLUDE_CLAMAV="${OWLAT_BACKUP_INCLUDE_CLAMAV:-1}"
INCLUDE_OLLAMA="${OWLAT_BACKUP_INCLUDE_OLLAMA:-0}"
HOT="${OWLAT_BACKUP_HOT:-0}"
TIMESTAMP=$(date -u +%Y%m%d-%H%M%S)
NAME="owlat-${TIMESTAMP}"
STAGING=$(mktemp -d -t owlat-backup-XXXXXX)

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
[[ -f docker-compose.yml ]] || die "Run this from the Owlat repo root (docker-compose.yml not found)."
command -v docker >/dev/null 2>&1 || die "Docker is required."

mkdir -p "$BACKUP_DIR"

# ── Detect project name (volume prefix) ───────────────────────────────────────
# Ask Compose itself — `docker compose config` prints the resolved project
# name, which is the only safe source (Compose's own normalization keeps
# hyphens; hand-rolled approximations diverged for dirs like "my.host-app"
# and produced "successful" backups of zero volumes).
PROJECT=$(docker compose config 2>/dev/null | sed -n 's/^name: //p' | head -1)
if [[ -z "$PROJECT" ]]; then
	PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}"
	PROJECT=$(echo "$PROJECT" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]//g;s/^[_-]*//')
	warn "Could not resolve project name from compose — falling back to '$PROJECT'"
fi

info "Project name: ${PROJECT}"
info "Staging:      $STAGING"
info "Output:       ${BACKUP_DIR}/${NAME}.tar.gz"

# ── Discover volumes ──────────────────────────────────────────────────────────
VOLUMES=$(docker volume ls -q --filter "label=com.docker.compose.project=${PROJECT}" | sort)
[[ -n "$VOLUMES" ]] || die "No volumes found for project '${PROJECT}'. Has the stack ever been started here?"

selected_volumes=()
for volume in $VOLUMES; do
	suffix="${volume#"${PROJECT}"_}"
	case "$suffix" in
		clamav-data)
			[[ "$INCLUDE_CLAMAV" == "1" ]] || { info "Skipping $suffix (OWLAT_BACKUP_INCLUDE_CLAMAV=0)"; continue; }
			;;
		ollama-data)
			[[ "$INCLUDE_OLLAMA" == "1" ]] || { info "Skipping $suffix (models are re-downloadable; OWLAT_BACKUP_INCLUDE_OLLAMA=1 to include)"; continue; }
			;;
	esac
	selected_volumes+=("$volume")
done

# ── Pause the stateful services for a consistent snapshot ─────────────────────
STOPPED_SERVICES=""
restart_services() {
	if [[ -n "$STOPPED_SERVICES" ]]; then
		info "Restarting paused services: $STOPPED_SERVICES"
		# shellcheck disable=SC2086 — intentional word splitting of service names
		docker compose start $STOPPED_SERVICES >/dev/null 2>&1 || warn "Could not restart: $STOPPED_SERVICES — start them manually (docker compose start $STOPPED_SERVICES)"
		STOPPED_SERVICES=""
	fi
}
cleanup() { restart_services; rm -rf "$STAGING"; }
trap cleanup EXIT

if [[ "$HOT" == "1" ]]; then
	warn "Hot mode: convex/redis stay up — the snapshot may be torn if writes land mid-copy."
else
	RUNNING=$(docker compose ps --services --status running 2>/dev/null || true)
	for svc in convex redis; do
		if grep -qx "$svc" <<<"$RUNNING"; then
			STOPPED_SERVICES="$STOPPED_SERVICES $svc"
		fi
	done
	STOPPED_SERVICES="${STOPPED_SERVICES# }"
	if [[ -n "$STOPPED_SERVICES" ]]; then
		info "Pausing for a consistent snapshot: $STOPPED_SERVICES"
		# shellcheck disable=SC2086
		docker compose stop $STOPPED_SERVICES >/dev/null
		ok "Paused (will restart automatically after the copy)"
	fi
fi

# ── Dump each volume ──────────────────────────────────────────────────────────
dump_volume() {
	local volume="$1"
	local dest="$2"

	info "Dumping volume $volume…"
	mkdir -p "$dest"
	docker run --rm \
		-v "$volume":/src:ro \
		-v "$dest":/dst \
		busybox:latest \
		sh -c "cd /src && tar -cf /dst/volume.tar ."
	ok   "  → $(du -sh "$dest/volume.tar" | cut -f1)"
}

captured_list=""
for volume in "${selected_volumes[@]}"; do
	suffix="${volume#"${PROJECT}"_}"
	dump_volume "$volume" "$STAGING/$suffix"
	captured_list="${captured_list}  ${suffix}/volume.tar
"
done

# Volumes are copied — bring the stateful services back before the slow
# compress/checksum phase to keep the downtime window minimal.
restart_services

# ── Copy config files ─────────────────────────────────────────────────────────
if [[ -f .env ]]; then
	cp .env "$STAGING/env"
	ok "Captured .env"
else
	warn ".env not found — restoration will need a fresh config"
fi
if [[ -f docker-compose.override.yml ]]; then
	cp docker-compose.override.yml "$STAGING/docker-compose.override.yml"
	ok "Captured docker-compose.override.yml (feature profiles)"
fi
if [[ -f Caddyfile ]]; then
	cp Caddyfile "$STAGING/Caddyfile"
	ok "Captured Caddyfile"
fi

# ── Manifest ──────────────────────────────────────────────────────────────────
cat > "$STAGING/MANIFEST.txt" <<EOF
Owlat backup
============

Taken:        $(date -u +"%Y-%m-%dT%H:%M:%SZ")
Project name: ${PROJECT}
Consistency:  $([[ "$HOT" == "1" ]] && echo "HOT (convex/redis not paused — snapshot may be torn)" || echo "convex/redis paused during volume copy")
Includes:
${captured_list}  env                      — .env file
$([[ -f "$STAGING/docker-compose.override.yml" ]] && echo "  docker-compose.override.yml — feature-profile selection")
$([[ -f "$STAGING/Caddyfile" ]] && echo "  Caddyfile                — reverse-proxy config")

To restore (fresh VPS: clone the repo, install Docker, then):
  bash scripts/restore.sh ${NAME}.tar.gz
EOF

# ── Archive ───────────────────────────────────────────────────────────────────
info "Creating archive…"
tar -czf "${BACKUP_DIR}/${NAME}.tar.gz" -C "$STAGING" .
SIZE=$(du -h "${BACKUP_DIR}/${NAME}.tar.gz" | cut -f1)

# ── Checksum ──────────────────────────────────────────────────────────────────
SHA=""
if command -v sha256sum >/dev/null 2>&1; then
	SHA=$(sha256sum "${BACKUP_DIR}/${NAME}.tar.gz" | cut -d' ' -f1)
elif command -v shasum >/dev/null 2>&1; then
	SHA=$(shasum -a 256 "${BACKUP_DIR}/${NAME}.tar.gz" | cut -d' ' -f1)
fi
[[ -n "$SHA" ]] && echo "$SHA" > "${BACKUP_DIR}/${NAME}.tar.gz.sha256"

ok "Backup complete"
echo ""
printf '  Path:   %s\n' "${BACKUP_DIR}/${NAME}.tar.gz"
printf '  Size:   %s\n' "$SIZE"
[[ -n "$SHA" ]] && printf '  SHA256: %s\n' "$SHA"
echo ""
printf '%b\n' "${DIM}Restore with: bash scripts/restore.sh ${BACKUP_DIR}/${NAME}.tar.gz${RESET}"
