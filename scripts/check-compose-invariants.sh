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
#   • IPv6: the shipped install is IPv4-only behind one explicit flag.
#   • Feature-flag registry: every activatable docker profile exists in both
#     compose files and every required env var is in the VPS template.
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

# --- receiving profiles stay bootable -----------------------------------------
# An empty MAIL_SYNC_API_KEY default makes apps/mail-sync/src/config.ts throw on
# boot, and apps/imap/src/server.ts refuses to start in production without a TLS
# cert — both used to crash-loop the opt-in receiving stacks.
mail_sync=$(service_block "$root" mail-sync)
if grep -qE '^ {6}MAIL_SYNC_API_KEY: \$\{MAIL_SYNC_API_KEY\}$' <<<"$mail_sync" \
	&& grep -qE '^ {6}- external-mail$' <<<"$mail_sync"; then
	ok "$root runs mail-sync under external-mail with a defaultless MAIL_SYNC_API_KEY"
else bad "$root mail-sync must use MAIL_SYNC_API_KEY: \${MAIL_SYNC_API_KEY} (no :- default) under the external-mail profile"; fi

cert_init=$(service_block "$root" imap-cert-init)
imap_block=$(service_block "$root" imap)
if [ -n "$cert_init" ] && grep -qE '^ {6}- personal-mail$' <<<"$cert_init" \
	&& grep -Pzq 'imap-cert-init:\n {8}condition: service_completed_successfully\n' <<<"$imap_block"; then
	ok "$root provisions the IMAP TLS cert under personal-mail before the imap server starts"
else bad "$root needs an imap-cert-init service on the personal-mail profile that imap depends on with service_completed_successfully"; fi

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

exit $fail
