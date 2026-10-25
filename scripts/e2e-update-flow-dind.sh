#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# e2e-update-flow-dind.sh — Run e2e-update-flow.sh against a Docker daemon of
# its own.
#
# The update flow must never drive the host's daemon: it names its compose
# project `owlat`, takes it down with its volumes, and the updater it runs
# prunes images whoever pulled them. So this starts a privileged docker:dind
# container with its own image store (a named volume) and runs the whole
# harness INSIDE that container. Pointing DOCKER_HOST at the daemon would not
# be enough: the install's bind mounts name paths the daemon resolves on its
# own filesystem, and the stack publishes its ports in its own network
# namespace, so the files and `localhost` the harness uses have to be that
# container's. The host's Docker socket is never mounted into it.
#
# Usage:
#   bash scripts/e2e-update-flow-dind.sh <from-version> <to-version>
#
# Environment:
#   SCENARIO, STRICT, OWLAT_REPO
#                  Passed to e2e-update-flow.sh (see its header).
#   TEMPLATE_DIR   A host directory with TO's template and checksum, mounted
#                  read-only and passed on.
#   BUILD_UPDATER=1
#                  Build apps/updater from this checkout inside the daemon and
#                  run it as the updater under test (a pull request's updater).
#   UPDATER_IMAGE  Otherwise, a registry image to run as the updater under test.
#   DIND_NAME      Prefix of the container's name (default
#                  owlat-update-flow-<scenario>). A random suffix makes the
#                  name this run's own; its image store is the volume
#                  `<name>-docker`.
#   DIND_MEMORY    Memory limit for the container (docker run --memory).
#   KEEP=1         Leave the container and the stack in it running.
#
# Needs docker on the host, and nothing else there.
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

FROM="${1:-}"
TO="${2:-}"
if [[ -z "$FROM" || -z "$TO" ]]; then
	echo "Usage: $0 <from-version> <to-version>" >&2
	exit 2
fi
SCENARIO="${SCENARIO:-success}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${DIND_NAME:-owlat-update-flow-$SCENARIO}"
[[ "$PREFIX" =~ ^[a-z0-9][a-z0-9_.-]*$ ]] || {
	echo "DIND_NAME must be a plain container name, not '$PREFIX'" >&2
	exit 2
}
# Every input is checked before anything is created, so a bad one leaves
# nothing behind and touches nothing.
template_mount=''
if [[ -n "${TEMPLATE_DIR:-}" ]]; then
	template_mount="$(cd "$TEMPLATE_DIR" && pwd)" || {
		echo "TEMPLATE_DIR '$TEMPLATE_DIR' is not a directory" >&2
		exit 2
	}
fi
# The daemon's API must still accept the docker CLI that older releases'
# updaters ship, which rules out a daemon that raised its minimum API version.
DIND_IMAGE='docker:28-dind@sha256:2a232a42256f70d78e3cc5d2b5d6b3276710a0de0596c145f627ecfae90282ac'

# Another run, or a kept daemon, may share this host and even this prefix.
# Cleanup must only ever remove what this run created, so both resources
# carry an owner label with a token no other run knows, and the cleanup
# removes only what carries it: a name collision, a reused volume or a
# container that failed to start can never take someone else's with it.
TOKEN="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
[[ "$TOKEN" =~ ^[0-9a-f]{16}$ ]] || {
	echo "could not draw a random owner token" >&2
	exit 1
}
OWNER_LABEL="owlat.update-flow.owner=$TOKEN"
NAME="$PREFIX-${TOKEN:0:12}"
VOLUME="$NAME-docker"

owned_containers() { docker ps -aq --filter "label=$OWNER_LABEL"; }
owned_volumes() { docker volume ls -q --filter "label=$OWNER_LABEL"; }

cleanup() {
	local status=$?
	local ids volumes
	ids="$(owned_containers 2>/dev/null || true)"
	volumes="$(owned_volumes 2>/dev/null || true)"
	if [[ "${KEEP:-0}" == "1" ]]; then
		if [[ -n "$ids$volumes" ]]; then
			echo "Left running: docker exec -it $NAME sh (remove: docker rm -f -v $NAME; docker volume rm $VOLUME)"
		fi
	else
		# shellcheck disable=SC2086 # one ID or volume name per word
		if [[ -n "$ids" ]]; then docker rm -f -v $ids >/dev/null 2>&1 || true; fi
		# shellcheck disable=SC2086
		if [[ -n "$volumes" ]]; then docker volume rm $volumes >/dev/null 2>&1 || true; fi
	fi
	exit $status
}
trap cleanup EXIT

if docker container inspect "$NAME" >/dev/null 2>&1 || docker volume inspect "$VOLUME" >/dev/null 2>&1; then
	echo "$NAME or $VOLUME already exists; refusing to use or remove another run's daemon" >&2
	exit 1
fi

run_args=(--detach --privileged --name "$NAME" --label "$OWNER_LABEL" -e DOCKER_TLS_CERTDIR=
	-v "$VOLUME:/var/lib/docker" -v "$ROOT:/src:ro")
flow_env=(-e "SCENARIO=$SCENARIO" -e "STRICT=${STRICT:-0}" -e "KEEP=${KEEP:-0}"
	-e "OWLAT_REPO=${OWLAT_REPO:-wolvesdotink/owlat}" -e WORK_DIR=/work)
if [[ -n "$template_mount" ]]; then
	run_args+=(-v "$template_mount:/templates:ro")
	flow_env+=(-e TEMPLATE_DIR=/templates)
fi
if [[ -n "${DIND_MEMORY:-}" ]]; then run_args+=(--memory "$DIND_MEMORY"); fi

# `docker volume create` hands back an existing volume of the same name
# instead of failing, so the label is what proves the volume is new.
docker volume create --label "$OWNER_LABEL" "$VOLUME" >/dev/null
owner="$(docker volume inspect --format '{{index .Labels "owlat.update-flow.owner"}}' "$VOLUME")"
if [[ "$owner" != "$TOKEN" ]]; then
	echo "$VOLUME was created by another run; refusing to use it" >&2
	exit 1
fi
CID="$(docker run "${run_args[@]}" "$DIND_IMAGE")"

# Bounded: a daemon that has not answered within two minutes, or whose
# container already exited, is not going to.
ready=0
for _ in $(seq 1 60); do
	if docker exec "$CID" docker info >/dev/null 2>&1; then
		ready=1
		break
	fi
	[[ "$(docker inspect --format '{{.State.Running}}' "$CID" 2>/dev/null)" == true ]] || break
	sleep 2
done
if [[ $ready -ne 1 ]]; then
	docker logs --tail 50 "$CID" >&2 || true
	echo "the dedicated Docker daemon never came up" >&2
	exit 1
fi
echo "Docker daemon $NAME is up: $(docker exec "$CID" docker version --format '{{.Server.Version}}')"

docker exec "$CID" apk add --no-cache bash curl jq openssl >/dev/null

if [[ "${BUILD_UPDATER:-0}" == "1" ]]; then
	sha="${OWLAT_GIT_SHA:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)}"
	image="ghcr.io/wolvesdotink/updater:ci-$sha"
	docker exec "$CID" docker build -f /src/apps/updater/Dockerfile \
		--build-arg "OWLAT_VERSION=${TO#v}" --build-arg "OWLAT_GIT_SHA=$sha" -t "$image" /src
	flow_env+=(-e "UPDATER_IMAGE=$image")
elif [[ -n "${UPDATER_IMAGE:-}" ]]; then
	flow_env+=(-e "UPDATER_IMAGE=$UPDATER_IMAGE")
fi

docker exec "${flow_env[@]}" "$CID" bash /src/scripts/e2e-update-flow.sh "$FROM" "$TO"
