#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# Owlat One-Liner Installer
#
# Usage (fresh VPS):
#   curl -fsSL https://get.owlat.app | bash
#
# Non-interactive (CI / Ansible):
#   OWLAT_ASSUME_YES=1 curl -fsSL https://get.owlat.app | bash
#   OWLAT_CONFIG_FILE=/path/to/answers.env curl -fsSL https://get.owlat.app | bash
#
# This script:
#   1. Checks prerequisites (docker, docker compose v2, curl, git)
#   2. Clones github.com/wolvesdotink/owlat if not already in a clone
#   3. Delegates to scripts/setup.sh (the real wizard)
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
OWLAT_REPO="${OWLAT_REPO:-https://github.com/wolvesdotink/owlat.git}"
# Pin to the latest RELEASE by default (resolved in resolve_ref), not a moving
# branch: curl|bash asks for trust once; it should not silently re-extend that
# trust to every future commit on main. Set OWLAT_REF to override (a tag, a
# branch, or "main" if you explicitly want the bleeding edge).
OWLAT_REF="${OWLAT_REF:-${OWLAT_BRANCH:-}}"
# Default to the documented canonical home /opt/owlat — matching scripts/owlat
# (OWLAT_DIR) and the self-hosting docs — instead of an undiscoverable
# $PWD/owlat. /opt is typically root-owned, so ensure_install_dir creates it with
# sudo and hands ownership to the invoking user. Set OWLAT_INSTALL_DIR to override
# (e.g. OWLAT_INSTALL_DIR=$PWD/owlat for a rootless dev checkout).
OWLAT_INSTALL_DIR="${OWLAT_INSTALL_DIR:-/opt/owlat}"
OWLAT_ASSUME_YES="${OWLAT_ASSUME_YES:-0}"
OWLAT_CONFIG_FILE="${OWLAT_CONFIG_FILE:-}"
# This installer provisions a LINUX SERVER (writes /opt/owlat, /usr/local/bin,
# runs Docker as a long-lived daemon). It is guarded to Linux in preflight. Set
# OWLAT_ALLOW_NON_LINUX=1 to bypass the guard (advanced: e.g. evaluating locally
# on Docker Desktop for macOS/Windows).
OWLAT_ALLOW_NON_LINUX="${OWLAT_ALLOW_NON_LINUX:-0}"

# GitHub "owner/repo" derived from OWLAT_REPO for API + image references.
OWLAT_GH_SLUG="$(printf '%s' "$OWLAT_REPO" | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')"

# ── Colors ────────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
	CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'
	BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'
else
	CYAN=''; GREEN=''; YELLOW=''; RED=''; BOLD=''; DIM=''; RESET=''
fi

banner() {
	cat <<'EOF'

   ____             _       _
  / __ \__      __ | | __ _| |_
 | |  | \ \ /\ / / | |/ _` | __|
 | |__| |\ V  V /  | | (_| | |_
  \____/  \_/\_/   |_|\__,_|\__|

  Self-hosted email marketing for grown-ups.
  https://owlat.app  ·  https://docs.owlat.app

EOF
}

info()  { printf '%b\n' "${CYAN}${BOLD}[info]${RESET} $*"; }
ok()    { printf '%b\n' "${GREEN}${BOLD}[ ok ]${RESET} $*"; }
warn()  { printf '%b\n' "${YELLOW}${BOLD}[warn]${RESET} $*"; }
error() { printf '%b\n' "${RED}${BOLD}[err ]${RESET} $*" >&2; }
die()   { error "$*"; exit 1; }

# ── Preflight ─────────────────────────────────────────────────────────────────
check_cmd() {
	if ! command -v "$1" >/dev/null 2>&1; then
		die "Missing required command: $1"
	fi
}

require_linux() {
	# This installer provisions a LINUX SERVER: it sudo-writes /opt/owlat and
	# /usr/local/bin and runs Docker as a long-lived daemon. On any other OS it
	# would either clobber the host or fail confusingly, so refuse early with an
	# actionable route. The self-hosted server is Linux-only by design.
	local kernel
	kernel="$(uname -s 2>/dev/null || printf 'unknown')"

	if [[ "$kernel" == "Linux" ]]; then
		return
	fi

	if [[ "$OWLAT_ALLOW_NON_LINUX" == "1" ]]; then
		warn "Detected non-Linux host ('${kernel}') but OWLAT_ALLOW_NON_LINUX=1 — proceeding anyway."
		warn "This is unsupported: the installer expects a Linux server (Docker daemon, /opt, /usr/local/bin)."
		return
	fi

	local platform
	case "$kernel" in
		Darwin) platform="macOS" ;;
		MINGW*|MSYS*|CYGWIN*) platform="Windows" ;;
		*) platform="$kernel" ;;
	esac

	error "This installer provisions a LINUX SERVER, but it is running on ${platform}."
	error ""
	error "To run Owlat from ${platform}, choose one of:"
	error "  1. Owlat Desktop app — it SSH-provisions a fresh Linux VPS for you"
	error "     (no manual server setup). Recommended."
	error "  2. Evaluate locally with Docker Desktop — follow the manual"
	error "     docker compose steps in the self-hosting docs:"
	error "     https://docs.owlat.app"
	error ""
	error "Advanced: to force this installer to run here anyway (e.g. Docker"
	error "Desktop on macOS), re-run with OWLAT_ALLOW_NON_LINUX=1."
	die "Unsupported host OS for the server installer: ${platform}."
}

preflight() {
	info "Running preflight checks…"

	require_linux

	check_cmd curl
	check_cmd git

	if ! command -v docker >/dev/null 2>&1; then
		die "Docker is not installed. Install from https://docs.docker.com/engine/install/ and re-run."
	fi

	# A reachable daemon, not just the CLI: a stopped daemon otherwise surfaces
	# much later (and confusingly) as "setup image unavailable → bash fallback"
	# followed by a downstream docker failure. Fail fast with an actionable hint.
	if ! docker info >/dev/null 2>&1; then
		die "Docker is installed but its daemon is not reachable. Start it (e.g. 'sudo systemctl start docker', or open Docker Desktop) and re-run."
	fi

	# Docker Compose v2 ships as `docker compose` subcommand
	if ! docker compose version >/dev/null 2>&1; then
		die "Docker Compose v2 is not available. Install with the Docker Engine or via 'docker compose' plugin."
	fi

	# Install-dir writability is resolved later in ensure_install_dir (which also
	# knows about the in-clone case and can sudo-create /opt/owlat).

	ok "Preflight checks passed."
}

# ── Resolve the ref to install ────────────────────────────────────────────────
resolve_ref() {
	if [[ -n "$OWLAT_REF" ]]; then
		info "Using requested ref: $OWLAT_REF"
		return
	fi
	# Query the latest published release, but inspect the HTTP status so we can
	# tell "no releases yet" (404 → the default branch is a fine fallback) apart
	# from a hard API failure / rate-limit. On a hard failure we must NOT silently
	# downgrade to bleeding-edge 'main' — fail fast and let the operator pin a ref.
	local api_url="https://api.github.com/repos/${OWLAT_GH_SLUG}/releases/latest"
	local response http_code latest
	response=$(curl -sSL --max-time 10 -w $'\n%{http_code}' "$api_url" 2>/dev/null) || response=$'\n000'
	http_code="${response##*$'\n'}"
	latest=$(printf '%s' "${response%$'\n'*}" \
		| sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)

	if [[ -n "$latest" ]]; then
		OWLAT_REF="$latest"
		info "Installing latest release: $OWLAT_REF"
	elif [[ "$http_code" == "404" ]]; then
		# Repo reachable but no release published yet — the default branch is the
		# only sensible target.
		OWLAT_REF="main"
		warn "No published release found (HTTP 404) — falling back to the default branch 'main'."
		warn "Pin a specific version with: OWLAT_REF=v1.2.3 curl … | bash"
	else
		die "Could not resolve a release from the GitHub API (HTTP ${http_code}) for ${OWLAT_GH_SLUG}.
This is usually a transient network error or an API rate-limit, not a missing release,
so refusing to silently install the bleeding-edge 'main'. Re-run later, or pin a ref:
  OWLAT_REF=v1.2.3 curl … | bash   # a release tag
  OWLAT_REF=main   curl … | bash   # the bleeding edge, if you really want it"
	fi
}

# ── Resolve & prepare the install directory ───────────────────────────────────
# The default is /opt/owlat (see OWLAT_INSTALL_DIR above). Print the resolved
# path prominently, and when /opt isn't writable for the current user, create the
# directory with sudo and chown it to the invoker — otherwise the failure would
# only surface much later as an opaque clone permission error.
ensure_install_dir() {
	# Already inside a clone? Install in place; ensure_repo confirms and reuses it.
	if [[ -f "$PWD/scripts/setup.sh" && -f "$PWD/docker-compose.yml" ]]; then
		OWLAT_INSTALL_DIR="$PWD"
		info "Install directory: ${BOLD}${OWLAT_INSTALL_DIR}${RESET} (existing clone)"
		return
	fi

	info "Install directory: ${BOLD}${OWLAT_INSTALL_DIR}${RESET}"

	# An existing target dir, or a writable parent, needs no privileged setup —
	# ensure_repo clones/updates into it directly.
	if [[ -e "$OWLAT_INSTALL_DIR" || -w "$(dirname "$OWLAT_INSTALL_DIR")" ]]; then
		return
	fi

	local parent
	parent="$(dirname "$OWLAT_INSTALL_DIR")"
	if command -v sudo >/dev/null 2>&1; then
		info "Creating $OWLAT_INSTALL_DIR (sudo required for $parent)…"
		if sudo mkdir -p "$OWLAT_INSTALL_DIR" \
			&& sudo chown "$(id -u):$(id -g)" "$OWLAT_INSTALL_DIR"; then
			ok "Created $OWLAT_INSTALL_DIR (owned by $(id -un))"
			return
		fi
	fi
	die "Cannot create the install directory — $parent is not writable.
Re-run as root, or pick a writable location:
  OWLAT_INSTALL_DIR=\$PWD/owlat curl … | bash"
}

# ── Clone or detect existing ──────────────────────────────────────────────────
ensure_repo() {
	# If we're already inside a clone, use it.
	if [[ -f "$PWD/scripts/setup.sh" && -f "$PWD/docker-compose.yml" ]]; then
		OWLAT_INSTALL_DIR="$PWD"
		info "Detected existing Owlat clone at $OWLAT_INSTALL_DIR"
		return
	fi

	if [[ -d "$OWLAT_INSTALL_DIR/.git" ]]; then
		info "Existing clone at $OWLAT_INSTALL_DIR — updating to $OWLAT_REF…"
		# Do NOT swallow these errors: if the fetch or checkout fails, the
		# requested ref is NOT what gets installed, and proceeding would silently
		# run stale (or simply wrong) sources.
		if ! git -C "$OWLAT_INSTALL_DIR" fetch --depth 1 origin "$OWLAT_REF" >/dev/null 2>&1; then
			die "Failed to fetch ref '$OWLAT_REF' from origin in $OWLAT_INSTALL_DIR.
Check the ref name and your network, or remove $OWLAT_INSTALL_DIR to re-clone from scratch."
		fi
		if ! git -C "$OWLAT_INSTALL_DIR" checkout --detach FETCH_HEAD >/dev/null 2>&1; then
			die "Failed to check out '$OWLAT_REF' in $OWLAT_INSTALL_DIR after fetching it.
The existing clone may have local changes; remove $OWLAT_INSTALL_DIR to re-clone."
		fi
	else
		# Fast reachability check: fail with a clear message instead of a confusing
		# git "repository not found" / 404 emitted mid-clone. GIT_TERMINAL_PROMPT=0
		# keeps a missing/private repo from hanging on a credential prompt.
		if ! GIT_TERMINAL_PROMPT=0 git ls-remote "$OWLAT_REPO" >/dev/null 2>&1; then
			die "Cannot reach the Owlat repository: $OWLAT_REPO
Check the URL and your network (or set OWLAT_REPO to a reachable fork) and re-run."
		fi
		info "Cloning $OWLAT_REPO ($OWLAT_REF) into $OWLAT_INSTALL_DIR…"
		if [[ "$OWLAT_REF" =~ ^[0-9a-fA-F]{40}$ ]]; then
			# `git clone --branch <sha>` hard-fails with an opaque "Remote branch
			# <sha> not found" — --branch only accepts tags/branches. Full-clone
			# (all branches) then detach onto the exact commit so a commit-SHA pin
			# works instead of dying mid-install.
			if ! git clone "$OWLAT_REPO" "$OWLAT_INSTALL_DIR"; then
				die "Failed to clone $OWLAT_REPO into $OWLAT_INSTALL_DIR."
			fi
			if ! git -C "$OWLAT_INSTALL_DIR" checkout --detach "$OWLAT_REF" >/dev/null 2>&1; then
				die "Commit $OWLAT_REF was not found in $OWLAT_REPO.
OWLAT_REF must be a tag, a branch, or a commit reachable on the remote."
			fi
		else
			git clone --depth 1 --branch "$OWLAT_REF" "$OWLAT_REPO" "$OWLAT_INSTALL_DIR"
		fi
	fi

	ok "Repository ready at $OWLAT_INSTALL_DIR"
}

# ── Install owlat CLI symlink ─────────────────────────────────────────────────
install_owlat_cli() {
	local cli_target="/usr/local/bin/owlat"

	# Only install if we have write access (or can sudo) and it's not already present
	# pointing at this clone.
	if [[ -L "$cli_target" ]]; then
		local existing_target
		existing_target=$(readlink "$cli_target")
		if [[ "$existing_target" == "$OWLAT_INSTALL_DIR/scripts/owlat" ]]; then
			return  # Already linked to us
		fi
	fi

	if [[ -w "$(dirname "$cli_target")" ]]; then
		ln -sf "$OWLAT_INSTALL_DIR/scripts/owlat" "$cli_target"
		ok "Installed 'owlat' CLI → $cli_target"
	elif command -v sudo >/dev/null 2>&1; then
		info "Installing 'owlat' CLI to $cli_target (sudo required)…"
		sudo ln -sf "$OWLAT_INSTALL_DIR/scripts/owlat" "$cli_target" \
			&& ok "Installed 'owlat' CLI → $cli_target" \
			|| warn "Could not install owlat CLI — run manually: sudo ln -s $OWLAT_INSTALL_DIR/scripts/owlat $cli_target"
	else
		warn "Cannot install 'owlat' CLI without sudo — add $OWLAT_INSTALL_DIR/scripts to PATH or symlink scripts/owlat yourself"
	fi
}

# ── Hand off to the setup wizard ──────────────────────────────────────────────
# As of v0.2, the wizard lives in the owlat/setup Docker container (built from
# apps/setup-cli/) so we don't require Bun or Node on the host. The legacy bash
# wizard (scripts/setup.sh) is still available via `--legacy` for one release
# cycle.
run_wizard() {
	cd "$OWLAT_INSTALL_DIR"

	local use_legacy="${OWLAT_LEGACY_WIZARD:-0}"
	for arg in "$@"; do
		if [[ "$arg" == "--legacy" ]]; then
			use_legacy=1
		fi
	done

	local args=()
	if [[ "$OWLAT_ASSUME_YES" == "1" ]]; then
		args+=("--assume-yes")
	fi
	if [[ -n "$OWLAT_CONFIG_FILE" && ! -r "$OWLAT_CONFIG_FILE" ]]; then
		die "OWLAT_CONFIG_FILE is not readable: $OWLAT_CONFIG_FILE"
	fi
	args+=("$@")

	# The bash wizard runs on the HOST, where the original config path is valid,
	# so it can take `--config <host-path>` directly. The containerized wizard
	# can't see the host path — there we export OWLAT_CONFIG_FILE and let
	# scripts/owlat bind-mount it and rewrite --config to the in-container path.
	local bash_args=("${args[@]}")
	if [[ -n "$OWLAT_CONFIG_FILE" ]]; then
		bash_args+=("--config" "$OWLAT_CONFIG_FILE")
	fi

	if [[ "$use_legacy" == "1" ]]; then
		info "Launching legacy bash setup wizard…"
		echo
		exec bash scripts/setup.sh "${bash_args[@]}"
	fi

	# The containerized wizard needs the owlat/setup image. Verify it is
	# pullable (or already present) BEFORE handing off — otherwise fall back
	# to the legacy bash wizard instead of dying mid-install on
	# 'manifest unknown'.
	# Pin the wizard image to the release we just checked out (vX.Y.Z → X.Y.Z, and
	# a bare X.Y.Z tag too). A branch, "main", or a commit SHA has no matching
	# immutable image tag, so fall back to the mutable ':latest' — but say so
	# loudly, since that wizard image may not match the pinned sources.
	local setup_tag="latest"
	local ref_ver="${OWLAT_REF#v}"
	# On the PULL path the compose file interpolates the stack image tags from
	# OWLAT_VERSION. A release ref (vX.Y.Z → X.Y.Z) has cosign-signed images
	# published under that exact tag, so thread the resolved semver through to
	# quickstart, which pins OWLAT_VERSION=<semver> into .env BEFORE the first
	# `docker compose up`. Left unset it would fall back to the never-pushed
	# `:dev` sentinel and rebuild every image from source on the box (or fail
	# "manifest unknown") instead of deploying the signed release images.
	local -a version_args=()
	if [[ "$ref_ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
		setup_tag="$ref_ver"
		version_args=(--owlat-version "$ref_ver")
	else
		warn "Could not pin the setup wizard image to ref '$OWLAT_REF' (not a vX.Y.Z release tag) — using the mutable ':latest' wizard image, which may not match the checked-out sources."
	fi
	local setup_image="${OWLAT_SETUP_IMAGE:-ghcr.io/${OWLAT_GH_SLUG%/*}/setup:${setup_tag}}"
	if ! docker image inspect "$setup_image" >/dev/null 2>&1 \
		&& ! docker pull "$setup_image" >/dev/null 2>&1; then
		warn "Setup image $setup_image is not available — falling back to the bash wizard."
		echo
		exec bash scripts/setup.sh "${bash_args[@]}"
	fi

	# Route to the end-to-end `quickstart` flow (config + docker up + convex
	# deploy + env-set + admin bootstrap + demo seed), not config-only `setup`.
	# `--terminal` forces the in-container TUI wizard (the browser-based web
	# wizard cannot run inside the containerized installer).
	info "Launching setup wizard (containerized quickstart)…"
	echo
	OWLAT_SETUP_IMAGE="$setup_image" OWLAT_CONFIG_FILE="$OWLAT_CONFIG_FILE" \
		exec "$OWLAT_INSTALL_DIR/scripts/owlat" quickstart --terminal \
		${version_args[@]+"${version_args[@]}"} "${args[@]}"
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
	banner
	preflight
	resolve_ref
	ensure_install_dir
	ensure_repo
	install_owlat_cli
	run_wizard "$@"
}

main "$@"
