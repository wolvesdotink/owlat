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
#   DIND_NAME      Name of the container; its image store is the volume
#                  `<name>-docker`. Both are removed on exit, by that name.
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
NAME="${DIND_NAME:-owlat-update-flow-$SCENARIO-$$}"
[[ "$NAME" =~ ^[a-z0-9][a-z0-9_.-]*$ ]] || {
	echo "DIND_NAME must be a plain container name, not '$NAME'" >&2
	exit 2
}
# The daemon's API must still accept the docker CLI that older releases'
# updaters ship, which rules out a daemon that raised its minimum API version.
DIND_IMAGE='docker:28-dind@sha256:2a232a42256f70d78e3cc5d2b5d6b3276710a0de0596c145f627ecfae90282ac'

cleanup() {
	local status=$?
	if [[ "${KEEP:-0}" == "1" ]]; then
		echo "Left running: docker exec -it $NAME sh (remove: docker rm -f -v $NAME; docker volume rm $NAME-docker)"
	else
		docker rm -f -v "$NAME" >/dev/null 2>&1 || true
		docker volume rm "$NAME-docker" >/dev/null 2>&1 || true
	fi
	exit $status
}
trap cleanup EXIT

run_args=(--detach --privileged --name "$NAME" -e DOCKER_TLS_CERTDIR=
	-v "$NAME-docker:/var/lib/docker" -v "$ROOT:/src:ro")
flow_env=(-e "SCENARIO=$SCENARIO" -e "STRICT=${STRICT:-0}" -e "KEEP=${KEEP:-0}"
	-e "OWLAT_REPO=${OWLAT_REPO:-wolvesdotink/owlat}" -e WORK_DIR=/work)
if [[ -n "${TEMPLATE_DIR:-}" ]]; then
	run_args+=(-v "$(cd "$TEMPLATE_DIR" && pwd):/templates:ro")
	flow_env+=(-e TEMPLATE_DIR=/templates)
fi
if [[ -n "${DIND_MEMORY:-}" ]]; then run_args+=(--memory "$DIND_MEMORY"); fi

docker volume create "$NAME-docker" >/dev/null
docker run "${run_args[@]}" "$DIND_IMAGE" >/dev/null

# Bounded: a daemon that has not answered within two minutes, or whose
# container already exited, is not going to.
ready=0
for _ in $(seq 1 60); do
	if docker exec "$NAME" docker info >/dev/null 2>&1; then
		ready=1
		break
	fi
	[[ "$(docker inspect --format '{{.State.Running}}' "$NAME" 2>/dev/null)" == true ]] || break
	sleep 2
done
if [[ $ready -ne 1 ]]; then
	docker logs --tail 50 "$NAME" >&2 || true
	echo "the dedicated Docker daemon never came up" >&2
	exit 1
fi
echo "Docker daemon $NAME is up: $(docker exec "$NAME" docker version --format '{{.Server.Version}}')"

docker exec "$NAME" apk add --no-cache bash curl jq openssl >/dev/null

if [[ "${BUILD_UPDATER:-0}" == "1" ]]; then
	sha="${OWLAT_GIT_SHA:-$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)}"
	image="ghcr.io/wolvesdotink/updater:ci-$sha"
	docker exec "$NAME" docker build -f /src/apps/updater/Dockerfile \
		--build-arg "OWLAT_VERSION=${TO#v}" --build-arg "OWLAT_GIT_SHA=$sha" -t "$image" /src
	flow_env+=(-e "UPDATER_IMAGE=$image")
elif [[ -n "${UPDATER_IMAGE:-}" ]]; then
	flow_env+=(-e "UPDATER_IMAGE=$UPDATER_IMAGE")
fi

docker exec "${flow_env[@]}" "$NAME" bash /src/scripts/e2e-update-flow.sh "$FROM" "$TO"
