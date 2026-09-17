#!/usr/bin/env bash
#
# Deployment-policy invariants for the shipped compose stacks and the env
# templates that go with them.
#
# Nothing in CI runs `docker compose config`, so the properties self-hosters
# depend on are pinned here as text assertions against the checked-in files.
# This gate is wired as `lint:compose` so that editing a compose file or an env
# template actually triggers it — the same checks used to live in
# packages/shared's vitest suite, where they only ran when turbo thought the
# library had changed.
#
# What is pinned:
#   • Code worker: drives internal Convex functions but must never hold the
#     admin key (security review M4). It authenticates to the convex-fn-proxy
#     sidecar with CODE_WORKER_PROXY_TOKEN, the proxy holds CONVEX_ADMIN_KEY,
#     and egress goes through the allowlisted forward proxy.
#     `codeWorkTasks.reclaimStale` requeues every running row when a worker
#     starts, so a second replica would rip the first one's task away: pinned
#     to one replica. Plus the Tier-3 sandbox (read-only rootfs, cap set,
#     resource caps, isolated network membership).
#   • Registry: every Owlat image points at ghcr.io/wolvesdotink and is pinned
#     via ${OWLAT_VERSION:-dev}, never the mutable :latest.
#   • Docker socket: only the read-only docker-socket-proxy mounts it, and the
#     privileged Docker API sits on an internal-only network.
#   • Receiving profiles: external-mail and personal-mail stay bootable.
#   • IMAP: the TLS key is owned by the uid the image actually runs as (and
#     stays 0600), and the LOGIN brute-force limiter has a Redis behind it.
#     Both were broken from the first release: 724 crash-loops and an
#     internet-facing auth port with no throttling.
#   • IPv6: the shipped install is IPv4-only behind one explicit flag.
#   • Feature-flag registry: every activatable docker profile exists in both
#     compose files and every required env var is in the VPS template.
#   • VPS fill contract: every variable the VPS compose file interpolates is
#     either assigned in .env.vps.template or declared `# owlat:external`.
#     MTA_SECRET and the FBL_DEDUP pair were both missing for months; a missing
#     `${VAR:?}` aborts every compose subcommand, `logs` and `down` included.
#
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
ok() { echo "ok:   $1"; }
bad() { echo "FAIL: $1" >&2; fail=1; }

# The first top-level service block named $2 in compose file $1.
service_block() {
	awk -v name="$2" '
		$0 == "  " name ":" && !seen { p=1; seen=1; print; next }
		p && /^  [a-z][a-z0-9-]*:$/ { exit }
		p { print }
	' "$1"
}

for compose in docker-compose.yml infra/templates/docker-compose.vps.yml; do
	worker=$(service_block "$compose" code-worker)
	proxy=$(service_block "$compose" convex-fn-proxy)
	[ -n "$worker" ] || { bad "$compose: no code-worker service"; continue; }
	[ -n "$proxy" ] || { bad "$compose: no convex-fn-proxy service"; continue; }

	if grep -qE '^ {6}CONVEX_URL: http://convex-fn-proxy:3220$' <<<"$worker" \
		&& grep -qE '^ {6}CODE_WORKER_CONVEX_KEY: \$\{CODE_WORKER_PROXY_TOKEN(:-)?\}$' <<<"$worker" \
		&& ! grep -qE '^ {6}CONVEX_ADMIN_KEY:' <<<"$worker"; then
		ok "$compose: code-worker reaches Convex through convex-fn-proxy with the proxy token, not the admin key"
	else bad "$compose: code-worker must use CONVEX_URL=http://convex-fn-proxy:3220 and CODE_WORKER_CONVEX_KEY=\${CODE_WORKER_PROXY_TOKEN} and carry no CONVEX_ADMIN_KEY"; fi

	if grep -qE '^ {6}HTTPS_PROXY: http://code-worker-egress:8888$' <<<"$worker"; then
		ok "$compose: code-worker egress is forced through code-worker-egress"
	else bad "$compose: code-worker must set HTTPS_PROXY=http://code-worker-egress:8888"; fi

	if grep -qE '^ {6}CONVEX_URL: http://convex:3210$' <<<"$proxy" \
		&& grep -qE '^ {6}CONVEX_ADMIN_KEY: \$\{CONVEX_ADMIN_KEY(:-)?\}$' <<<"$proxy" \
		&& grep -qE '^ {6}CODE_WORKER_PROXY_TOKEN: \$\{CODE_WORKER_PROXY_TOKEN(:-)?\}$' <<<"$proxy"; then
		ok "$compose: convex-fn-proxy holds the admin key and validates the proxy token"
	else bad "$compose: convex-fn-proxy must set CONVEX_URL=http://convex:3210, CONVEX_ADMIN_KEY and CODE_WORKER_PROXY_TOKEN"; fi

	if grep -Pzq '\n {4}deploy:\n {6}replicas: 1\n' <<<"$worker"; then
		ok "$compose: code-worker is pinned to a single replica"
	else bad "$compose: code-worker must declare deploy.replicas: 1"; fi
done


root=docker-compose.yml
vps=infra/templates/docker-compose.vps.yml

# --- registry and version pinning --------------------------------------------
owlat_images=(web mta updater convex-deploy imap mail-sync)

if grep -qE 'ghcr\.io/owlat\b' "$root"; then
	bad "$root still references the ghcr.io/owlat placeholder org"
else ok "$root has no ghcr.io/owlat placeholder reference"; fi

missing_image=
for svc in "${owlat_images[@]}"; do
	grep -qE "image: *ghcr\.io/wolvesdotink/$svc:\\\$\{OWLAT_VERSION:-dev\}" \
		<<<"$(service_block "$root" "$svc")" || missing_image="$missing_image $svc"
done
if [ -z "$missing_image" ]; then
	ok "$root pins every Owlat image to ghcr.io/wolvesdotink/<svc>:\${OWLAT_VERSION:-dev}"
else bad "$root:$missing_image must use image: ghcr.io/wolvesdotink/<svc>:\${OWLAT_VERSION:-dev}"; fi

if grep -qE 'ghcr\.io/wolvesdotink/[a-z0-9-]+:(latest\b|\$\{OWLAT_VERSION:-latest\})|owlat-code-worker:\$\{OWLAT_VERSION:-latest\}' "$root"; then
	bad "$root pins an image to the mutable :latest tag"
else ok "$root pins no image to :latest"; fi

# --- docker socket exposure ---------------------------------------------------
# A bind mount without a `:ro` suffix is read-write, which hands the mounting
# container effective root on the host.
if grep -qP '/var/run/docker\.sock:/var/run/docker\.sock(?!:ro)' "$root"; then
	bad "$root bind-mounts /var/run/docker.sock read-write (missing the :ro suffix)"
else ok "$root mounts the docker socket read-only wherever it is mounted"; fi

socket_proxy=$(service_block "$root" docker-socket-proxy)
if grep -qE 'image: *tecnativa/docker-socket-proxy:' <<<"$socket_proxy" \
	&& grep -qE '/var/run/docker\.sock:/var/run/docker\.sock:ro' <<<"$socket_proxy" \
	&& grep -qE '^ {6}- docker-proxy$' <<<"$socket_proxy" \
	&& ! grep -qE '^ {6}- default$' <<<"$socket_proxy"; then
	ok "$root runs docker-socket-proxy with a read-only socket on docker-proxy only"
else bad "$root docker-socket-proxy must mount the socket :ro and attach to docker-proxy only"; fi

updater=$(service_block "$root" updater)
if grep -qE 'DOCKER_HOST: *tcp://docker-socket-proxy:2375' <<<"$updater" \
	&& grep -Pzq '\n {4}depends_on:\n {6}- docker-socket-proxy\n' <<<"$updater" \
	&& ! grep -qE '\- */var/run/docker\.sock' <<<"$updater"; then
	ok "$root updater reaches Docker through the proxy, never the raw socket"
else bad "$root updater must set DOCKER_HOST=tcp://docker-socket-proxy:2375, depend on the proxy and mount no socket"; fi

if grep -Pzq '\n {2}docker-proxy:\n {4}internal: true\n' "$root"; then
	ok "$root keeps the docker-proxy network internal:true"
else bad "$root must declare the docker-proxy network with internal: true"; fi

proxy_members=$(grep -cE '^ +- docker-proxy$' "$root")
if [ "$proxy_members" = 2 ]; then
	ok "$root attaches exactly docker-socket-proxy and updater to docker-proxy"
else bad "$root has $proxy_members services on the docker-proxy network (expected 2: the proxy and the updater)"; fi

# --- ClamAV stays opt-in and fail-open ----------------------------------------
if grep -Pzq '\n {6}- clamav\n' <<<"$(service_block "$root" clamav)"; then
	ok "$root profile-gates clamav behind the clamav profile"
else bad "$root clamav service must declare profiles: [clamav]"; fi

mta_clamav=$(awk '
	/^ {4}depends_on:$/ { d=1; next }
	d && /^ {6}clamav:$/ { p=1; next }
	p && /^ {6}[a-z]/ { exit }
	p { print }
' <<<"$(service_block "$root" mta)")
if grep -qE '^ {8}required: false$' <<<"$mta_clamav"; then
	ok "$root keeps the MTA dependency on clamav required:false (scanning fails open)"
else bad "$root mta depends_on.clamav must set required: false so the MTA boots without clamd"; fi

# --- Tier-3 worker sandbox ----------------------------------------------------
worker_root=$(service_block "$root" code-worker)
if grep -qE '^ {4}read_only: true$' <<<"$worker_root" \
	&& grep -Pzq '\n {4}tmpfs:\n {6}- /tmp:size=' <<<"$worker_root"; then
	ok "$root code-worker runs read-only with a size-capped tmpfs scratch"
else bad "$root code-worker must set read_only: true and a /tmp:size= tmpfs"; fi

caps=$(awk '/^ {4}cap_add:$/{p=1;next} p && /^ {6}- /{print $2;next} p{exit}' <<<"$worker_root" | sort | tr '\n' ' ')
if grep -Pzq '\n {4}cap_drop:\n {6}- ALL\n' <<<"$worker_root" \
	&& [ "$caps" = "CHOWN SETGID SETUID " ] \
	&& grep -q 'no-new-privileges:true' <<<"$worker_root"; then
	ok "$root code-worker drops ALL capabilities and adds back only chown/setgid/setuid"
else bad "$root code-worker must cap_drop ALL, cap_add exactly CHOWN/SETGID/SETUID (got: ${caps:-none}) and set no-new-privileges:true"; fi

if grep -qE '^ {4}mem_limit: \$\{CODE_WORKER_MEM_LIMIT' <<<"$worker_root" \
	&& grep -qE '^ {4}cpus: \$\{CODE_WORKER_CPUS' <<<"$worker_root" \
	&& grep -qE '^ {4}pids_limit: \$\{CODE_WORKER_PIDS_LIMIT' <<<"$worker_root"; then
	ok "$root code-worker caps memory, CPU and process count"
else bad "$root code-worker must set mem_limit, cpus and pids_limit from CODE_WORKER_* variables"; fi

# The isolated bridge carries exactly the worker, Convex, and the worker's two
# dual-homed sidecars: convex-fn-proxy (holds the admin key) and
# code-worker-egress (the only route off a network that is `internal: true`).
# A fifth member widens what a compromised job can reach laterally.
cw_missing=
for svc in convex code-worker convex-fn-proxy code-worker-egress; do
	grep -qE '^ {6}- code-worker$' <<<"$(service_block "$root" "$svc")" || cw_missing="$cw_missing $svc"
done
cw_members=$(grep -cE '^ +- code-worker$' "$root")
if [ -z "$cw_missing" ] && [ "$cw_members" = 4 ] && ! grep -qE '^ {6}- default$' <<<"$worker_root"; then
	ok "$root pins the code-worker network to its four intended members"
else bad "$root code-worker network must hold exactly convex, code-worker, convex-fn-proxy and code-worker-egress (missing:${cw_missing:- none}, members: $cw_members)"; fi

if grep -qE '^ {6}- inbox-codetasks$' <<<"$worker_root" && grep -qE '^ {6}- plugin-tasks$' <<<"$worker_root"; then
	ok "$root code-worker activates for both the coding-agent and plugin-task profiles"
else bad "$root code-worker must list both the inbox-codetasks and plugin-tasks profiles"; fi

# --- broad privilege hardening ------------------------------------------------
nnp=$(grep -c 'no-new-privileges:true' "$root")
capdrop=$(grep -c 'cap_drop:' "$root")
if [ "$nnp" -ge 10 ] && [ "$capdrop" -ge 8 ]; then
	ok "$root drops privileges broadly ($nnp no-new-privileges, $capdrop cap_drop)"
else bad "$root privilege hardening regressed: $nnp no-new-privileges (expected >=10), $capdrop cap_drop (expected >=8)"; fi

web_block=$(service_block "$root" web)
if grep -qE '^ {4}read_only: true$' <<<"$web_block" && grep -Pzq '\n {4}tmpfs:\n {6}- /tmp' <<<"$web_block"; then
	ok "$root runs the web tier read-only with a tmpfs /tmp"
else bad "$root web service must set read_only: true with a tmpfs /tmp"; fi

# The app reads its deployment-specific config from runtime config, which Nitro
# fills ONLY from NUXT_PUBLIC_* names. An operator-facing OWLAT_* variable that
# is not mapped across is silently frozen at whatever the image was built with —
# that is how every release shipped with the in-app updater hidden.
if grep -qE '^ {6}NUXT_PUBLIC_DEPLOYMENT_MODE: \$\{OWLAT_DEPLOYMENT_MODE:-selfhost\}$' <<<"$web_block"; then
	ok "$root maps OWLAT_DEPLOYMENT_MODE onto NUXT_PUBLIC_* for the web tier"
else bad "$root web service must map OWLAT_DEPLOYMENT_MODE onto NUXT_PUBLIC_DEPLOYMENT_MODE or the app cannot see it"; fi

# Setup mode has TWO halves — the server gate (OWLAT_SETUP_MODE) and the client
# redirect (NUXT_PUBLIC_SETUP_MODE, the only form Nitro maps). Wire one without
# the other and the app redirects every route to a wizard whose API answers 403,
# with no way back except editing .env by hand. Both compose files, keyed off the
# same variable.
for compose in "$root" "$vps"; do
	block=$(service_block "$compose" web)
	server_half=$(grep -cE '^ {6}OWLAT_SETUP_MODE: \$\{OWLAT_SETUP_MODE:-false\}$' <<<"$block" || true)
	client_half=$(grep -cE '^ {6}NUXT_PUBLIC_SETUP_MODE: \$\{OWLAT_SETUP_MODE:-false\}$' <<<"$block" || true)
	if [ "${server_half:-0}" -eq 1 ] && [ "${client_half:-0}" -eq 1 ]; then
		ok "$compose wires both halves of setup mode from OWLAT_SETUP_MODE"
	else bad "$compose web service must set BOTH OWLAT_SETUP_MODE and NUXT_PUBLIC_SETUP_MODE from \${OWLAT_SETUP_MODE:-false} (server gate=${server_half:-0}, client redirect=${client_half:-0})"; fi
done

# The version belongs to the IMAGE. A compose override would let the app report a
# version the running image is not.
if grep -qE '^ {6}NUXT_PUBLIC_OWLAT_(VERSION|GIT_SHA|BUILD_DATE):' <<<"$web_block"; then
	bad "$root must not set NUXT_PUBLIC_OWLAT_VERSION/GIT_SHA/BUILD_DATE — the web image exports them"
else ok "$root leaves the web version metadata to the image"; fi

# --- receiving profiles stay bootable -----------------------------------------
# An empty MAIL_SYNC_API_KEY default makes apps/mail-sync/src/config.ts throw on
# boot, and apps/imap/src/server.ts refuses to start in production without a TLS
# cert — both used to crash-loop the opt-in receiving stacks.
mail_sync=$(service_block "$root" mail-sync)
if grep -qE '^ {6}MAIL_SYNC_API_KEY: \$\{MAIL_SYNC_API_KEY\}$' <<<"$mail_sync" \
	&& grep -qE '^ {6}- external-mail$' <<<"$mail_sync"; then
	ok "$root runs mail-sync under external-mail with a defaultless MAIL_SYNC_API_KEY"
else bad "$root mail-sync must use MAIL_SYNC_API_KEY: \${MAIL_SYNC_API_KEY} (no :- default) under the external-mail profile"; fi

# A required secret must never be interpolated with the `${VAR:-}` empty
# default. Compose bakes the resolved value into the container at CREATE time,
# so an empty one is not a degraded mode — it is a container that rejects its
# own config at boot and then crash-loops on it FOREVER, long after .env is
# fixed. imap burnt 11h of a live instance that way. Every consumer of
# CONVEX_ADMIN_KEY throws on an empty value (apps/imap/src/config.ts,
# apps/mail-sync/src/config.ts, apps/convex-fn-proxy/src/proxy.ts), so the
# defaultless `${CONVEX_ADMIN_KEY}` form is pinned here in BOTH compose files.
#
# It is NOT `${CONVEX_ADMIN_KEY:?}`, and must not be "upgraded" to it: the key
# can only be minted by an already-running backend, so .env legitimately holds
# it empty during the install's first `up` — and because compose interpolates
# the whole file before profile filtering, `:?` would abort that `up` along with
# every later `down`/`logs`/`ps`, scripts/backup.sh and scripts/restore.sh.
# The creation-order half is fixed in the setup flow, which re-runs `up -d`
# after the key lands (apps/setup-cli/src/commands/quickstart.ts, scripts/setup.sh).
for compose in "$root" "$vps"; do
	defaulted=$(grep -cE '^ {6}CONVEX_ADMIN_KEY: \$\{CONVEX_ADMIN_KEY:-\}$' "$compose" || true)
	consumers=$(grep -cE '^ {6}CONVEX_ADMIN_KEY: \$\{CONVEX_ADMIN_KEY\}$' "$compose" || true)
	if [ "${defaulted:-0}" -eq 0 ] && [ "${consumers:-0}" -ge 1 ]; then
		ok "$compose interpolates CONVEX_ADMIN_KEY with no empty default ($consumers consumer(s))"
	else bad "$compose must use CONVEX_ADMIN_KEY: \${CONVEX_ADMIN_KEY} with no :- default (found ${defaulted:-0} defaulted, ${consumers:-0} defaultless) — an empty admin key crash-loops imap/mail-sync/convex-fn-proxy forever"; fi
done

cert_init=$(service_block "$root" imap-cert-init)
imap_block=$(service_block "$root" imap)
if [ -n "$cert_init" ] && grep -qE '^ {6}- personal-mail$' <<<"$cert_init" \
	&& grep -Pzq 'imap-cert-init:\n {8}condition: service_completed_successfully\n' <<<"$imap_block"; then
	ok "$root provisions the IMAP TLS cert under personal-mail before the imap server starts"
else bad "$root needs an imap-cert-init service on the personal-mail profile that imap depends on with service_completed_successfully"; fi

# --- the IMAP TLS key must be readable BY THE PROCESS THAT NEEDS IT -----------
# Provisioning the cert is only half of it. imap-cert-init runs as root, so the
# 0600 key it writes lands as root:root — while the imap image runs as uid 1000
# and mounts mail-certs `:ro`, so it can neither read the key nor repair it.
# `EACCES: permission denied, open '/opt/owlat/certs/default.key'` out of
# loadConfig, then `restart: unless-stopped` forever: a live instance logged 724
# restarts having never once served IMAP. Four properties are pinned.
if grep -qF 'chown -R "$${IMAP_RUNTIME_USER}" "$$cert_dir"' <<<"$cert_init"; then
	ok "$root imap-cert-init hands the cert dir to the uid the imap image runs as"
else bad "$root imap-cert-init must chown the cert dir to \${IMAP_RUNTIME_USER}, or imap EACCESes on its own TLS key and crash-loops"; fi

# The fixup has to run on EVERY boot, including the branch that finds a cert
# already there — that is the only thing that heals a volume an older install
# already poisoned, or a key an ACME sidecar has just re-published as root. An
# early `exit 0` on the already-present branch silently skips it.
if grep -qF 'exit 0' <<<"$cert_init"; then
	bad "$root imap-cert-init exits early on the already-present branch — the ownership fixup must run on every boot or a poisoned volume stays broken forever"
else ok "$root imap-cert-init applies the ownership fixup on every boot, not just when it generates a cert"; fi

# Fixing ownership must not be done by widening the mode instead.
key_modes=$(grep -oE 'chmod [0-7]+ "\$\$cert_dir/default\.key"' <<<"$cert_init" | awk '{print $2}' | sort -u | tr '\n' ' ')
if [ "$key_modes" = "600 " ]; then
	ok "$root imap-cert-init keeps the private key 0600 (never group- or world-readable)"
else bad "$root imap-cert-init must chmod the private key to exactly 600 (found: ${key_modes:-none})"; fi

# The chown target here and the image's USER there are the same fact in two
# files, so they are pinned to each other: apps/imap/Dockerfile asserts its
# runtime uid:gid at BUILD time, and every declared default must agree with it.
image_user=$(grep -oE '= "[0-9]+:[0-9]+"' apps/imap/Dockerfile | head -1 | tr -d '= "')
pinned_users=$(grep -ohE 'IMAP_RUNTIME_USER:-[0-9]+:[0-9]+' \
	"$root" "$vps" infra/templates/acme-entrypoint.sh | sed 's/.*:-//' | sort -u)
if [ -n "$image_user" ] && [ "$(printf '%s\n' "$pinned_users" | wc -l | tr -d ' ')" = 1 ] \
	&& [ "$pinned_users" = "$image_user" ]; then
	ok "every IMAP_RUNTIME_USER default matches the uid:gid apps/imap/Dockerfile asserts ($image_user)"
else bad "IMAP_RUNTIME_USER defaults (${pinned_users:-none}) must all equal the uid:gid asserted in apps/imap/Dockerfile (${image_user:-none}) — drift here means imap cannot read its own TLS key"; fi

# Same defect, second delivery path: on the VPS the ACME sidecar (lego, root)
# re-publishes default.key on every renewal, so without a chown the EACCES comes
# back every time the certificate rolls over — even after a manual fix.
acme_sh=infra/templates/acme-entrypoint.sh
acme_key_modes=$(grep -oE 'install -m [0-7]+ "\$key"' "$acme_sh" | awk '{print $3}' | sort -u | tr '\n' ' ')
if grep -qF 'chown "$IMAP_RUNTIME_USER"' "$acme_sh" && [ "$acme_key_modes" = "0600 " ]; then
	ok "$acme_sh publishes the key 0600 and hands ownership to IMAP_RUNTIME_USER on every renewal"
else bad "$acme_sh must install the key with mode 0600 (found: ${acme_key_modes:-none}) and chown it to \$IMAP_RUNTIME_USER, or IMAP EACCESes again at the next renewal"; fi

if grep -qE '^ {6}IMAP_RUNTIME_USER: \$\{IMAP_RUNTIME_USER:-[0-9]+:[0-9]+\}$' <<<"$(service_block "$vps" acme)"; then
	ok "$vps passes IMAP_RUNTIME_USER to the acme sidecar"
else bad "$vps acme service must set IMAP_RUNTIME_USER so acme-entrypoint.sh knows who may read the published key"; fi

# --- the IMAP auth rate limiter must have a backing store --------------------
# Port 993 is internet-facing and LOGIN is the only thing between it and a
# user's mail, but REDIS_URL used to be set on exactly one service per compose
# file (mta). apps/imap's brute-force limiter therefore had no counters on every
# deployment ever made, announced solely by a level-40 line at boot. The app now
# refuses to start in production without it, so an omission here is a crash-loop
# rather than a silent hole — pin it in both files.
for compose in "$root" "$vps"; do
	block=$(service_block "$compose" imap)
	if grep -qE '^ {6}REDIS_URL: redis://:\$\{REDIS_PASSWORD[^}]*\}@redis:6379$' <<<"$block"; then
		ok "$compose backs the IMAP auth rate limiter with the shared Redis"
	else bad "$compose imap service must set REDIS_URL=redis://:\${REDIS_PASSWORD…}@redis:6379 — without it port 993 accepts unlimited password guessing"; fi

	# service_healthy, not service_started: a security control should be
	# answering before the listener takes its first LOGIN.
	if awk '/^ {4}depends_on:$/ { d=1; next }
		d && /^ {6}redis:$/ { p=1; next }
		p && /^ {6}[a-z]/ { exit }
		p { print }' <<<"$block" | grep -qE '^ {8}condition: service_healthy$'; then
		ok "$compose holds imap back until Redis is healthy"
	else bad "$compose imap service must depend_on redis with condition: service_healthy"; fi
done

# --- outbound IPv6 stays off by default ---------------------------------------
for compose in "$root" "$vps"; do
	if grep -qF 'MTA_IPV6_ENABLED: ${MTA_IPV6_ENABLED:-false}' "$compose" \
		&& grep -Pzq 'default:\n(?: *#.*\n)* *enable_ipv6: \$\{MTA_IPV6_ENABLED:-false\}' "$compose"; then
		ok "$compose gates MTA config and bridge plumbing on the single MTA_IPV6_ENABLED flag"
	else bad "$compose must drive both MTA_IPV6_ENABLED and the default network's enable_ipv6 from \${MTA_IPV6_ENABLED:-false}"; fi
done

for envfile in .env.selfhost.example apps/mta/.env.example infra/templates/.env.vps.template; do
	pools_with_v6=$(grep -E '^IP_POOLS_(TRANSACTIONAL|CAMPAIGN)=.*:' "$envfile" || true)
	if grep -qE '^MTA_IPV6_ENABLED=false$' "$envfile" && [ -z "$pools_with_v6" ]; then
		ok "$envfile keeps the shipped install IPv4-only"
	else bad "$envfile must set MTA_IPV6_ENABLED=false and list no IPv6 addresses in IP_POOLS_*"; fi
done

# --- feature-flag registry vs the shipped templates ---------------------------
# Compose silently ignores unknown profile names, so registry/compose drift makes
# a toggle apply cleanly yet start nothing. The `mta` profile is added by the
# env-driven deliveryProvider rule in featureFlags.ts getActiveProfiles.
registry=$(bun -e '
import { FEATURE_FLAGS } from "./packages/shared/src/featureFlags";
const defs = Object.values(FEATURE_FLAGS);
const profiles = new Set(defs.flatMap((d) => d.dockerProfiles ?? []));
profiles.add("mta");
const envVars = new Set(defs.filter((d) => !d.hostedOnly).flatMap((d) => d.requiredEnvVars ?? []));
console.log(`profiles ${[...profiles].sort().join(" ")}`);
console.log(`envvars ${[...envVars].sort().join(" ")}`);
') || { bad "could not read the feature-flag registry"; registry=; }

if [ -n "$registry" ]; then
	activatable=$(awk '$1=="profiles"{$1="";print}' <<<"$registry")
	required_env=$(awk '$1=="envvars"{$1="";print}' <<<"$registry")

	for compose in "$root" "$vps"; do
		undeclared=
		for profile in $activatable; do
			grep -qE "^ +- $profile\$" "$compose" || undeclared="$undeclared $profile"
		done
		if [ -z "$undeclared" ]; then
			ok "$compose declares every profile the flag registry can activate"
		else bad "$compose is missing profiles the flag registry can activate:$undeclared"; fi
	done

	undocumented=
	for var in $required_env; do
		grep -qE "(^|[^A-Za-z0-9_])$var([^A-Za-z0-9_]|\$)" infra/templates/.env.vps.template \
			|| undocumented="$undocumented $var"
	done
	if [ -z "$undocumented" ]; then
		ok "infra/templates/.env.vps.template documents every non-hosted required env var"
	else bad "infra/templates/.env.vps.template is missing required env vars:$undocumented"; fi
fi

# --- the VPS compose file vs the env template that fills it -------------------
# The check above only covers variables the FEATURE-FLAG REGISTRY names. Nothing
# covered the variables the compose file itself interpolates, and two got in:
#
#   • MTA_SECRET (#317) was added to the root compose and not to the VPS pair,
#     so the VPS MTA crash-looped on its own boot assertion.
#   • FBL_DEDUP_PROTOCOL / FBL_DEDUP_CUTOVER_ACK reached the VPS compose but
#     never the template.
#
# The second kind is the expensive one. Compose resolves `${VAR:?}` across the
# WHOLE FILE before it dispatches the subcommand, so one missing name breaks
# `down`, `logs`, `ps` and `config` as surely as `up` — the operator cannot read
# the logs to find out what is wrong. The bare `${VAR}` form is checked too: it
# interpolates to an empty string, which is how the root compose shipped empty
# secrets until e12fbafc2.
#
# .env.vps.template is the only declaration of the fill contract that lives in
# this repo. The control plane substitutes {{PLACEHOLDER}} values into it, so a
# name missing from the template is a name the control plane never learns about.
# Variables it genuinely supplies from outside the file (release pins, not
# instance config) opt out by name via an `# owlat:external NAME` line, so that
# "supplied elsewhere" is a written-down claim rather than an absence.
vps_env=infra/templates/.env.vps.template

# Both interpolation forms, as written in the compose file.
vps_required=$(grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*:\?' "$vps" |
	sed -e 's/^[$][{]//' -e 's/:?$//' | sort -u)
vps_bare=$(grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*\}' "$vps" |
	sed -e 's/^[$][{]//' -e 's/[}]$//' | sort -u)

unfilled=
for var in $vps_required $vps_bare; do
	grep -qE "^$var=" "$vps_env" && continue
	grep -qE "^# owlat:external $var( |\$)" "$vps_env" && continue
	unfilled="$unfilled $var"
done
if [ -z "$unfilled" ]; then
	ok "$vps_env assigns or externally declares every variable $vps interpolates"
else bad "$vps interpolates variables $vps_env neither assigns nor declares \`# owlat:external\`:$unfilled — a \${VAR:?} among them aborts every compose subcommand, not just up"; fi

# An `# owlat:external` line is a claim about a variable that is still used; when
# the compose file stops interpolating one, the opt-out has to go with it.
# Space-joined so the `case` below matches on word boundaries: the extracted
# lists are newline-separated, and " $vps_required " would not pad the interior
# entries with the spaces the pattern looks for.
vps_interpolated=$(printf '%s\n%s\n' "$vps_required" "$vps_bare" | tr '\n' ' ')

stale_external=
for var in $(grep -oE '^# owlat:external [A-Za-z_][A-Za-z0-9_]*' "$vps_env" |
	sed 's/^# owlat:external //'); do
	case " $vps_interpolated " in
	*" $var "*) ;;
	*) stale_external="$stale_external $var" ;;
	esac
done
if [ -z "$stale_external" ]; then
	ok "$vps_env declares no \`# owlat:external\` variable $vps has stopped using"
else bad "$vps_env still declares \`# owlat:external\` for unused variables:$stale_external"; fi

exit $fail
