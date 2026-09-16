#!/usr/bin/env bash
#
# Installer invariants. install.sh and scripts/owlat are the one-liner install
# entrypoints; they are pure bash and no runtime test exercises them. This gate
# pins the properties that matter for supply-chain integrity: where the code and
# the wizard image come from, that the image tag follows the pinned version, that
# a GitHub API failure never silently downgrades an install to the bleeding-edge
# branch, that an update never proceeds past a failed fetch, that the host config
# file enters the wizard container read-only, and that quickstart never switches a
# production install into OWLAT_DEV_MODE (which unlocks POST /dev/reset).
#
# Operational conveniences (docker daemon preflight, install dir default, backup
# schedule wiring, help text) are deliberately NOT pinned here.

set -uo pipefail
cd "$(dirname "$0")/.."

install_sh="install.sh"
owlat_cli="scripts/owlat"
quickstart_ts="apps/setup-cli/src/commands/quickstart.ts"

fail=0
ok() { echo "ok:   $1"; }
bad() { echo "FAIL: $1" >&2; fail=1; }

# Print a bash function body: from `name() {` to the first line that is just `}`.
fn() { awk -v name="$1" '$0 ~ "^"name"\\(\\) \\{" {p=1} p {print} p && /^\}/ {exit}' "$2"; }

# --- source and image come from the canonical org ---------------------------
if grep -qE '^OWLAT_REPO="\$\{OWLAT_REPO:-https://github\.com/wolvesdotink/owlat\.git\}"' "$install_sh"; then
	ok "install.sh defaults OWLAT_REPO to wolvesdotink/owlat"
else bad "install.sh must default OWLAT_REPO to https://github.com/wolvesdotink/owlat.git"; fi

if grep -q 'ghcr.io/wolvesdotink/setup:' "$owlat_cli"; then
	ok "scripts/owlat pulls the setup image from ghcr.io/wolvesdotink"
else bad "scripts/owlat must default the setup image to ghcr.io/wolvesdotink/setup:<tag>"; fi

for f in "$install_sh" "$owlat_cli"; do
	if grep -qE 'owlat/owlat|ghcr\.io/owlat\b' "$f"; then
		bad "$f references the placeholder org (owlat/owlat or ghcr.io/owlat)"
	else ok "$f has no placeholder-org reference"; fi
done

# --- the wizard image tag follows the pinned OWLAT_VERSION --------------------
if grep -qE "grep -E '\^OWLAT_VERSION=' \"\\\$OWLAT_DIR/\.env\"" "$owlat_cli" \
	&& ! grep -qE 'OWLAT_VERSION_TAG="\$\{OWLAT_VERSION:-latest\}"' "$owlat_cli"; then
	ok "scripts/owlat derives the setup image tag from the pinned OWLAT_VERSION"
else bad "scripts/owlat must read OWLAT_VERSION from .env and not default straight to :latest"; fi

run_wizard=$(fn run_wizard "$install_sh")
if grep -q 'setup_tag="$ref_ver"' <<<"$run_wizard" && grep -q 'Could not pin the setup wizard image' <<<"$run_wizard"; then
	ok "install.sh pins the wizard tag to a vX.Y.Z ref and warns when it cannot"
else bad "install.sh run_wizard must derive setup_tag from the release ref and warn when it cannot pin"; fi

# --- a GitHub API failure never silently downgrades to main -------------------
resolve_ref=$(fn resolve_ref "$install_sh")
if grep -q '%{http_code}' <<<"$resolve_ref" \
	&& grep -qE 'http_code"?\s*==\s*"?404' <<<"$resolve_ref" \
	&& grep -qE '\bdie\b' <<<"$resolve_ref" \
	&& ! grep -Pzq '\belse\b\s*\n\s*OWLAT_REF="main"' <<<"$resolve_ref"; then
	ok "install.sh resolve_ref inspects the HTTP status and dies on a hard API error"
else bad "install.sh resolve_ref must fall back to main only on 404 and die on other API errors"; fi

# --- an update never proceeds past a failed fetch/checkout --------------------
ensure_repo=$(fn ensure_repo "$install_sh")
update_block=$(awk '/Existing clone/{p=1} p && /^\telse/{exit} p' <<<"$ensure_repo")
if [ -n "$update_block" ] && ! grep -q '|| true' <<<"$update_block" && grep -q 'die ' <<<"$update_block"; then
	ok "install.sh ensure_repo does not swallow git fetch/checkout failures"
else bad "install.sh ensure_repo update path must not use '|| true' and must die on failure"; fi

# --- the host config file is mounted read-only --------------------------------
if grep -qE '"\$OWLAT_CONFIG_FILE:\$CONFIG_IN_CONTAINER:ro"' "$owlat_cli"; then
	ok "scripts/owlat bind-mounts OWLAT_CONFIG_FILE read-only"
else bad "scripts/owlat must mount OWLAT_CONFIG_FILE at CONFIG_IN_CONTAINER with :ro"; fi

# --- every provisioning path puts `owlat` on PATH ------------------------------
# The day-2 ops docs promise a `/usr/local/bin/owlat`, but install.sh is not the
# only provisioner: the desktop SSH wizard and the hand-clone flow both run
# `scripts/owlat quickstart` and never reach install.sh. The link therefore lives
# in the wrapper, and install.sh must delegate rather than keep a second copy.
if grep -qE '^ensure_cli_on_path\(\) \{' "$owlat_cli" \
	&& grep -qE '^\tsetup\|quickstart\|config\)' "$owlat_cli" \
	&& grep -q 'ensure_cli_on_path || true' "$owlat_cli"; then
	ok "scripts/owlat links the CLI onto PATH on its provisioning subcommands"
else bad "scripts/owlat must call ensure_cli_on_path for setup|quickstart|config"; fi

if grep -qE '^\tinstall-cli\)' "$owlat_cli"; then
	ok "scripts/owlat exposes 'install-cli' as the explicit repair command"
else bad "scripts/owlat must expose an 'install-cli' subcommand"; fi

install_cli=$(fn install_owlat_cli "$install_sh")
if grep -q 'install-cli' <<<"$install_cli" && ! grep -q 'ln -s' <<<"$install_cli"; then
	ok "install.sh delegates the CLI symlink to scripts/owlat install-cli"
else bad "install.sh install_owlat_cli must delegate to 'scripts/owlat install-cli', not re-implement ln -s"; fi

# --- quickstart never turns dev mode on ---------------------------------------
if grep -qE "OWLAT_DEV_MODE:\s*'true'|OWLAT_DEV_MODE['\"]?\]?\s*=\s*['\"]true" "$quickstart_ts"; then
	bad "quickstart.ts must never write OWLAT_DEV_MODE=true (it unlocks POST /dev/reset)"
else ok "quickstart.ts never enables OWLAT_DEV_MODE"; fi

exit $fail
