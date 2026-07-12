#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════════
# Owlat Self-Hosting Setup Wizard
# A guided CLI to configure your Owlat instance
#
# Usage:
#   bash scripts/setup.sh                 # interactive wizard
#   bash scripts/setup.sh doctor          # run environment health checks
#   bash scripts/setup.sh --assume-yes    # accept all defaults (best-effort)
#   bash scripts/setup.sh --config FILE   # source FILE (KEY=VALUE) as answer overrides
# ═══════════════════════════════════════════════════════════════════════════════

# ── CLI Parsing ──────────────────────────────────────────────────────────────

SUBCOMMAND=""
ASSUME_YES=0
CONFIG_FILE=""

# Peel off a subcommand if the first arg is non-flag
if [[ $# -gt 0 && "${1:-}" != -* ]]; then
	SUBCOMMAND="$1"
	shift
fi

while [[ $# -gt 0 ]]; do
	case "$1" in
		--assume-yes|-y)
			ASSUME_YES=1
			shift
			;;
		--config)
			CONFIG_FILE="$2"
			shift 2
			;;
		--config=*)
			CONFIG_FILE="${1#*=}"
			shift
			;;
		--help|-h)
			sed -n '4,12p' "$0" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		*)
			echo "Unknown argument: $1" >&2
			echo "Run 'bash scripts/setup.sh --help' for usage." >&2
			exit 2
			;;
	esac
done

# Source config file (KEY=VALUE pairs) before main runs, so env-var-aware
# prompts and defaults can pick them up.
if [[ -n "$CONFIG_FILE" ]]; then
	if [[ ! -r "$CONFIG_FILE" ]]; then
		echo "Config file not readable: $CONFIG_FILE" >&2
		exit 2
	fi
	# shellcheck disable=SC1090
	set -a
	source "$CONFIG_FILE"
	set +a
fi

# Also honor OWLAT_ASSUME_YES env var (from install.sh)
if [[ "${OWLAT_ASSUME_YES:-0}" == "1" ]]; then
	ASSUME_YES=1
fi
export ASSUME_YES

# ── Colors & Formatting ──────────────────────────────────────────────────────

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
DIM='\033[2m'
MAGENTA='\033[0;35m'
RESET='\033[0m'

# ── State ────────────────────────────────────────────────────────────────────

declare -A CONVEX_VARS=()
declare -A NUXT_VARS=()
CONVEX_VAR_ORDER=()  # Track insertion order for deterministic output

DEPLOYMENT_MODE=""  # "dev" or "selfhost"

declare -A SELFHOST_VARS=()
SELFHOST_VAR_ORDER=()
SELFHOST_INSTANCE_SECRET=""
SELFHOST_CONVEX_ADMIN_KEY=""

EMAIL_PROVIDER=""
SITE_URL=""
CONVEX_SITE_URL_VAL=""
POSTHOG_ENABLED=false
AI_ENABLED=false
SETUP_INTERRUPTED=false

# ── Helpers ──────────────────────────────────────────────────────────────────

info()    { echo -e "  ${CYAN}ℹ${RESET}  $1"; }
success() { echo -e "  ${GREEN}✓${RESET}  $1"; }
warn()    { echo -e "  ${YELLOW}⚠${RESET}  $1"; }
error()   { echo -e "  ${RED}✗${RESET}  $1"; }

owl_say() {
  echo ""
  echo -e "  ${CYAN}🦉${RESET} ${DIM}$1${RESET}"
  echo ""
}

# Print a boxed section header
section() {
  local title="$1"
  local inner_width=54
  local text_len=${#title}
  local left_pad=$(( (inner_width - text_len) / 2 ))
  local right_pad=$(( inner_width - text_len - left_pad ))

  echo ""
  echo ""
  echo -e "  ${CYAN}┌$(printf '─%.0s' $(seq 1 $inner_width))┐${RESET}"
  echo -e "  ${CYAN}│${RESET}$(printf ' %.0s' $(seq 1 $left_pad))${BOLD}${title}${RESET}$(printf ' %.0s' $(seq 1 $right_pad))${CYAN}│${RESET}"
  echo -e "  ${CYAN}└$(printf '─%.0s' $(seq 1 $inner_width))┘${RESET}"
  echo ""
}

# Spinner for long-running commands
spinner() {
  local pid=$1
  local message=$2
  local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  local i=0

  # Hide cursor
  tput civis 2>/dev/null || true

  while kill -0 "$pid" 2>/dev/null; do
    local frame="${frames[$((i % ${#frames[@]}))]}"
    printf "\r  ${CYAN}%s${RESET}  %s" "$frame" "$message"
    sleep 0.08
    i=$((i + 1))
  done

  wait "$pid"
  local exit_code=$?

  # Show cursor
  tput cnorm 2>/dev/null || true

  printf "\r"
  # Clear the line
  printf "%-$((${#message} + 10))s\r" ""

  return $exit_code
}

# Prompt with a default value
prompt_default() {
  local message="$1"
  local default="$2"
  local varname="$3"
  local val

  if [[ -n "$default" ]]; then
    read -rp "$(echo -e "  ${BOLD}${message}${RESET} ${DIM}[${default}]${RESET}: ")" val
  else
    read -rp "$(echo -e "  ${BOLD}${message}${RESET}: ")" val
  fi
  val="${val:-$default}"
  eval "$varname=\$val"
}

# Prompt for a secret (hidden input)
prompt_secret() {
  local message="$1"
  local varname="$2"
  local val

  read -rsp "$(echo -e "  ${BOLD}${message}${RESET}: ")" val
  echo ""
  eval "$varname=\$val"
}

# Yes/No prompt (returns 0 for yes, 1 for no)
prompt_yn() {
  local message="$1"
  local default="${2:-y}"
  local hint

  if [[ "$default" == "y" ]]; then
    hint="Y/n"
  else
    hint="y/N"
  fi

  local val
  read -rp "$(echo -e "  ${BOLD}${message}${RESET} ${DIM}[${hint}]${RESET}: ")" val
  val="${val:-$default}"
  [[ "$val" =~ ^[Yy] ]]
}

# Generate a cryptographic secret
generate_secret() {
  openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64
}

# Generate a 32-byte hex secret (matches shared `generateHexSecret` and the
# `openssl rand -hex 32` form documented in every .env example — used for
# MTA_SECRET so one canonical secret format exists across installers and docs).
generate_hex_secret() {
  openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

# Store a Convex env var (tracks order)
set_convex_var() {
  local key="$1"
  local value="$2"
  CONVEX_VARS[$key]="$value"
  # Only add to order if not already present
  local found=false
  for k in "${CONVEX_VAR_ORDER[@]}"; do
    if [[ "$k" == "$key" ]]; then
      found=true
      break
    fi
  done
  if [[ "$found" == false ]]; then
    CONVEX_VAR_ORDER+=("$key")
  fi
}

# Store a self-host env var (tracks order)
set_selfhost_var() {
  local key="$1"
  local value="$2"
  SELFHOST_VARS[$key]="$value"
  local found=false
  for k in "${SELFHOST_VAR_ORDER[@]}"; do
    if [[ "$k" == "$key" ]]; then found=true; break; fi
  done
  if [[ "$found" == false ]]; then
    SELFHOST_VAR_ORDER+=("$key")
  fi
}

# ── Cleanup ──────────────────────────────────────────────────────────────────

cleanup() {
  tput cnorm 2>/dev/null || true  # Restore cursor
  if [[ "$SETUP_INTERRUPTED" == true ]]; then
    echo ""
    echo ""
    echo -e "  ${YELLOW}  (x,x)${RESET}  Oh no! Setup was interrupted."
    echo -e "  ${YELLOW}  {\"\`\"}${RESET}  Your configuration may be incomplete."
    echo -e "  ${YELLOW}  -\"-\"-${RESET}  Run ${BOLD}bash setup.sh${RESET} again to resume."
    echo ""
  fi
}

trap 'SETUP_INTERRUPTED=true; cleanup; exit 130' INT TERM
trap 'cleanup' EXIT

# ── Step 1: Welcome ─────────────────────────────────────────────────────────

show_welcome() {
  clear 2>/dev/null || true
  echo ""
  echo -e "  ${CYAN}╔════════════════════════════════════════════════════════╗${RESET}"
  echo -e "  ${CYAN}║${RESET}                                                        ${CYAN}║${RESET}"
  echo -e "  ${CYAN}║${RESET}              ${DIM},___,${RESET}          ${DIM},___,${RESET}                     ${CYAN}║${RESET}"
  echo -e "  ${CYAN}║${RESET}              ${YELLOW}(O,O)${RESET}          ${YELLOW}(O,O)${RESET}                     ${CYAN}║${RESET}"
  echo -e "  ${CYAN}║${RESET}              ${DIM}/)  )${RESET}          ${DIM}(  (\\${RESET}                     ${CYAN}║${RESET}"
  echo -e "  ${CYAN}║${RESET}            ${DIM}--\"--\"----------\"--\"--${RESET}                   ${CYAN}║${RESET}"
  echo -e "  ${CYAN}║${RESET}                                                        ${CYAN}║${RESET}"
  echo -e "  ${CYAN}║${RESET}        ${BOLD}${MAGENTA} ___  _    _ _      _  _____ ${RESET}                   ${CYAN}║${RESET}"
  echo -e "  ${CYAN}║${RESET}        ${BOLD}${MAGENTA}/ _ \\| |  | | |    / \\|_   _|${RESET}                   ${CYAN}║${RESET}"
  echo -e "  ${CYAN}║${RESET}        ${BOLD}${MAGENTA}| | | | |  | | |   / _ \\ | |  ${RESET}                   ${CYAN}║${RESET}"
  echo -e "  ${CYAN}║${RESET}        ${BOLD}${MAGENTA}| |_| | |/\\| | |__/ ___ \\| |  ${RESET}                   ${CYAN}║${RESET}"
  echo -e "  ${CYAN}║${RESET}        ${BOLD}${MAGENTA} \\___/|__/\\__|____/_/   \\_\\_|  ${RESET}                   ${CYAN}║${RESET}"
  echo -e "  ${CYAN}║${RESET}                                                        ${CYAN}║${RESET}"
  echo -e "  ${CYAN}║${RESET}          ${DIM}Self-Hosting Setup Wizard  v2.0${RESET}                ${CYAN}║${RESET}"
  echo -e "  ${CYAN}║${RESET}                                                        ${CYAN}║${RESET}"
  echo -e "  ${CYAN}╚════════════════════════════════════════════════════════╝${RESET}"
  echo ""

  owl_say "Hoot hoot! Let's get your nest set up!"

  echo -e "  This wizard will guide you through configuring Owlat"
  echo -e "  for self-hosting. It takes about ${BOLD}5-10 minutes${RESET}."
  echo ""
  echo -e "  ${DIM}You can press Ctrl+C at any time to exit safely.${RESET}"
  echo ""

  read -rp "$(echo -e "  Press ${BOLD}Enter${RESET} to begin... ")" _
}

# ── Deployment Mode Selection ──────────────────────────────────────────────

select_deployment_mode() {
  section "Deployment Mode"

  echo -e "  How would you like to run Owlat?"
  echo ""
  echo -e "    ${BOLD}1)${RESET}  ${GREEN}Development${RESET} (Convex Cloud)     ${DIM}— local dev with cloud-hosted Convex backend${RESET}"
  echo -e "    ${BOLD}2)${RESET}  ${MAGENTA}Self-Hosted${RESET} (Docker Compose)  ${DIM}— full stack on your own infrastructure${RESET}"
  echo ""

  local choice
  read -rp "$(echo -e "  Enter choice ${DIM}[1]${RESET}: ")" choice
  choice="${choice:-1}"

  case "$choice" in
    2)
      DEPLOYMENT_MODE="selfhost"
      owl_say "Self-hosting it is! Full control for a wise owl."
      ;;
    *)
      DEPLOYMENT_MODE="dev"
      owl_say "Cloud dev mode! Fast feathers for rapid iteration."
      ;;
  esac
}

# ── Step 2: Prerequisites ───────────────────────────────────────────────────

check_prerequisites() {
  section "Checking Prerequisites"

  local all_good=true

  # Check we're in the right directory
  if [[ ! -f "package.json" ]] || ! grep -q '"name": "owlat"' package.json 2>/dev/null; then
    error "Not in the Owlat project root!"
    echo -e "    ${DIM}Please run this script from the root of the Owlat repository.${RESET}"
    echo ""
    exit 1
  fi
  success "Running from Owlat project root"

  # Node.js 18+
  if command -v node &>/dev/null; then
    local node_version
    node_version=$(node --version | sed 's/v//')
    local node_major
    node_major=$(echo "$node_version" | cut -d. -f1)
    if (( node_major >= 18 )); then
      success "Node.js ${node_version}"
    else
      error "Node.js ${node_version} (need 18+)"
      all_good=false
    fi
  else
    error "Node.js not found"
    echo -e "    ${DIM}Install: https://nodejs.org or use nvm/fnm${RESET}"
    all_good=false
  fi

  # Bun
  if command -v bun &>/dev/null; then
    local bun_version
    bun_version=$(bun --version 2>/dev/null || echo "unknown")
    success "Bun ${bun_version}"
  else
    error "Bun not found"
    echo -e "    ${DIM}Install: curl -fsSL https://bun.sh/install | bash${RESET}"
    all_good=false
  fi

  # git
  if command -v git &>/dev/null; then
    success "git $(git --version | awk '{print $3}')"
  else
    error "git not found"
    echo -e "    ${DIM}Install: https://git-scm.com/downloads${RESET}"
    all_good=false
  fi

  # openssl
  if command -v openssl &>/dev/null; then
    success "openssl available"
  else
    error "openssl not found"
    echo -e "    ${DIM}Needed for generating secrets. Install via your package manager.${RESET}"
    all_good=false
  fi

  # npx (comes with Node.js)
  if command -v npx &>/dev/null; then
    success "npx available"
  else
    error "npx not found (should come with Node.js)"
    all_good=false
  fi

  echo ""

  if [[ "$all_good" == false ]]; then
    error "Some prerequisites are missing. Please install them and try again."
    echo ""
    exit 1
  fi

  owl_say "All tools accounted for! Wise choice of toolkit."
}

# ── Prerequisites (Self-Hosted) ─────────────────────────────────────────────

check_prerequisites_selfhost() {
  section "Checking Prerequisites"

  local all_good=true

  # Check we're in the right directory
  if [[ ! -f "package.json" ]] || ! grep -q '"name": "owlat"' package.json 2>/dev/null; then
    error "Not in the Owlat project root!"
    echo -e "    ${DIM}Please run this script from the root of the Owlat repository.${RESET}"
    echo ""
    exit 1
  fi
  success "Running from Owlat project root"

  # Docker 20+
  if command -v docker &>/dev/null; then
    local docker_version
    docker_version=$(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
    local docker_major
    docker_major=$(echo "$docker_version" | cut -d. -f1)
    if (( docker_major >= 20 )); then
      success "Docker ${docker_version}"
    else
      error "Docker ${docker_version} (need 20+)"
      all_good=false
    fi
  else
    error "Docker not found"
    echo -e "    ${DIM}Install: https://docs.docker.com/get-docker/${RESET}"
    all_good=false
  fi

  # Docker Compose v2
  if docker compose version &>/dev/null 2>&1; then
    local compose_version
    compose_version=$(docker compose version --short 2>/dev/null || echo "unknown")
    success "Docker Compose ${compose_version}"
  else
    error "Docker Compose v2 not found"
    echo -e "    ${DIM}Install: https://docs.docker.com/compose/install/${RESET}"
    all_good=false
  fi

  # openssl
  if command -v openssl &>/dev/null; then
    success "openssl available"
  else
    error "openssl not found"
    echo -e "    ${DIM}Needed for generating secrets. Install via your package manager.${RESET}"
    all_good=false
  fi

  # git
  if command -v git &>/dev/null; then
    success "git $(git --version | awk '{print $3}')"
  else
    error "git not found"
    echo -e "    ${DIM}Install: https://git-scm.com/downloads${RESET}"
    all_good=false
  fi

  # curl
  if command -v curl &>/dev/null; then
    success "curl available"
  else
    error "curl not found"
    echo -e "    ${DIM}Needed for health checks and admin seeding. Install via your package manager.${RESET}"
    all_good=false
  fi

  # npx (Node.js) — the self-host path shells out to host `npx convex` to set
  # Convex env vars and deploy functions, so fail fast if it is missing.
  if command -v npx &>/dev/null; then
    success "npx available"
  else
    error "npx (Node.js) not found"
    echo -e "    ${DIM}Needed to run the Convex CLI for env vars. Install Node.js: https://nodejs.org/${RESET}"
    all_good=false
  fi

  echo ""

  if [[ "$all_good" == false ]]; then
    error "Some prerequisites are missing. Please install them and try again."
    echo ""
    exit 1
  fi

  owl_say "All tools accounted for! The nest is ready for Docker."
}

# ── Step 3: Install Dependencies ─────────────────────────────────────────────

install_dependencies() {
  section "Installing Dependencies"

  # Check if node_modules is already up to date
  if [[ -d "node_modules" ]] && [[ -f "bun.lock" ]]; then
    if prompt_yn "Dependencies appear installed. Reinstall?" "n"; then
      info "Reinstalling dependencies..."
    else
      success "Using existing dependencies"
      owl_say "Smart owl — no need to re-feather the nest!"
      return 0
    fi
  else
    info "Installing dependencies with Bun..."
  fi

  echo ""

  bun install --frozen-lockfile 2>/dev/null &
  local pid=$!
  # Guard the spinner so a non-zero install does not abort under `set -e`;
  # we want to fall through to the regular-install retry instead.
  if spinner "$pid" "Installing packages... this may take a minute"; then
    success "Dependencies installed successfully"
    owl_say "Dependencies are nesting nicely!"
  else
    # Retry without frozen lockfile
    warn "Frozen lockfile failed, trying regular install..."
    bun install 2>/dev/null &
    local pid2=$!
    if spinner "$pid2" "Installing packages (attempt 2)..."; then
      success "Dependencies installed successfully"
    else
      error "Failed to install dependencies"
      echo -e "    ${DIM}Try running 'bun install' manually to see the error.${RESET}"
      exit 1
    fi
  fi
}

# ── Step 4: Convex Setup ────────────────────────────────────────────────────

setup_convex() {
  section "Convex Backend Setup"

  echo -e "  Owlat uses ${BOLD}Convex${RESET} as its backend (database + serverless functions)."
  echo -e "  You'll need a free Convex account at ${CYAN}https://convex.dev${RESET}"
  echo ""

  # Check if already logged in
  local logged_in=false
  if npx convex whoami &>/dev/null 2>&1; then
    local whoami
    whoami=$(npx convex whoami 2>/dev/null || echo "")
    success "Already logged in to Convex${whoami:+ as ${BOLD}${whoami}${RESET}}"
    logged_in=true
  else
    warn "Not logged in to Convex"
    echo ""
    if prompt_yn "Log in to Convex now? (opens browser)" "y"; then
      echo ""
      info "Opening Convex login..."
      echo ""
      npx convex login || {
        error "Convex login failed"
        echo -e "    ${DIM}You can log in later with: npx convex login${RESET}"
        echo -e "    ${DIM}Continuing setup — you'll need to set Convex vars manually.${RESET}"
        echo ""
        return 0
      }
      success "Logged in to Convex"
      logged_in=true
    else
      warn "Skipping Convex login. You'll need to log in and deploy manually."
      return 0
    fi
  fi

  echo ""

  # Check if project is linked
  if [[ -f "apps/api/.env.local" ]] && grep -q "CONVEX_DEPLOYMENT" "apps/api/.env.local" 2>/dev/null; then
    success "Convex project already linked"
    # Try to extract the site URL
    local existing_url
    existing_url=$(grep "CONVEX_DEPLOYMENT" "apps/api/.env.local" 2>/dev/null | head -1 | cut -d= -f2 || echo "")
    if [[ -n "$existing_url" ]]; then
      info "Deployment: ${BOLD}${existing_url}${RESET}"
    fi
  else
    echo -e "  Would you like to:"
    echo ""
    echo -e "    ${BOLD}1)${RESET} Create a ${GREEN}new${RESET} Convex project"
    echo -e "    ${BOLD}2)${RESET} Link an ${CYAN}existing${RESET} Convex project"
    echo -e "    ${BOLD}3)${RESET} Skip for now"
    echo ""

    local choice
    read -rp "$(echo -e "  Enter choice ${DIM}[1]${RESET}: ")" choice
    choice="${choice:-1}"

    echo ""

    case "$choice" in
      1)
        info "Creating new Convex project..."
        echo ""
        (cd apps/api && npx convex init) || {
          warn "Could not create project. You can set this up later."
        }
        ;;
      2)
        local project_name
        prompt_default "Enter Convex project name" "" project_name
        if [[ -n "$project_name" ]]; then
          (cd apps/api && npx convex init --project "$project_name") || {
            warn "Could not link project. You can set this up later."
          }
        fi
        ;;
      3)
        warn "Skipping Convex project setup"
        ;;
    esac
  fi

  echo ""
  owl_say "Backend connected! The owls are watching your data."
}

# ── Step 5: Core Configuration ──────────────────────────────────────────────

configure_core() {
  section "Core Configuration"

  # Detect existing values
  local existing_site_url=""
  local existing_convex_url=""
  local existing_convex_site_url=""

  if [[ -f ".env.local" ]]; then
    owl_say "Found existing .env.local — using values as defaults."
    existing_site_url=$(grep "NUXT_PUBLIC_SITE_URL" .env.local 2>/dev/null | tail -1 | cut -d= -f2- || echo "")
    existing_convex_url=$(grep "NUXT_PUBLIC_CONVEX_URL" .env.local 2>/dev/null | tail -1 | cut -d= -f2- || echo "")
    existing_convex_site_url=$(grep "NUXT_PUBLIC_CONVEX_SITE_URL" .env.local 2>/dev/null | tail -1 | cut -d= -f2- || echo "")
  fi

  # Site URL
  echo -e "  ${BOLD}Your application URL${RESET}"
  echo -e "  ${DIM}Use http://localhost:3000 for local dev, or your domain for production.${RESET}"
  echo ""
  prompt_default "Site URL" "${existing_site_url:-http://localhost:3000}" SITE_URL
  echo ""

  # Convex URLs
  echo -e "  ${BOLD}Convex deployment URLs${RESET}"
  echo -e "  ${DIM}Find these in your Convex dashboard under Deployment Settings.${RESET}"
  echo -e "  ${DIM}For local dev, the defaults below are correct.${RESET}"
  echo ""

  local convex_url
  prompt_default "Convex URL" "${existing_convex_url:-http://127.0.0.1:3212}" convex_url
  NUXT_VARS[NUXT_PUBLIC_CONVEX_URL]="$convex_url"

  local convex_site_url
  prompt_default "Convex Site URL" "${existing_convex_site_url:-http://localhost:3210}" convex_site_url
  NUXT_VARS[NUXT_PUBLIC_CONVEX_SITE_URL]="$convex_site_url"
  CONVEX_SITE_URL_VAL="$convex_site_url"

  NUXT_VARS[NUXT_PUBLIC_SITE_URL]="$SITE_URL"
  set_convex_var "SITE_URL" "$SITE_URL"
  # CONVEX_SITE_URL is a Convex BUILT-IN (derived from CONVEX_SITE_ORIGIN on the
  # convex container); `convex env set CONVEX_SITE_URL` is rejected with
  # EnvVarNameForbidden, so pushing it here only produces a spurious "failed to
  # set". Keep it in the compose .env / NUXT_PUBLIC_CONVEX_SITE_URL above only.

  echo ""

  # Auth secret
  echo -e "  ${BOLD}Authentication Secret${RESET}"
  echo -e "  ${DIM}Used to sign sessions. Will be auto-generated if left blank.${RESET}"
  echo ""

  local auth_secret
  auth_secret=$(generate_secret)
  prompt_default "BetterAuth secret" "$auth_secret" auth_secret
  set_convex_var "BETTER_AUTH_SECRET" "$auth_secret"

  owl_say "Shh... these secrets are owl-y for your eyes."

  # Unsubscribe secret
  local unsub_secret
  unsub_secret=$(generate_secret)
  set_convex_var "UNSUBSCRIBE_SECRET" "$unsub_secret"
  success "Generated unsubscribe signing secret"

  # Default from email
  echo ""
  echo -e "  ${BOLD}Default sender identity${RESET}"
  echo -e "  ${DIM}The default \"From\" address for emails sent by Owlat.${RESET}"
  echo ""

  local from_email from_name from_domain
  prompt_default "From email" "noreply@example.com" from_email
  prompt_default "From name" "Owlat" from_name

  # Derive domain from email
  local default_domain
  default_domain=$(echo "$from_email" | cut -d@ -f2)
  prompt_default "From domain" "$default_domain" from_domain

  set_convex_var "DEFAULT_FROM_EMAIL" "$from_email"
  set_convex_var "DEFAULT_FROM_NAME" "$from_name"
  set_convex_var "DEFAULT_FROM_DOMAIN" "$from_domain"

  echo ""

  # CORS origins
  local allowed_origins="$SITE_URL"
  if [[ "$SITE_URL" != "http://localhost:3000" ]]; then
    allowed_origins="${SITE_URL},http://localhost:3000"
  fi
  set_convex_var "ALLOWED_ORIGINS" "$allowed_origins"
  success "CORS origins set to: ${BOLD}${allowed_origins}${RESET}"
}

# ── Step 6: Email Provider ──────────────────────────────────────────────────

configure_email() {
  section "Email Provider Setup"

  echo -e "  Which email provider will you use to send emails?"
  echo ""
  echo -e "    ${BOLD}1)${RESET}  ${MAGENTA}🦉${RESET} Custom MTA    ${DIM}— Self-hosted SMTP server (full control)${RESET}"
  echo -e "    ${BOLD}2)${RESET}  ${YELLOW}📦${RESET} AWS SES       ${DIM}— Amazon Simple Email Service${RESET}"
  echo -e "    ${BOLD}3)${RESET}  ${CYAN}📨${RESET} Resend        ${DIM}— Modern email API${RESET}"
  echo ""

  local choice
  read -rp "$(echo -e "  Enter choice ${DIM}[1]${RESET}: ")" choice
  choice="${choice:-1}"

  echo ""

  case "$choice" in
    1) configure_email_mta ;;
    2) configure_email_ses ;;
    3) configure_email_resend ;;
    *)
      warn "Invalid choice, defaulting to MTA"
      configure_email_mta
      ;;
  esac
}

configure_email_mta() {
  EMAIL_PROVIDER="mta"
  set_convex_var "EMAIL_PROVIDER" "mta"

  owl_say "Running your own mail server? Bold. We respect bold owls."

  echo -e "  ${BOLD}MTA Configuration${RESET}"
  echo -e "  ${DIM}The custom MTA runs as a Docker service alongside Owlat.${RESET}"
  echo ""

  local mta_url mta_key mta_webhook_secret

  prompt_default "MTA API URL" "http://localhost:3100" mta_url
  set_convex_var "MTA_API_URL" "$mta_url"

  # Auto-generate keys
  mta_key=$(generate_secret)
  prompt_default "MTA API key" "$mta_key" mta_key
  set_convex_var "MTA_API_KEY" "$mta_key"

  mta_webhook_secret=$(generate_secret)
  prompt_default "MTA webhook secret" "$mta_webhook_secret" mta_webhook_secret
  set_convex_var "MTA_WEBHOOK_SECRET" "$mta_webhook_secret"

  echo ""
  info "Don't forget to configure ${BOLD}apps/mta/.env${RESET} with matching keys!"
  info "Start the MTA with: ${BOLD}cd apps/mta && docker compose up${RESET}"
}

configure_email_ses() {
  EMAIL_PROVIDER="ses"
  set_convex_var "EMAIL_PROVIDER" "ses"

  owl_say "Amazon's eagles will carry your mail!"

  echo -e "  ${BOLD}AWS SES Configuration${RESET}"
  echo -e "  ${DIM}Make sure your SES account is out of sandbox mode for production.${RESET}"
  echo ""

  local ses_region ses_key ses_secret

  echo -e "  ${DIM}Common regions: us-east-1, us-west-2, eu-west-1, eu-central-1${RESET}"
  prompt_default "AWS SES region" "eu-west-1" ses_region
  set_convex_var "AWS_SES_REGION" "$ses_region"

  echo ""
  prompt_default "AWS access key ID" "" ses_key
  if [[ -n "$ses_key" ]]; then
    set_convex_var "AWS_SES_ACCESS_KEY_ID" "$ses_key"
  fi

  prompt_secret "AWS secret access key" ses_secret
  if [[ -n "$ses_secret" ]]; then
    set_convex_var "AWS_SES_SECRET_ACCESS_KEY" "$ses_secret"
  fi
}

configure_email_resend() {
  EMAIL_PROVIDER="resend"
  set_convex_var "EMAIL_PROVIDER" "resend"

  owl_say "Resend it is! Simple and elegant, like an owl's flight."

  echo -e "  ${BOLD}Resend Configuration${RESET}"
  echo -e "  ${DIM}Get your API key from https://resend.com/api-keys${RESET}"
  echo ""

  local resend_key resend_webhook

  prompt_default "Resend API key" "" resend_key
  if [[ -n "$resend_key" ]]; then
    set_convex_var "RESEND_API_KEY" "$resend_key"
  fi

  echo ""
  echo -e "  ${DIM}Webhook secret is optional but recommended for delivery tracking.${RESET}"
  prompt_default "Resend webhook secret (optional)" "" resend_webhook
  if [[ -n "$resend_webhook" ]]; then
    set_convex_var "RESEND_WEBHOOK_SECRET" "$resend_webhook"
  fi
}

# ── Email Security ──────────────────────────────────────────────────────────

configure_email_security() {
  section "Email Security (Optional)"

  echo -e "  ${DIM}Content scanning for spam keywords and phishing patterns works out of${RESET}"
  echo -e "  ${DIM}the box. URL reputation checking and ClamAV antivirus scanning need${RESET}"
  echo -e "  ${DIM}optional configuration below.${RESET}"
  echo ""

  # Google Safe Browsing
  if prompt_yn "Enable Google Safe Browsing URL checking?" "n"; then
    local sb_key
    echo ""
    echo -e "  ${DIM}Get an API key from: https://console.cloud.google.com/apis/api/safebrowsing.googleapis.com${RESET}"
    prompt_default "Google Safe Browsing API key" "" sb_key
    if [[ -n "$sb_key" ]]; then
      set_convex_var "GOOGLE_SAFE_BROWSING_API_KEY" "$sb_key"
      success "Safe Browsing API key configured"
    fi
  else
    info "URL reputation checking disabled"
  fi

  echo ""

  # ClamAV
  if prompt_yn "Enable ClamAV attachment scanning?" "n"; then
    local mta_internal_url
    local default_mta_url
    if [[ "$DEPLOYMENT_MODE" == "selfhost" ]]; then
      default_mta_url="http://mta:3100"
    else
      default_mta_url="http://localhost:3100"
    fi
    echo ""
    echo -e "  ${DIM}The MTA exposes a scan endpoint that proxies to ClamAV.${RESET}"
    prompt_default "MTA internal URL" "$default_mta_url" mta_internal_url
    set_convex_var "MTA_INTERNAL_URL" "$mta_internal_url"
    success "ClamAV scanning configured via ${BOLD}${mta_internal_url}${RESET}"
  else
    info "ClamAV attachment scanning disabled"
  fi
}

# ── Step 7: Optional Features ───────────────────────────────────────────────

configure_optional() {
  section "Optional Features"

  echo -e "  ${DIM}These features are optional. Press Enter to skip any.${RESET}"
  echo ""

  # ── PostHog Analytics ──
  echo -e "  ${BOLD}━━━ PostHog Analytics ━━━${RESET}"
  echo ""
  if prompt_yn "Enable PostHog analytics?" "n"; then
    POSTHOG_ENABLED=true

    local ph_key ph_host

    prompt_default "PostHog API key" "" ph_key
    prompt_default "PostHog host" "https://eu.i.posthog.com" ph_host

    if [[ -n "$ph_key" ]]; then
      set_convex_var "POSTHOG_API_KEY" "$ph_key"
      NUXT_VARS[NUXT_PUBLIC_POSTHOG_API_KEY]="$ph_key"
      NUXT_VARS[NUXT_PUBLIC_POSTHOG_HOST]="$ph_host"
      set_convex_var "POSTHOG_HOST" "$ph_host"
    fi
  else
    info "Analytics disabled"
  fi

  echo ""
  echo ""

  # ── AI Translation ──
  echo -e "  ${BOLD}━━━ AI Translation ━━━${RESET}"
  echo ""
  if prompt_yn "Enable AI-powered translations?" "n"; then
    AI_ENABLED=true

    owl_say "Multilingual owls are the wisest of all!"

    local openrouter_key openai_key

    echo -e "  ${DIM}OpenRouter is the primary provider. OpenAI is the fallback.${RESET}"
    echo ""
    prompt_default "OpenRouter API key (primary)" "" openrouter_key
    if [[ -n "$openrouter_key" ]]; then
      set_convex_var "OPENROUTER_API_KEY" "$openrouter_key"
    fi

    prompt_default "OpenAI API key (fallback, optional)" "" openai_key
    if [[ -n "$openai_key" ]]; then
      set_convex_var "OPENAI_API_KEY" "$openai_key"
    fi
  else
    info "AI translation disabled"
  fi


}

# ── Optional Features (Self-Hosted) ─────────────────────────────────────────

configure_optional_selfhost() {
  section "Optional Features"

  echo -e "  ${DIM}These features are optional. Press Enter to skip any.${RESET}"
  echo ""

  # ── PostHog Analytics ──
  echo -e "  ${BOLD}━━━ PostHog Analytics ━━━${RESET}"
  echo ""
  if prompt_yn "Enable PostHog analytics?" "n"; then
    POSTHOG_ENABLED=true

    local ph_key ph_host

    prompt_default "PostHog API key" "" ph_key
    prompt_default "PostHog host" "https://eu.i.posthog.com" ph_host

    if [[ -n "$ph_key" ]]; then
      set_convex_var "POSTHOG_API_KEY" "$ph_key"
      set_selfhost_var "NUXT_PUBLIC_POSTHOG_API_KEY" "$ph_key"
      set_selfhost_var "NUXT_PUBLIC_POSTHOG_HOST" "$ph_host"
      set_convex_var "POSTHOG_HOST" "$ph_host"
    fi
  else
    info "Analytics disabled"
  fi

  echo ""
  echo ""

  # ── AI Translation ──
  echo -e "  ${BOLD}━━━ AI Translation ━━━${RESET}"
  echo ""
  if prompt_yn "Enable AI-powered translations?" "n"; then
    AI_ENABLED=true

    owl_say "Multilingual owls are the wisest of all!"

    local openrouter_key openai_key

    echo -e "  ${DIM}OpenRouter is the primary provider. OpenAI is the fallback.${RESET}"
    echo ""
    prompt_default "OpenRouter API key (primary)" "" openrouter_key
    if [[ -n "$openrouter_key" ]]; then
      set_convex_var "OPENROUTER_API_KEY" "$openrouter_key"
    fi

    prompt_default "OpenAI API key (fallback, optional)" "" openai_key
    if [[ -n "$openai_key" ]]; then
      set_convex_var "OPENAI_API_KEY" "$openai_key"
    fi
  else
    info "AI translation disabled"
  fi


}

# ── Self-Hosted: Core Configuration ─────────────────────────────────────────

configure_selfhost_core() {
  section "Core Configuration"

  # Auto-generate instance secret
  SELFHOST_INSTANCE_SECRET=$(openssl rand -hex 32)
  set_selfhost_var "INSTANCE_SECRET" "$SELFHOST_INSTANCE_SECRET"
  # Convex needs it too: seedAdmin.ts compares the X-Instance-Secret header
  # against INSTANCE_SECRET, so /seed/admin returns 401 unless it is set here.
  set_convex_var "INSTANCE_SECRET" "$SELFHOST_INSTANCE_SECRET"
  success "Generated INSTANCE_SECRET"

  # CONVEX_ADMIN_KEY will be set after boot
  set_selfhost_var "CONVEX_ADMIN_KEY" ""

  echo ""

  # Public URLs
  echo -e "  ${BOLD}Public URLs${RESET}"
  echo -e "  ${DIM}These must be reachable from the user's browser.${RESET}"
  echo -e "  ${DIM}Use localhost defaults for local testing, or your domain for production.${RESET}"
  echo ""

  local convex_url convex_site_url site_url
  prompt_default "Convex URL" "http://localhost:3210" convex_url
  set_selfhost_var "NUXT_PUBLIC_CONVEX_URL" "$convex_url"

  prompt_default "Convex Site URL" "http://localhost:3211" convex_site_url
  set_selfhost_var "NUXT_PUBLIC_CONVEX_SITE_URL" "$convex_site_url"

  prompt_default "Site URL" "http://localhost:3000" site_url
  set_selfhost_var "NUXT_PUBLIC_SITE_URL" "$site_url"
  SITE_URL="$site_url"
  CONVEX_SITE_URL_VAL="$convex_site_url"

  echo ""

  # Convex env vars
  set_convex_var "SITE_URL" "$site_url"
  # CONVEX_SITE_URL is a Convex BUILT-IN — `convex env set CONVEX_SITE_URL` is
  # rejected (EnvVarNameForbidden). It stays in the compose .env /
  # NUXT_PUBLIC_CONVEX_SITE_URL only; never push it as a Convex var.

  # Auth secrets
  local auth_secret unsub_secret
  auth_secret=$(generate_secret)
  set_convex_var "BETTER_AUTH_SECRET" "$auth_secret"
  success "Generated BetterAuth secret"

  unsub_secret=$(generate_secret)
  set_convex_var "UNSUBSCRIBE_SECRET" "$unsub_secret"
  success "Generated unsubscribe signing secret"

  # CORS origins
  local allowed_origins="$site_url"
  if [[ "$site_url" != "http://localhost:3000" ]]; then
    allowed_origins="${site_url},http://localhost:3000"
  fi
  set_convex_var "ALLOWED_ORIGINS" "$allowed_origins"
  success "CORS origins set to: ${BOLD}${allowed_origins}${RESET}"

  # Default sender identity
  echo ""
  echo -e "  ${BOLD}Default sender identity${RESET}"
  echo -e "  ${DIM}The default \"From\" address for emails sent by Owlat.${RESET}"
  echo ""

  local from_email from_name from_domain
  prompt_default "From email" "noreply@example.com" from_email
  prompt_default "From name" "Owlat" from_name

  local default_domain
  default_domain=$(echo "$from_email" | cut -d@ -f2)
  prompt_default "From domain" "$default_domain" from_domain

  set_convex_var "DEFAULT_FROM_EMAIL" "$from_email"
  set_convex_var "DEFAULT_FROM_NAME" "$from_name"
  set_convex_var "DEFAULT_FROM_DOMAIN" "$from_domain"

  # Email provider is always MTA for selfhost
  set_convex_var "EMAIL_PROVIDER" "mta"
  set_convex_var "MTA_API_URL" "http://mta:3100"
  EMAIL_PROVIDER="mta"

  owl_say "Core configuration locked in! The nest is taking shape."
}

# ── Self-Hosted: MTA Configuration ──────────────────────────────────────────

configure_selfhost_mta() {
  section "MTA Configuration"

  owl_say "Let's configure the mail engine for your self-hosted flock."

  # Auto-generate keys
  local mta_key mta_webhook_secret mta_secret
  mta_key=$(generate_secret)
  mta_webhook_secret=$(generate_secret)
  # Seals DKIM keys + relay credentials at rest (>= 32 bytes; the MTA refuses to
  # boot otherwise). MTA-only, so it is NOT mirrored into the Convex env. Minted
  # as hex to match `openssl rand -hex 32` in the .env examples and the shared
  # `ensureSecrets` generator — one canonical format everywhere.
  mta_secret=$(generate_hex_secret)

  # Store in BOTH selfhost .env and Convex env vars
  set_selfhost_var "MTA_API_KEY" "$mta_key"
  set_selfhost_var "MTA_WEBHOOK_SECRET" "$mta_webhook_secret"
  set_selfhost_var "MTA_SECRET" "$mta_secret"
  set_convex_var "MTA_API_KEY" "$mta_key"
  set_convex_var "MTA_WEBHOOK_SECRET" "$mta_webhook_secret"

  success "Generated MTA_API_KEY"
  success "Generated MTA_WEBHOOK_SECRET"
  success "Generated MTA_SECRET"

  echo ""

  # EHLO hostname
  echo -e "  ${BOLD}SMTP Configuration${RESET}"
  echo -e "  ${DIM}The EHLO hostname must match your server's rDNS PTR record for${RESET}"
  echo -e "  ${DIM}proper email deliverability.${RESET}"
  echo ""

  local ehlo_hostname return_path_domain
  prompt_default "EHLO hostname" "mail.example.com" ehlo_hostname
  set_selfhost_var "EHLO_HOSTNAME" "$ehlo_hostname"

  prompt_default "Return path domain (for VERP bounces)" "bounces.example.com" return_path_domain
  set_selfhost_var "RETURN_PATH_DOMAIN" "$return_path_domain"

  echo ""

  # IP pools
  echo -e "  ${BOLD}IP Pools${RESET}"
  echo -e "  ${DIM}Comma-separated IP addresses for sending pools.${RESET}"
  echo ""

  local ip_transactional ip_campaign
  prompt_default "Transactional IP pool" "127.0.0.1" ip_transactional
  set_selfhost_var "IP_POOLS_TRANSACTIONAL" "$ip_transactional"

  prompt_default "Campaign IP pool" "127.0.0.1" ip_campaign
  set_selfhost_var "IP_POOLS_CAMPAIGN" "$ip_campaign"

  echo ""

  # DKIM
  echo -e "  ${DIM}DKIM signing keys can be configured later for production.${RESET}"
  echo -e "  ${DIM}Format: {\"example.com\":{\"selector\":\"s1\",\"privateKey\":\"-----BEGIN RSA...\"}}${RESET}"
  set_selfhost_var "DKIM_KEYS" "{}"
  info "DKIM_KEYS set to {} (configure later for production)"

  echo ""

  # Tuning
  local worker_concurrency mta_log_level
  prompt_default "Worker concurrency" "50" worker_concurrency
  set_selfhost_var "WORKER_CONCURRENCY" "$worker_concurrency"

  prompt_default "MTA log level" "info" mta_log_level
  set_selfhost_var "MTA_LOG_LEVEL" "$mta_log_level"

  owl_say "Mail engine configured! Ready to deliver some feathered mail."
}

# ── Step 8: Write .env.local ────────────────────────────────────────────────

write_env_file() {
  section "Writing Configuration"

  local env_file=".env.local"

  # Backup existing
  if [[ -f "$env_file" ]]; then
    local backup="${env_file}.backup.$(date +%Y%m%d_%H%M%S)"
    cp "$env_file" "$backup"
    success "Backed up existing ${env_file} → ${BOLD}${backup}${RESET}"
  fi

  # Write the file
  {
    echo "# ═══════════════════════════════════════════════════════════"
    echo "# Owlat Configuration"
    echo "# Generated by setup wizard on $(date '+%Y-%m-%d %H:%M:%S')"
    echo "# ═══════════════════════════════════════════════════════════"
    echo ""
    echo "# Convex"
    echo "NUXT_PUBLIC_CONVEX_URL=${NUXT_VARS[NUXT_PUBLIC_CONVEX_URL]:-http://127.0.0.1:3212}"
    echo "NUXT_PUBLIC_CONVEX_SITE_URL=${NUXT_VARS[NUXT_PUBLIC_CONVEX_SITE_URL]:-http://localhost:3210}"
    echo ""
    echo "# Application"
    echo "NUXT_PUBLIC_SITE_URL=${NUXT_VARS[NUXT_PUBLIC_SITE_URL]:-http://localhost:3000}"
    echo ""

    # PostHog
    if [[ "$POSTHOG_ENABLED" == true ]]; then
      echo "# PostHog Analytics"
      echo "NUXT_PUBLIC_POSTHOG_API_KEY=${NUXT_VARS[NUXT_PUBLIC_POSTHOG_API_KEY]:-}"
      echo "NUXT_PUBLIC_POSTHOG_HOST=${NUXT_VARS[NUXT_PUBLIC_POSTHOG_HOST]:-https://eu.i.posthog.com}"
      echo ""
    fi

  } > "$env_file"

  success "Written ${BOLD}${env_file}${RESET}"
  owl_say "Configuration file written! The nest is cozy."
}

# ── Write Self-Hosted .env ──────────────────────────────────────────────────

write_selfhost_env() {
  section "Writing Configuration"

  local env_file=".env"

  # Backup existing
  if [[ -f "$env_file" ]]; then
    local backup="${env_file}.backup.$(date +%Y%m%d_%H%M%S)"
    cp "$env_file" "$backup"
    success "Backed up existing ${env_file} → ${BOLD}${backup}${RESET}"
  fi

  {
    echo "# ═══════════════════════════════════════════════════════════════════════════════"
    echo "# Owlat Self-Hosted Configuration"
    echo "# Generated by setup wizard on $(date '+%Y-%m-%d %H:%M:%S')"
    echo "# ═══════════════════════════════════════════════════════════════════════════════"
    echo ""
    echo "# ── Convex Backend ────────────────────────────────────────────────────────────"
    echo "INSTANCE_SECRET=${SELFHOST_VARS[INSTANCE_SECRET]:-}"
    echo ""
    echo "# Generated after first boot via: docker compose exec convex ./generate_admin_key.sh"
    echo "# Required for deploying functions and setting Convex env vars"
    echo "CONVEX_ADMIN_KEY=${SELFHOST_VARS[CONVEX_ADMIN_KEY]:-}"
    echo ""
    echo "# ── Public URLs ───────────────────────────────────────────────────────────────"
    echo "NUXT_PUBLIC_CONVEX_URL=${SELFHOST_VARS[NUXT_PUBLIC_CONVEX_URL]:-http://localhost:3210}"
    echo "NUXT_PUBLIC_CONVEX_SITE_URL=${SELFHOST_VARS[NUXT_PUBLIC_CONVEX_SITE_URL]:-http://localhost:3211}"
    echo "NUXT_PUBLIC_SITE_URL=${SELFHOST_VARS[NUXT_PUBLIC_SITE_URL]:-http://localhost:3000}"
    echo ""
    echo "# ── MTA Configuration ────────────────────────────────────────────────────────"
    echo "MTA_API_KEY=${SELFHOST_VARS[MTA_API_KEY]:-}"
    echo "MTA_WEBHOOK_SECRET=${SELFHOST_VARS[MTA_WEBHOOK_SECRET]:-}"
    echo "MTA_SECRET=${SELFHOST_VARS[MTA_SECRET]:-}"
    echo ""
    echo "EHLO_HOSTNAME=${SELFHOST_VARS[EHLO_HOSTNAME]:-mail.example.com}"
    echo "RETURN_PATH_DOMAIN=${SELFHOST_VARS[RETURN_PATH_DOMAIN]:-bounces.example.com}"
    echo ""
    echo "IP_POOLS_TRANSACTIONAL=${SELFHOST_VARS[IP_POOLS_TRANSACTIONAL]:-127.0.0.1}"
    echo "IP_POOLS_CAMPAIGN=${SELFHOST_VARS[IP_POOLS_CAMPAIGN]:-127.0.0.1}"
    echo ""
    echo "DKIM_KEYS=${SELFHOST_VARS[DKIM_KEYS]:-{}}"
    echo ""
    echo "WORKER_CONCURRENCY=${SELFHOST_VARS[WORKER_CONCURRENCY]:-50}"
    echo "MTA_LOG_LEVEL=${SELFHOST_VARS[MTA_LOG_LEVEL]:-info}"
    echo ""
    echo "# ── Port Overrides (optional) ────────────────────────────────────────────────"
    echo "# CONVEX_PORT=3210"
    echo "# CONVEX_SITE_PORT=3211"
    echo "# DASHBOARD_PORT=6791"
    echo "# WEB_PORT=3000"
    echo "# MTA_HTTP_PORT=3100"
    echo "# MTA_SMTP_PORT=25"
    echo "# REDIS_PORT=6379"
    echo "# CLAMAV_PORT=3310"

    # PostHog
    if [[ "$POSTHOG_ENABLED" == true ]]; then
      echo ""
      echo "# ── PostHog Analytics ──────────────────────────────────────────────────────"
      echo "NUXT_PUBLIC_POSTHOG_API_KEY=${SELFHOST_VARS[NUXT_PUBLIC_POSTHOG_API_KEY]:-}"
      echo "NUXT_PUBLIC_POSTHOG_HOST=${SELFHOST_VARS[NUXT_PUBLIC_POSTHOG_HOST]:-https://eu.i.posthog.com}"
    fi

    echo ""

  } > "$env_file"

  success "Written ${BOLD}${env_file}${RESET}"
  owl_say "Configuration file written! The Docker nest is ready."
}

# ── Self-Hosted: Docker Compose ─────────────────────────────────────────────

run_docker_compose() {
  section "Starting Docker Compose Stack"

  owl_say "Hatching the containers... this may take a minute."

  # 1. Start the stack
  info "Starting services..."
  docker compose up -d 2>&1 &
  local pid=$!
  # Guard the spinner so the friendly error fires instead of a bare `set -e` abort.
  if ! spinner "$pid" "Starting Docker containers..."; then
    error "Failed to start Docker Compose stack"
    echo -e "    ${DIM}Check docker compose logs for details.${RESET}"
    exit 1
  fi
  success "Docker Compose stack started"

  # 2. Wait for Convex to be healthy
  echo ""
  info "Waiting for Convex backend to be ready..."
  local max_wait=120
  local waited=0
  while (( waited < max_wait )); do
    if curl -sf http://localhost:${CONVEX_PORT:-3210}/version &>/dev/null; then
      break
    fi
    sleep 2
    waited=$((waited + 2))
    printf "\r  ${CYAN}⏳${RESET}  Waiting for Convex... (%ds/%ds)" "$waited" "$max_wait"
  done

  if (( waited >= max_wait )); then
    echo ""
    error "Convex did not become ready within ${max_wait}s"
    echo -e "    ${DIM}Check: docker compose logs convex${RESET}"
    exit 1
  fi
  printf "\r%-60s\r" ""
  success "Convex backend is ready"

  # 3. Generate admin key
  echo ""
  info "Generating Convex admin key..."
  local admin_key_output
  admin_key_output=$(docker compose exec -T convex ./generate_admin_key.sh 2>/dev/null) || {
    warn "Could not auto-generate admin key"
    echo -e "    ${DIM}Run manually: docker compose exec convex ./generate_admin_key.sh${RESET}"
    prompt_default "Paste the admin key here" "" SELFHOST_CONVEX_ADMIN_KEY
    # Update .env
    if [[ -n "$SELFHOST_CONVEX_ADMIN_KEY" ]]; then
      sed -i.bak "s/^CONVEX_ADMIN_KEY=.*/CONVEX_ADMIN_KEY=${SELFHOST_CONVEX_ADMIN_KEY}/" .env
      rm -f .env.bak
    fi
    return
  }

  # Extract the key from the output (look for a long alphanumeric string)
  SELFHOST_CONVEX_ADMIN_KEY=$(echo "$admin_key_output" | grep -oE '[a-zA-Z0-9_-]{20,}' | tail -1)

  if [[ -z "$SELFHOST_CONVEX_ADMIN_KEY" ]]; then
    warn "Could not parse admin key from output"
    echo -e "    ${DIM}Output was: ${admin_key_output}${RESET}"
    prompt_default "Paste the admin key" "" SELFHOST_CONVEX_ADMIN_KEY
  fi

  # Write admin key back to .env
  if [[ -n "$SELFHOST_CONVEX_ADMIN_KEY" ]]; then
    sed -i.bak "s/^CONVEX_ADMIN_KEY=.*/CONVEX_ADMIN_KEY=${SELFHOST_CONVEX_ADMIN_KEY}/" .env
    rm -f .env.bak
    success "Admin key saved to .env"
  fi

  # 4. Deploy Convex functions
  echo ""
  info "Deploying Convex functions..."
  docker compose --profile deploy run --rm convex-deploy 2>&1 &
  local pid=$!
  # Guard the spinner so a failed deploy degrades to a soft warning instead of
  # aborting the whole wizard under `set -e`.
  if ! spinner "$pid" "Deploying Convex functions..."; then
    warn "Function deployment failed. You can retry: docker compose --profile deploy run --rm convex-deploy"
  else
    success "Convex functions deployed"
  fi

  owl_say "All containers hatched and functions deployed!"
}

# ── Self-Hosted: Set Convex Env Vars ────────────────────────────────────────

set_convex_env_vars_selfhost() {
  section "Setting Convex Environment Variables"

  local total=${#CONVEX_VAR_ORDER[@]}

  if (( total == 0 )); then
    warn "No Convex environment variables to set"
    return 0
  fi

  if [[ -z "$SELFHOST_CONVEX_ADMIN_KEY" ]]; then
    warn "No admin key available. Skipping Convex env var setup."
    echo ""
    echo -e "  ${DIM}To set these manually later, run:${RESET}"
    echo ""
    for key in "${CONVEX_VAR_ORDER[@]}"; do
      local value="${CONVEX_VARS[$key]}"
      if [[ "$key" =~ (SECRET|KEY|PASSWORD) ]]; then
        echo -e "  ${DIM}npx convex env set $key \"****\" --url http://localhost:3210 --admin-key <key>${RESET}"
      else
        echo -e "  ${DIM}npx convex env set $key \"$value\" --url http://localhost:3210 --admin-key <key>${RESET}"
      fi
    done
    echo ""
    return 0
  fi

  echo -e "  Setting ${BOLD}${total}${RESET} environment variables in Convex..."
  echo ""

  local convex_url="http://localhost:${CONVEX_PORT:-3210}"
  local i=0
  local failed=0

  for key in "${CONVEX_VAR_ORDER[@]}"; do
    local value="${CONVEX_VARS[$key]}"
    i=$((i + 1))

    # Mask secrets in display
    local display_val="$value"
    if [[ "$key" =~ (SECRET|KEY|PASSWORD) ]]; then
      display_val="••••••••"
    fi

    printf "  ${DIM}[%d/%d]${RESET} Setting ${BOLD}%-35s${RESET}" "$i" "$total" "$key"

    if npx convex env set "$key" "$value" --url "$convex_url" --admin-key "$SELFHOST_CONVEX_ADMIN_KEY" &>/dev/null 2>&1; then
      echo -e " ${GREEN}✓${RESET}"
    else
      echo -e " ${YELLOW}⚠${RESET}"
      failed=$((failed + 1))
    fi
  done

  echo ""

  if (( failed > 0 )); then
    warn "${failed} variable(s) failed to set. You may need to set them manually."
  else
    success "All ${total} variables set successfully!"
  fi

  owl_say "All variables perched safely in Convex!"
}

# ── Step 9: Set Convex Environment Variables ────────────────────────────────

set_convex_env_vars() {
  section "Setting Convex Environment Variables"

  local total=${#CONVEX_VAR_ORDER[@]}

  if (( total == 0 )); then
    warn "No Convex environment variables to set"
    return 0
  fi

  echo -e "  Setting ${BOLD}${total}${RESET} environment variables in Convex..."
  echo ""

  # Check if Convex is available
  if ! npx convex whoami &>/dev/null 2>&1; then
    warn "Not logged in to Convex. Skipping env var setup."
    echo ""
    echo -e "  ${DIM}To set these manually later, run:${RESET}"
    echo ""
    for key in "${CONVEX_VAR_ORDER[@]}"; do
      local value="${CONVEX_VARS[$key]}"
      # Mask secrets in output
      if [[ "$key" =~ (SECRET|KEY|PASSWORD) ]]; then
        echo -e "  ${DIM}npx convex env set $key \"****\"${RESET}"
      else
        echo -e "  ${DIM}npx convex env set $key \"$value\"${RESET}"
      fi
    done
    echo ""
    return 0
  fi

  local i=0
  local failed=0

  for key in "${CONVEX_VAR_ORDER[@]}"; do
    local value="${CONVEX_VARS[$key]}"
    i=$((i + 1))

    # Mask secrets in display
    local display_val="$value"
    if [[ "$key" =~ (SECRET|KEY|PASSWORD) ]]; then
      display_val="••••••••"
    fi

    printf "  ${DIM}[%d/%d]${RESET} Setting ${BOLD}%-35s${RESET}" "$i" "$total" "$key"

    if (cd apps/api && npx convex env set "$key" "$value") &>/dev/null 2>&1; then
      echo -e " ${GREEN}✓${RESET}"
    else
      echo -e " ${YELLOW}⚠${RESET}"
      failed=$((failed + 1))
    fi
  done

  echo ""

  if (( failed > 0 )); then
    warn "${failed} variable(s) failed to set. You may need to set them manually."
  else
    success "All ${total} variables set successfully!"
  fi

  owl_say "All variables perched safely in Convex!"
}

# ── Step 10: Create Admin Account ────────────────────────────────────────────

setup_admin_account() {
  section "Admin Account Setup"

  echo -e "  Create the first admin account for your Owlat instance."
  echo -e "  ${DIM}This account will be the organization owner.${RESET}"
  echo ""

  local admin_email admin_name admin_password admin_password_confirm

  # Admin email
  while true; do
    read -rp "$(echo -e "  ${BOLD}Admin email:${RESET} ")" admin_email
    if [[ "$admin_email" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
      break
    fi
    warn "Please enter a valid email address"
  done

  # Admin name
  read -rp "$(echo -e "  ${BOLD}Admin name:${RESET} ")" admin_name
  if [[ -z "$admin_name" ]]; then
    admin_name="${admin_email%%@*}"
    info "Using name: ${admin_name}"
  fi

  # Admin password
  while true; do
    read -srp "$(echo -e "  ${BOLD}Admin password:${RESET} ")" admin_password
    echo ""
    if [[ ${#admin_password} -lt 8 ]]; then
      warn "Password must be at least 8 characters"
      continue
    fi
    read -srp "$(echo -e "  ${BOLD}Confirm password:${RESET} ")" admin_password_confirm
    echo ""
    if [[ "$admin_password" != "$admin_password_confirm" ]]; then
      warn "Passwords do not match"
      continue
    fi
    break
  done

  # Hash the password using Node.js (bcrypt via better-auth's dependency)
  info "Hashing password..."
  local password_hash
  password_hash=$(node -e "
    const { createHash, randomBytes } = require('crypto');
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync(process.argv[1], 10);
    process.stdout.write(hash);
  " "$admin_password" 2>/dev/null) || {
    # Fallback: try with bcrypt npm package
    password_hash=$(node -e "
      const bcrypt = require('bcrypt');
      const hash = bcrypt.hashSync(process.argv[1], 10);
      process.stdout.write(hash);
    " "$admin_password" 2>/dev/null) || {
      # Fallback for selfhost: try via Docker container
      if [[ "$DEPLOYMENT_MODE" == "selfhost" ]]; then
        password_hash=$(docker compose exec -T web node -e "
          const bcrypt = require('bcryptjs');
          process.stdout.write(bcrypt.hashSync(process.argv[1], 10));
        " "$admin_password" 2>/dev/null) || {
          error "Failed to hash password."
          echo -e "    ${DIM}You can manually seed the admin account after setup.${RESET}"
          return
        }
      else
        error "Failed to hash password. Make sure bcryptjs or bcrypt is available."
        echo -e "    ${DIM}You can manually seed the admin account after setup.${RESET}"
        return
      fi
    }
  }

  success "Password hashed"

  # Store credentials for seeding after deployment
  SEED_ADMIN_EMAIL="$admin_email"
  SEED_ADMIN_NAME="$admin_name"
  SEED_ADMIN_PASSWORD_HASH="$password_hash"

  owl_say "Admin credentials ready! They'll be used to seed your instance after deployment."
}

# ── Step 11: Seed Admin on Instance ──────────────────────────────────────────

seed_admin_account() {
  if [[ -z "${SEED_ADMIN_EMAIL:-}" ]]; then
    return
  fi

  section "Seeding Admin Account"

  echo -e "  ${DIM}Creating admin account on the local instance...${RESET}"

  local instance_secret
  instance_secret="${CONVEX_VARS[INSTANCE_SECRET]:-$(openssl rand -hex 32)}"

  # Determine the Convex site URL for the seed endpoint
  local site_url="${CONVEX_SITE_URL_VAL:-http://localhost:3210}"

  local response
  response=$(curl -s -w "\n%{http_code}" -X POST "${site_url}/seed/admin" \
    -H "Content-Type: application/json" \
    -H "X-Instance-Secret: ${instance_secret}" \
    -d "{\"email\":\"${SEED_ADMIN_EMAIL}\",\"name\":\"${SEED_ADMIN_NAME}\",\"passwordHash\":\"${SEED_ADMIN_PASSWORD_HASH}\"}" 2>/dev/null) || {
    warn "Could not reach the instance. You can seed the admin account manually later."
    echo -e "    ${DIM}Make sure the Convex backend is running, then run:${RESET}"
    echo -e "    ${DIM}curl -X POST ${site_url}/seed/admin \\${RESET}"
    echo -e "    ${DIM}  -H 'Content-Type: application/json' \\${RESET}"
    echo -e "    ${DIM}  -H 'X-Instance-Secret: <your-instance-secret>' \\${RESET}"
    echo -e "    ${DIM}  -d '{\"email\":\"${SEED_ADMIN_EMAIL}\",\"name\":\"${SEED_ADMIN_NAME}\",\"passwordHash\":\"<hash>\"}'${RESET}"
    return
  }

  local http_code
  http_code=$(echo "$response" | tail -1)
  local body
  body=$(echo "$response" | head -n -1)

  if [[ "$http_code" == "200" || "$http_code" == "201" ]]; then
    success "Admin account created: ${BOLD}${SEED_ADMIN_EMAIL}${RESET}"
    info "You can log in with the email and password you just set."
  elif [[ "$http_code" == "409" ]]; then
    info "Admin account already exists (instance was previously seeded)"
  else
    warn "Failed to seed admin (HTTP ${http_code}): ${body}"
    echo -e "    ${DIM}You can retry manually after deploying.${RESET}"
  fi

  # Clear sensitive data
  unset SEED_ADMIN_EMAIL SEED_ADMIN_NAME SEED_ADMIN_PASSWORD_HASH
}

# ── Self-Hosted: Seed Admin ─────────────────────────────────────────────────

seed_admin_selfhost() {
  if [[ -z "${SEED_ADMIN_EMAIL:-}" ]]; then
    return
  fi

  section "Seeding Admin Account"

  echo -e "  ${DIM}Creating admin account on the self-hosted instance...${RESET}"

  local site_url="http://localhost:${CONVEX_SITE_PORT:-3211}"
  local instance_secret="$SELFHOST_INSTANCE_SECRET"

  local response
  response=$(curl -s -w "\n%{http_code}" -X POST "${site_url}/seed/admin" \
    -H "Content-Type: application/json" \
    -H "X-Instance-Secret: ${instance_secret}" \
    -d "{\"email\":\"${SEED_ADMIN_EMAIL}\",\"name\":\"${SEED_ADMIN_NAME}\",\"passwordHash\":\"${SEED_ADMIN_PASSWORD_HASH}\"}" 2>/dev/null) || {
    warn "Could not reach the instance. You can seed the admin account manually later."
    echo -e "    ${DIM}Make sure the stack is running, then run:${RESET}"
    echo -e "    ${DIM}curl -X POST ${site_url}/seed/admin \\${RESET}"
    echo -e "    ${DIM}  -H 'Content-Type: application/json' \\${RESET}"
    echo -e "    ${DIM}  -H 'X-Instance-Secret: <your-instance-secret>' \\${RESET}"
    echo -e "    ${DIM}  -d '{\"email\":\"...\",\"name\":\"...\",\"passwordHash\":\"<hash>\"}'${RESET}"
    return
  }

  local http_code
  http_code=$(echo "$response" | tail -1)
  local body
  body=$(echo "$response" | head -n -1)

  if [[ "$http_code" == "200" || "$http_code" == "201" ]]; then
    success "Admin account created: ${BOLD}${SEED_ADMIN_EMAIL}${RESET}"
    info "You can log in with the email and password you just set."
  elif [[ "$http_code" == "409" ]]; then
    info "Admin account already exists (instance was previously seeded)"
  else
    warn "Failed to seed admin (HTTP ${http_code}): ${body}"
    echo -e "    ${DIM}You can retry manually after deploying.${RESET}"
  fi

  # Clear sensitive data
  unset SEED_ADMIN_EMAIL SEED_ADMIN_NAME SEED_ADMIN_PASSWORD_HASH
}

# ── Step 12: Summary ────────────────────────────────────────────────────────

show_summary() {
  section "Setup Complete!"

  # Provider display name
  local provider_display
  case "$EMAIL_PROVIDER" in
    mta) provider_display="Custom MTA" ;;
    ses) provider_display="AWS SES" ;;
    resend) provider_display="Resend" ;;
    *) provider_display="Not configured" ;;
  esac

  # Feature status helpers
  status_badge() {
    if [[ "$1" == true ]]; then
      echo -e "${GREEN}Enabled${RESET}"
    else
      echo -e "${DIM}Disabled${RESET}"
    fi
  }

  local w=54

  echo -e "  ${CYAN}┌$(printf '─%.0s' $(seq 1 $w))┐${RESET}"
  echo -e "  ${CYAN}│${RESET}  ${BOLD}Configuration Summary${RESET}$(printf ' %.0s' $(seq 1 $((w - 23))))${CYAN}│${RESET}"
  echo -e "  ${CYAN}├$(printf '─%.0s' $(seq 1 $w))┤${RESET}"
  printf "  ${CYAN}│${RESET}  %-20s %-32s${CYAN}│${RESET}\n" "Site URL:" "$SITE_URL"
  printf "  ${CYAN}│${RESET}  %-20s %-32s${CYAN}│${RESET}\n" "Email Provider:" "$provider_display"
  echo -e "  ${CYAN}│${RESET}  Analytics:$(printf ' %.0s' $(seq 1 10))$(status_badge $POSTHOG_ENABLED)$(printf ' %.0s' $(seq 1 20))${CYAN}│${RESET}"
  echo -e "  ${CYAN}│${RESET}  AI Translation:$(printf ' %.0s' $(seq 1 5))$(status_badge $AI_ENABLED)$(printf ' %.0s' $(seq 1 20))${CYAN}│${RESET}"
  printf "  ${CYAN}│${RESET}  %-20s %-32s${CYAN}│${RESET}\n" "Env File:" ".env.local"
  printf "  ${CYAN}│${RESET}  %-20s %-32s${CYAN}│${RESET}\n" "Convex Vars:" "${#CONVEX_VAR_ORDER[@]} configured"
  echo -e "  ${CYAN}└$(printf '─%.0s' $(seq 1 $w))┘${RESET}"

  echo ""
  echo ""
  echo -e "  ${BOLD}Next Steps${RESET}"
  echo ""
  echo -e "  ${GREEN}1.${RESET} Start the Convex backend:   ${BOLD}bun run dev:api${RESET}"
  echo -e "  ${GREEN}2.${RESET} Start the web frontend:     ${BOLD}bun run dev:web${RESET}"
  echo -e "  ${GREEN}3.${RESET} Log in with your admin account at ${BOLD}${SITE_URL}${RESET}"

  if [[ "$EMAIL_PROVIDER" == "mta" ]]; then
    echo ""
    echo -e "  ${YELLOW}MTA Setup:${RESET}"
    echo -e "  ${GREEN}4.${RESET} Configure MTA env:          ${BOLD}cp apps/mta/.env.example apps/mta/.env${RESET}"
    echo -e "  ${GREEN}5.${RESET} Start the mail server:      ${BOLD}cd apps/mta && docker compose up${RESET}"
  fi

  echo ""
  echo -e "  ${DIM}Or start everything at once:  ${BOLD}bun run dev${RESET}"
  echo ""
  echo -e "  ${DIM}Documentation: https://docs.owlat.app${RESET}"
  echo ""
  echo ""
  echo -e "       ${YELLOW}(o,o)${RESET}  ${BOLD}You're all set! Happy emailing, wise one!${RESET}"
  echo -e "       ${DIM}{'\"\`\"'}${RESET}  ${CYAN}Hoot hoot!${RESET} 🦉"
  echo -e "       ${DIM}-\"-\"-${RESET}"
  echo ""

  SETUP_INTERRUPTED=false
}

# ── Self-Hosted: Summary ────────────────────────────────────────────────────

show_summary_selfhost() {
  section "Setup Complete!"

  # Feature status helpers
  status_badge() {
    if [[ "$1" == true ]]; then
      echo -e "${GREEN}Enabled${RESET}"
    else
      echo -e "${DIM}Disabled${RESET}"
    fi
  }

  local w=54

  echo -e "  ${CYAN}┌$(printf '─%.0s' $(seq 1 $w))┐${RESET}"
  echo -e "  ${CYAN}│${RESET}  ${BOLD}Configuration Summary${RESET}$(printf ' %.0s' $(seq 1 $((w - 23))))${CYAN}│${RESET}"
  echo -e "  ${CYAN}├$(printf '─%.0s' $(seq 1 $w))┤${RESET}"
  printf "  ${CYAN}│${RESET}  %-20s %-32s${CYAN}│${RESET}\n" "Deployment:" "Self-Hosted Docker"
  printf "  ${CYAN}│${RESET}  %-20s %-32s${CYAN}│${RESET}\n" "Site URL:" "$SITE_URL"
  printf "  ${CYAN}│${RESET}  %-20s %-32s${CYAN}│${RESET}\n" "Convex URL:" "${SELFHOST_VARS[NUXT_PUBLIC_CONVEX_URL]:-http://localhost:3210}"
  printf "  ${CYAN}│${RESET}  %-20s %-32s${CYAN}│${RESET}\n" "EHLO Hostname:" "${SELFHOST_VARS[EHLO_HOSTNAME]:-mail.example.com}"
  echo -e "  ${CYAN}│${RESET}  Analytics:$(printf ' %.0s' $(seq 1 10))$(status_badge $POSTHOG_ENABLED)$(printf ' %.0s' $(seq 1 20))${CYAN}│${RESET}"
  echo -e "  ${CYAN}│${RESET}  AI Translation:$(printf ' %.0s' $(seq 1 5))$(status_badge $AI_ENABLED)$(printf ' %.0s' $(seq 1 20))${CYAN}│${RESET}"
  printf "  ${CYAN}│${RESET}  %-20s %-32s${CYAN}│${RESET}\n" "Env File:" ".env"
  printf "  ${CYAN}│${RESET}  %-20s %-32s${CYAN}│${RESET}\n" "Convex Vars:" "${#CONVEX_VAR_ORDER[@]} configured"
  echo -e "  ${CYAN}└$(printf '─%.0s' $(seq 1 $w))┘${RESET}"

  echo ""
  echo ""
  echo -e "  ${BOLD}Open these URLs${RESET}"
  echo ""
  echo -e "  🌐 ${BOLD}${SITE_URL}${RESET}"
  echo -e "     ${DIM}Your Owlat dashboard — log in with the admin credentials you just created${RESET}"
  echo ""
  local convex_dashboard_url="${SITE_URL%/}"
  convex_dashboard_url="${convex_dashboard_url%:*}:6791"
  echo -e "  🛠️  ${BOLD}${convex_dashboard_url}${RESET}"
  echo -e "     ${DIM}Convex dashboard — inspect database, functions, logs${RESET}"
  echo ""
  echo -e "  📚 ${BOLD}https://docs.owlat.app${RESET}"
  echo -e "     ${DIM}Documentation, DNS guides, troubleshooting${RESET}"

  echo ""
  echo -e "  ${BOLD}Next Steps${RESET}"
  echo ""
  echo -e "  ${GREEN}1.${RESET} Open ${BOLD}${SITE_URL}${RESET} in your browser and log in"
  echo -e "  ${GREEN}2.${RESET} Verify a sending domain — ${BOLD}Settings → Domains${RESET}"
  echo -e "     ${DIM}https://docs.owlat.app/developer/self-hosting-dns-email${RESET}"
  echo -e "  ${GREEN}3.${RESET} Set up a reverse proxy for HTTPS"
  echo -e "     ${DIM}https://docs.owlat.app/developer/self-hosting-production${RESET}"
  echo -e "     ${DIM}or bring up the bundled Caddy: docker compose --profile tls up -d${RESET}"
  echo -e "  ${GREEN}4.${RESET} Run ${BOLD}bash scripts/setup.sh doctor${RESET} anytime to health-check the stack"

  echo ""
  echo -e "  ${DIM}Useful commands:${RESET}"
  echo -e "  ${DIM}  docker compose logs -f        ${RESET}${DIM}— view logs${RESET}"
  echo -e "  ${DIM}  docker compose restart        ${RESET}${DIM}— restart all services${RESET}"
  echo -e "  ${DIM}  docker compose down           ${RESET}${DIM}— stop all services${RESET}"
  echo -e "  ${DIM}  bash scripts/setup.sh doctor  ${RESET}${DIM}— diagnose common issues${RESET}"
  echo ""
  echo -e "  ${DIM}Documentation: https://docs.owlat.app${RESET}"
  echo ""
  echo ""
  echo -e "       ${YELLOW}(o,o)${RESET}  ${BOLD}Your self-hosted nest is live! Happy emailing!${RESET}"
  echo -e "       ${DIM}{'\"\`\"'}${RESET}  ${CYAN}Hoot hoot!${RESET} 🦉"
  echo -e "       ${DIM}-\"-\"-${RESET}"
  echo ""

  SETUP_INTERRUPTED=false
}

# ── Main ─────────────────────────────────────────────────────────────────────

# ── Doctor ───────────────────────────────────────────────────────────────────
# Diagnoses the most common self-host failure modes. Non-destructive; read-only
# probes only. Each check prints PASS/FAIL/WARN and (on failure) a remediation
# link. Exit code is 0 if no FAILs, 1 otherwise.

DOCTOR_FAILED=0
DOCTOR_WARNED=0

doctor_check() {
  local status="$1"  # pass / warn / fail
  local label="$2"
  local detail="${3:-}"
  local fix="${4:-}"

  case "$status" in
    pass)
      echo -e "  ${GREEN}✓${RESET}  ${BOLD}$label${RESET}${detail:+  ${DIM}— $detail${RESET}}"
      ;;
    warn)
      echo -e "  ${YELLOW}⚠${RESET}  ${BOLD}$label${RESET}${detail:+  ${DIM}— $detail${RESET}}"
      [[ -n "$fix" ]] && echo -e "     ${DIM}→ $fix${RESET}"
      DOCTOR_WARNED=$((DOCTOR_WARNED + 1))
      ;;
    fail)
      echo -e "  ${RED}✗${RESET}  ${BOLD}$label${RESET}${detail:+  ${DIM}— $detail${RESET}}"
      [[ -n "$fix" ]] && echo -e "     ${DIM}→ $fix${RESET}"
      DOCTOR_FAILED=$((DOCTOR_FAILED + 1))
      ;;
  esac
}

doctor() {
  section "Owlat Environment Doctor"

  echo -e "  ${BOLD}Host prerequisites${RESET}"
  if command -v docker >/dev/null 2>&1; then
    doctor_check pass "Docker installed" "$(docker --version | head -1)"
  else
    doctor_check fail "Docker installed" "not found" "install from https://docs.docker.com/engine/install/"
  fi

  if docker compose version >/dev/null 2>&1; then
    doctor_check pass "Docker Compose v2" "$(docker compose version | head -1)"
  else
    doctor_check fail "Docker Compose v2" "not found" "install the 'compose' plugin"
  fi

  if command -v openssl >/dev/null 2>&1; then
    doctor_check pass "openssl installed"
  else
    doctor_check warn "openssl not installed" "needed to regenerate secrets" "apt install openssl"
  fi

  if command -v curl >/dev/null 2>&1; then
    doctor_check pass "curl installed"
  else
    doctor_check fail "curl installed" "not found" "apt install curl"
  fi

  if command -v dig >/dev/null 2>&1 || command -v nslookup >/dev/null 2>&1; then
    doctor_check pass "DNS tools available"
  else
    doctor_check warn "No DNS tools (dig/nslookup)" "needed for DNS validation" "apt install dnsutils"
  fi

  echo ""
  echo -e "  ${BOLD}SMTP egress${RESET}"
  if command -v nc >/dev/null 2>&1; then
    if timeout 8 nc -zv aspmx.l.google.com 25 >/dev/null 2>&1; then
      doctor_check pass "Outbound SMTP (port 25)" "can reach aspmx.l.google.com:25"
    else
      doctor_check fail "Outbound SMTP (port 25) blocked" \
        "cannot reach aspmx.l.google.com:25" \
        "most cloud providers block port 25 by default — contact support or request unblock"
    fi
  else
    doctor_check warn "Cannot test SMTP egress" "'nc' not installed" "apt install netcat-openbsd"
  fi

  echo ""
  echo -e "  ${BOLD}Configuration${RESET}"
  if [[ -f .env ]]; then
    doctor_check pass ".env file present"

    local missing=()
    for var in INSTANCE_SECRET MTA_API_KEY MTA_WEBHOOK_SECRET; do
      if ! grep -qE "^${var}=.+" .env 2>/dev/null; then
        missing+=("$var")
      fi
    done
    if [[ ${#missing[@]} -eq 0 ]]; then
      doctor_check pass "Required secrets set" "INSTANCE_SECRET, MTA_API_KEY, MTA_WEBHOOK_SECRET"
    else
      doctor_check fail "Missing secrets" "${missing[*]}" "regenerate with: openssl rand -hex 32"
    fi

    local dkim
    dkim=$(grep -E "^DKIM_KEYS=" .env | cut -d= -f2- || true)
    if [[ -n "$dkim" && "$dkim" != "{}" ]]; then
      if echo "$dkim" | grep -q "BEGIN RSA PRIVATE KEY"; then
        doctor_check pass "DKIM keys configured"
      else
        doctor_check warn "DKIM keys don't look right" "no RSA PRIVATE KEY marker found" \
          "see https://docs.owlat.app/developer/self-hosting-dns-email"
      fi
    else
      doctor_check warn "DKIM keys not configured" "emails will fail DKIM auth" \
        "see https://docs.owlat.app/developer/self-hosting-dns-email"
    fi

    if grep -qE "^EHLO_HOSTNAME=.+" .env 2>/dev/null; then
      local ehlo
      ehlo=$(grep -E "^EHLO_HOSTNAME=" .env | cut -d= -f2-)
      if [[ "$ehlo" == "mail.localhost" || "$ehlo" == "mail.example.com" ]]; then
        doctor_check warn "EHLO_HOSTNAME is a placeholder" "$ehlo" \
          "set to your real mail hostname (must match rDNS)"
      else
        doctor_check pass "EHLO_HOSTNAME set" "$ehlo"
      fi
    fi
  else
    doctor_check fail ".env file not found" "run 'bash scripts/setup.sh' first" ""
  fi

  echo ""
  echo -e "  ${BOLD}Running services${RESET}"
  if docker compose ps --format '{{.Service}}\t{{.State}}' 2>/dev/null | grep -q .; then
    for svc in convex web mta; do
      if docker compose ps --format '{{.Service}}\t{{.State}}' 2>/dev/null | grep -qE "^${svc}[[:space:]]+running"; then
        doctor_check pass "$svc running"
      else
        doctor_check fail "$svc not running" "" "docker compose up -d $svc"
      fi
    done

    if docker compose ps --format '{{.Service}}\t{{.State}}' 2>/dev/null | grep -qE "^clamav[[:space:]]+running"; then
      doctor_check pass "clamav running"
    else
      doctor_check warn "clamav not running" "attachment scanning disabled" "docker compose up -d clamav"
    fi

    if curl -sf --max-time 3 "http://localhost:${CONVEX_PORT:-3210}/version" >/dev/null 2>&1; then
      doctor_check pass "Convex HTTP reachable" "http://localhost:${CONVEX_PORT:-3210}"
    else
      doctor_check warn "Convex HTTP unreachable" "" "check port mapping / firewall"
    fi
  else
    doctor_check warn "No containers running" "run 'docker compose up -d' to start the stack" ""
  fi

  echo ""
  if command -v dig >/dev/null 2>&1 && [[ -f .env ]]; then
    local ehlo
    ehlo=$(grep -E "^EHLO_HOSTNAME=" .env | cut -d= -f2- || true)
    if [[ -n "$ehlo" && "$ehlo" != "mail.localhost" && "$ehlo" != "mail.example.com" ]]; then
      echo -e "  ${BOLD}DNS (for $ehlo)${RESET}"
      if dig +short +time=3 +tries=1 A "$ehlo" | grep -qE "^[0-9]+\.[0-9]+"; then
        doctor_check pass "A record found" "$ehlo"
      else
        doctor_check warn "No A record for $ehlo" "" "add A record pointing to your VPS IP"
      fi
      echo ""
    fi
  fi

  echo -e "  ${BOLD}Summary${RESET}"
  if [[ $DOCTOR_FAILED -eq 0 && $DOCTOR_WARNED -eq 0 ]]; then
    echo -e "  ${GREEN}All checks passed.${RESET} Your Owlat install looks healthy."
    echo ""
    return 0
  elif [[ $DOCTOR_FAILED -eq 0 ]]; then
    echo -e "  ${YELLOW}${DOCTOR_WARNED} warning(s).${RESET} Owlat will run but some features may be degraded."
    echo ""
    return 0
  else
    echo -e "  ${RED}${DOCTOR_FAILED} failure(s)${RESET}${DOCTOR_WARNED:+, ${YELLOW}${DOCTOR_WARNED} warning(s)${RESET}}. Fix the failures above before sending mail."
    echo ""
    return 1
  fi
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
  SETUP_INTERRUPTED=true

  show_welcome
  select_deployment_mode

  if [[ "$DEPLOYMENT_MODE" == "selfhost" ]]; then
    check_prerequisites_selfhost
    configure_selfhost_core
    configure_selfhost_mta
    configure_email_security
    configure_optional_selfhost
    write_selfhost_env
    run_docker_compose
    set_convex_env_vars_selfhost
    setup_admin_account
    seed_admin_selfhost
    show_summary_selfhost
  else
    check_prerequisites
    install_dependencies
    setup_convex
    configure_core
    configure_email
    configure_email_security
    configure_optional
    write_env_file
    set_convex_env_vars
    setup_admin_account
    seed_admin_account
    show_summary
  fi
}

# Dispatch subcommand
case "$SUBCOMMAND" in
  doctor)
    doctor
    exit $?
    ;;
  "")
    main "$@"
    ;;
  *)
    echo "Unknown subcommand: $SUBCOMMAND" >&2
    echo "Available: doctor (or no subcommand for the wizard)" >&2
    exit 2
    ;;
esac
