/**
 * The Docker API isolation half of scripts/check-compose-invariants.sh.
 *
 * docker-socket-proxy serves the Docker API unauthenticated, and the grants the
 * updater needs (CONTAINERS + POST) are enough to start a container with a host
 * bind mount. It must sit on the internal docker-proxy network with the updater
 * as its only neighbour. The VPS template had it on `default` with every other
 * service while the gate only looked at the root file (#1329), so each case
 * breaks one template in a copy and runs the real gate against it.
 *
 * The network is one route to the engine; the socket is the other. A service
 * with no network at all still drives the full API through a socket mount, and
 * `:ro` does not stop that, so only the proxy may reach it by any route (#1368).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..');
const SCRIPT = join(REPOSITORY_ROOT, 'scripts/check-compose-invariants.sh');

const TEMPLATES = [
	{ name: 'docker-compose.yml', env: 'COMPOSE_INVARIANTS_ROOT' },
	{ name: 'infra/templates/docker-compose.vps.yml', env: 'COMPOSE_INVARIANTS_VPS' },
] as const;

// One gate run is ~0.5s, but it forks a few hundred greps; leave headroom for a
// contended runner rather than flake at vitest's 5s default.
const GATE_TIMEOUT_MS = 30_000;

const sandboxes: string[] = [];

afterEach(() => {
	while (sandboxes.length > 0) {
		const dir = sandboxes.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

/** Replaces the single occurrence of `from`; a missing anchor fails loudly. */
function replaceOnce(source: string, from: string, to: string): string {
	expect(source.split(from), `anchor not found exactly once: ${JSON.stringify(from)}`).toHaveLength(
		2
	);
	return source.replace(from, to);
}

function runGate(env: string, compose: string): { status: number | null; stderr: string } {
	const dir = mkdtempSync(join(tmpdir(), 'owlat-compose-invariants-'));
	sandboxes.push(dir);
	const file = join(dir, 'docker-compose.yml');
	writeFileSync(file, compose);
	// A sync spawn blocks the event loop, so vitest's own timeout cannot stop a
	// hung gate; the spawn has to time out by itself.
	const result = spawnSync('bash', [SCRIPT], {
		encoding: 'utf8',
		env: { ...process.env, [env]: file },
		timeout: GATE_TIMEOUT_MS,
	});
	expect(result.error).toBeUndefined();
	return { status: result.status, stderr: result.stderr };
}

/** Adds a service, written as `body`, ahead of the updater. */
function addIntruder(body: string): (s: string) => string {
	return (s) =>
		replaceOnce(s, '\n  updater:\n', `\n  intruder:\n    image: alpine:3\n${body}\n  updater:\n`);
}

/** Gives an existing service an explicit `container_name`. */
function nameContainer(service: string, containerName: string): (s: string) => string {
	return (s) =>
		replaceOnce(s, `\n  ${service}:\n`, `\n  ${service}:\n    container_name: ${containerName}\n`);
}

/** Declares an extra top-level network next to docker-proxy. */
function addNetwork(body: string): (s: string) => string {
	return (s) =>
		replaceOnce(
			s,
			'  docker-proxy:\n    internal: true\n',
			`  docker-proxy:\n    internal: true\n${body}`
		);
}

/** Declares an extra top-level volume next to the shipped ones. */
function addVolume(body: string): (s: string) => string {
	return (s) => replaceOnce(s, '\nvolumes:\n', `\nvolumes:\n${body}`);
}

const both =
	(...steps: ((s: string) => string)[]) =>
	(s: string) =>
		steps.reduce((acc, step) => step(acc), s);

const NOT_ONLY_MEMBERS = 'docker-proxy network must hold exactly docker-socket-proxy and updater';
const SHARES_NAMESPACE = "joins a docker-proxy member's network namespace";
const ALIAS = 'can resolve to the same Docker network as docker-proxy';
const WITH_INTRUDER = `${NOT_ONLY_MEMBERS} (members: docker-socket-proxy, intruder, updater)`;

const MUTATIONS = [
	{
		breaks: 'the proxy also attached to default',
		apply: (s: string) =>
			replaceOnce(
				s,
				'      - docker-proxy\n    restart: unless-stopped',
				'      - default\n      - docker-proxy\n    restart: unless-stopped'
			),
		expected:
			'docker-socket-proxy must attach to docker-proxy only (attached: default, docker-proxy)',
	},
	{
		breaks: 'the proxy with no networks key (implicitly on default)',
		apply: (s: string) =>
			replaceOnce(
				s,
				'    networks:\n      - docker-proxy\n    restart: unless-stopped',
				'    restart: unless-stopped'
			),
		expected: 'docker-socket-proxy must attach to docker-proxy only (attached: default)',
	},
	{
		breaks: 'a published proxy port',
		apply: (s: string) =>
			replaceOnce(
				s,
				'    networks:\n      - docker-proxy\n    restart: unless-stopped',
				"    ports:\n      - '127.0.0.1:2375:2375'\n    networks:\n      - docker-proxy\n    restart: unless-stopped"
			),
		expected: 'docker-socket-proxy must publish no port',
	},
	{
		breaks: 'a docker-proxy network that is not internal',
		apply: (s: string) =>
			replaceOnce(
				s,
				'  docker-proxy:\n    internal: true\n',
				'  docker-proxy:\n    driver: bridge\n'
			),
		expected: 'must declare the docker-proxy network with internal: true',
	},
	{
		breaks: 'a third service on docker-proxy (block list)',
		apply: addIntruder('    networks:\n      - docker-proxy\n'),
		expected: `${NOT_ONLY_MEMBERS} (members: docker-socket-proxy, intruder, updater)`,
	},
	{
		breaks: 'a third service on docker-proxy (flow list)',
		apply: addIntruder('    networks: [default, docker-proxy]\n'),
		expected: `${NOT_ONLY_MEMBERS} (members: docker-socket-proxy, intruder, updater)`,
	},
	{
		breaks: 'a third service on docker-proxy (flow map)',
		apply: addIntruder('    networks: {docker-proxy: {}}\n'),
		expected: `${NOT_ONLY_MEMBERS} (members: docker-socket-proxy, intruder, updater)`,
	},
	{
		breaks: 'a third service on docker-proxy (block map)',
		apply: addIntruder('    networks:\n      docker-proxy:\n        aliases: [x]\n'),
		expected: `${NOT_ONLY_MEMBERS} (members: docker-socket-proxy, intruder, updater)`,
	},
	{
		breaks: 'a third service on docker-proxy (quoted name)',
		apply: addIntruder("    networks:\n      - 'docker-proxy'\n"),
		expected: `${NOT_ONLY_MEMBERS} (members: docker-socket-proxy, intruder, updater)`,
	},
	{
		breaks: 'a third service on docker-proxy (trailing comment)',
		apply: addIntruder('    networks:\n      - docker-proxy # temporary\n'),
		expected: `${NOT_ONLY_MEMBERS} (members: docker-socket-proxy, intruder, updater)`,
	},
	{
		breaks: "a service sharing the updater's namespace",
		apply: addIntruder('    network_mode: service:updater\n'),
		expected: `intruder ${SHARES_NAMESPACE} via network_mode: service:updater`,
	},
	{
		breaks: "a service sharing the proxy's namespace",
		apply: addIntruder("    network_mode: 'service:docker-socket-proxy'\n"),
		expected: `intruder ${SHARES_NAMESPACE} via network_mode: service:docker-socket-proxy`,
	},
	{
		breaks: "a service sharing the proxy container's namespace",
		apply: addIntruder('    network_mode: container:owlat-docker-socket-proxy-1\n'),
		expected: `intruder ${SHARES_NAMESPACE} via network_mode: container:owlat-docker-socket-proxy-1`,
	},
	{
		breaks: "a service sharing the proxy's custom-named container",
		apply: both(
			nameContainer('docker-socket-proxy', 'engine-api'),
			addIntruder('    network_mode: container:engine-api\n')
		),
		expected: `intruder ${SHARES_NAMESPACE} via network_mode: container:engine-api`,
	},
	{
		breaks: "a service sharing the updater's custom-named container",
		apply: both(
			nameContainer('updater', 'self-update'),
			addIntruder('    network_mode: container:self-update\n')
		),
		expected: `intruder ${SHARES_NAMESPACE} via network_mode: container:self-update`,
	},
	{
		breaks: 'an external network named like the project-scoped docker-proxy',
		apply: both(
			addNetwork('  sidedoor:\n    external: true\n    name: owlat_docker-proxy\n'),
			addIntruder('    networks:\n      - sidedoor\n')
		),
		expected: WITH_INTRUDER,
	},
	{
		breaks: 'a second network key with the same name',
		apply: both(
			addNetwork('  sidedoor:\n    name: owlat_docker-proxy\n'),
			addIntruder('    networks: [sidedoor]\n')
		),
		expected: `network sidedoor ${ALIAS} (name owlat_docker-proxy vs the project-scoped name <project>_docker-proxy)`,
	},
	{
		breaks: 'a network using the legacy external-name form',
		apply: both(
			addNetwork('  sidedoor:\n    external:\n      name: owlat_docker-proxy\n'),
			addIntruder('    networks: [sidedoor]\n')
		),
		expected: WITH_INTRUDER,
	},
	{
		breaks: 'an external network whose key is the project-scoped name',
		apply: both(
			addNetwork('  owlat_docker-proxy:\n    external: true\n'),
			addIntruder("    networks: ['owlat_docker-proxy']\n")
		),
		expected: WITH_INTRUDER,
	},
	{
		breaks: 'the default network renamed onto docker-proxy',
		apply: (s: string) =>
			replaceOnce(s, '\n  default:\n', '\n  default:\n    name: owlat_docker-proxy\n'),
		expected: `network default ${ALIAS}`,
	},
	{
		breaks: 'docker-proxy renamed onto the default network',
		apply: (s: string) =>
			replaceOnce(
				s,
				'  docker-proxy:\n    internal: true\n',
				'  docker-proxy:\n    name: owlat_default\n    internal: true\n'
			),
		expected: `network default ${ALIAS}`,
	},
	{
		breaks: 'a docker-proxy name chosen by interpolation',
		apply: (s: string) =>
			replaceOnce(
				s,
				'  docker-proxy:\n    internal: true\n',
				'  docker-proxy:\n    name: ${PROXY_NET:-owlat_docker-proxy}\n    internal: true\n'
			),
		expected: 'docker-proxy network must not take its name from interpolation',
	},
	{
		// -p and COMPOSE_PROJECT_NAME override a top-level name, so it pins nothing.
		breaks: 'a network named for another project despite a literal project name',
		apply: both(
			(s: string) => `name: owlat\n${s}`,
			addNetwork('  metrics:\n    name: metrics_docker-proxy\n')
		),
		expected: `network metrics ${ALIAS}`,
	},
	{
		breaks: 'an interpolated network attachment (list)',
		apply: addIntruder("    networks: ['${INTRUDER_NETWORK:-docker-proxy}']\n"),
		expected:
			'intruder networks must not use interpolation (found ${INTRUDER_NETWORK:-docker-proxy})',
	},
	{
		breaks: 'an interpolated network attachment (map key)',
		apply: addIntruder("    networks:\n      '${INTRUDER_NETWORK:-docker-proxy}': {}\n"),
		expected:
			'intruder networks must not use interpolation (found ${INTRUDER_NETWORK:-docker-proxy})',
	},
	{
		breaks: 'an interpolated network_mode',
		apply: addIntruder('    network_mode: ${INTRUDER_MODE:-service:updater}\n'),
		expected:
			'intruder network_mode must be a literal value (found ${INTRUDER_MODE:-service:updater})',
	},
	{
		breaks: 'an interpolated container: target',
		apply: addIntruder('    network_mode: container:${PROXY_CONTAINER}\n'),
		expected: 'intruder network_mode must be a literal value (found container:${PROXY_CONTAINER})',
	},
	{
		breaks: 'an interpolated proxy container_name',
		apply: both(
			nameContainer('docker-socket-proxy', '${PROXY_CONTAINER:-engine-api}'),
			addIntruder('    network_mode: service:web\n')
		),
		expected:
			'docker-socket-proxy container_name must not use interpolation (found ${PROXY_CONTAINER:-engine-api})',
	},
	{
		breaks: 'an interpolated updater container_name',
		apply: nameContainer('updater', '${UPDATER_CONTAINER:-self-update}'),
		expected:
			'updater container_name must not use interpolation (found ${UPDATER_CONTAINER:-self-update})',
	},
	{
		breaks: 'another network named by interpolation',
		apply: both(
			addNetwork('  sidedoor:\n    name: ${SIDEDOOR:-owlat_docker-proxy}\n'),
			addIntruder('    networks: [sidedoor]\n')
		),
		expected: 'sidedoor network must not take its name from interpolation',
	},
	{
		breaks: 'a member on a network named by interpolation',
		apply: both(
			addNetwork('  sidedoor:\n    name: ${SIDEDOOR:-owlat_docker-proxy}\n'),
			addIntruder('    networks: [sidedoor]\n')
		),
		expected: WITH_INTRUDER,
	},
	{
		breaks: 'a service extending the proxy',
		apply: addIntruder('    extends:\n      service: docker-socket-proxy\n'),
		expected: 'intruder must not use extends (the gate cannot see the merged definition)',
	},
	{
		breaks: 'a service extending another file',
		apply: addIntruder('    extends:\n      file: other.yml\n      service: web\n'),
		expected: 'intruder must not use extends',
	},
	{
		breaks: 'an include of another compose file',
		apply: (s: string) => `include:\n  - other.yml\n${s}`,
		expected: 'must not use include (the gate only sees this file)',
	},
	{
		breaks: 'any service on the host network',
		apply: addIntruder('    network_mode: host\n'),
		expected:
			'intruder must not use network_mode: host (it reaches internal-network container IPs)',
	},
	{
		breaks: 'a container: target the gate cannot resolve',
		apply: addIntruder('    network_mode: container:3f2a9c1d\n'),
		expected:
			'intruder network_mode: container:3f2a9c1d names a container the gate cannot resolve; use service:<name>',
	},
	{
		breaks: "a service reaching the updater's namespace through another service",
		apply: addIntruder(
			'    network_mode: service:hop\n\n  hop:\n    image: alpine:3\n    network_mode: service:updater\n'
		),
		expected: `intruder ${SHARES_NAMESPACE} via network_mode: service:hop`,
	},
	{
		breaks: 'an unsupported network_mode',
		apply: addIntruder('    network_mode: ns:/proc/1/ns/net\n'),
		expected: 'intruder uses unsupported network_mode: ns:/proc/1/ns/net',
	},
	{
		breaks: 'the proxy on the host network',
		apply: (s: string) =>
			replaceOnce(
				s,
				'    networks:\n      - docker-proxy\n    restart: unless-stopped',
				'    network_mode: host\n    restart: unless-stopped'
			),
		expected: 'docker-socket-proxy must not set network_mode (found host)',
	},
] as const;

const GIVES_SOCKET = 'gives the Docker socket away';
const ONLY_PROXY = 'only docker-socket-proxy may reach the Docker engine';
const UNRESOLVED_SOURCE = 'takes its source from interpolation the gate cannot resolve';

/** An intruder with no network at all, so only the socket can reach the engine. */
const offline = (body: string) => addIntruder(`    network_mode: none\n${body}`);

const SOCKET_MUTATIONS = [
	{
		breaks: 'a direct socket bind (short syntax)',
		apply: offline('    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n'),
		expected: `intruder volume "/var/run/docker.sock:/var/run/docker.sock" ${GIVES_SOCKET} (/var/run/docker.sock); ${ONLY_PROXY}`,
	},
	{
		breaks: 'a read-only socket bind at another target (short syntax)',
		apply: offline("    volumes: ['/var/run/docker.sock:/tmp/engine.sock:ro']\n"),
		expected: `intruder volume "/var/run/docker.sock:/tmp/engine.sock:ro" ${GIVES_SOCKET}`,
	},
	{
		breaks: 'a read-only socket bind (long syntax)',
		apply: offline(
			'    volumes:\n      - type: bind\n        source: /run/docker.sock\n        target: /engine.sock\n        read_only: true\n'
		),
		expected: `${GIVES_SOCKET} (/run/docker.sock)`,
	},
	{
		breaks: 'a bind of the directory holding the socket',
		apply: offline('    volumes:\n      - /var/run/:/host-run:ro\n'),
		expected: `intruder volume "/var/run/:/host-run:ro" ${GIVES_SOCKET} (/var/run/)`,
	},
	{
		breaks: 'a bind of the host root',
		apply: offline('    volumes:\n      - type: bind\n        source: /\n        target: /host\n'),
		expected: `${GIVES_SOCKET} (/)`,
	},
	{
		breaks: 'a socket path from an interpolation default',
		apply: offline('    volumes:\n      - ${ENGINE_SOCKET:-/var/run/docker.sock}:/engine.sock\n'),
		expected: `${GIVES_SOCKET} (/var/run/docker.sock)`,
	},
	{
		breaks: 'a bind source from a variable with no default',
		apply: offline('    volumes:\n      - ${ENGINE_SOCKET}:/engine.sock\n'),
		expected: `intruder volume "\${ENGINE_SOCKET}:/engine.sock" ${UNRESOLVED_SOURCE} (\${ENGINE_SOCKET}:/engine.sock)`,
	},
	{
		breaks: 'a whole mount from a variable with no default',
		apply: offline('    volumes:\n      - ${ENGINE_MOUNT}\n'),
		expected: `intruder volume "\${ENGINE_MOUNT}" ${UNRESOLVED_SOURCE} (\${ENGINE_MOUNT})`,
	},
	{
		breaks: 'a socket bind whose type comes from an interpolation default',
		apply: offline(
			'    volumes:\n      - type: ${MOUNT_TYPE:-bind}\n        source: /var/run/docker.sock\n        target: /engine.sock\n'
		),
		expected: `${GIVES_SOCKET} (/var/run/docker.sock)`,
	},
	{
		breaks: 'a named pipe whose type comes from an interpolation default',
		apply: offline(
			'    volumes:\n      - type: ${MOUNT_TYPE:-npipe}\n        source: \\\\.\\pipe\\docker_engine\n        target: \\\\.\\pipe\\docker_engine\n'
		),
		expected: `is a named pipe, the Docker engine's transport on Windows; ${ONLY_PROXY}`,
	},
	{
		breaks: 'an external volume whose mount type comes from an interpolation default',
		apply: both(
			addVolume('  engine-run:\n    external: true\n'),
			offline(
				'    volumes:\n      - type: ${MOUNT_TYPE:-volume}\n        source: engine-run\n        target: /x\n'
			)
		),
		expected: 'uses external volume engine-run, which the gate cannot see into',
	},
	{
		breaks: 'a mount type with no default',
		apply: offline(
			'    volumes:\n      - type: ${MOUNT_TYPE}\n        source: /var/run/docker.sock\n        target: /engine.sock\n'
		),
		expected: 'has a mount type the gate cannot resolve (${MOUNT_TYPE})',
	},
	{
		breaks: 'a mount type the gate does not know',
		apply: offline(
			'    volumes:\n      - type: ${MOUNT_TYPE:-Bind}\n        source: /var/run/docker.sock\n        target: /engine.sock\n'
		),
		expected: 'has a mount type the gate does not know (${MOUNT_TYPE:-Bind})',
	},
	{
		breaks: 'a relative bind that climbs out of the project directory',
		apply: offline('    volumes:\n      - ./../../../../var/run:/host-run\n'),
		expected: 'climbs out of the project directory (./../../../../var/run)',
	},
	{
		breaks: 'a named volume backed by the socket directory',
		apply: both(
			addVolume(
				'  engine-run:\n    driver_opts:\n      type: none\n      o: bind\n      device: /var/run\n'
			),
			offline('    volumes:\n      - engine-run:/host-run\n')
		),
		expected: `intruder volume "engine-run:/host-run" uses volume engine-run, whose device ${GIVES_SOCKET} (/var/run)`,
	},
	{
		breaks: 'an external named volume',
		apply: both(
			addVolume('  engine-run:\n    external: true\n'),
			offline(
				'    volumes:\n      - type: volume\n        source: engine-run\n        target: /x\n'
			)
		),
		expected: 'uses external volume engine-run, which the gate cannot see into',
	},
	{
		breaks: 'a named-pipe mount',
		apply: offline(
			'    volumes:\n      - type: npipe\n        source: \\\\.\\pipe\\docker_engine\n        target: \\\\.\\pipe\\docker_engine\n'
		),
		expected: `is a named pipe, the Docker engine's transport on Windows; ${ONLY_PROXY}`,
	},
	{
		breaks: 'a secret read from the socket',
		apply: both(
			(s: string) => `secrets:\n  engine:\n    file: /var/run/docker.sock\n${s}`,
			offline('    secrets: [engine]\n')
		),
		expected: `secret engine file ${GIVES_SOCKET} (/var/run/docker.sock)`,
	},
	{
		breaks: 'volumes_from the proxy, read-only',
		apply: offline('    volumes_from: [docker-socket-proxy:ro]\n'),
		expected: `intruder inherits Docker socket access from docker-socket-proxy via volumes_from (${ONLY_PROXY})`,
	},
	{
		breaks: 'volumes_from the proxy through another service',
		apply: offline(
			'    volumes_from:\n      - hop\n\n  hop:\n    image: alpine:3\n    network_mode: none\n    volumes_from: [docker-socket-proxy]\n'
		),
		expected: 'intruder inherits Docker socket access from hop via volumes_from',
	},
	{
		breaks: 'volumes_from a container',
		apply: offline('    volumes_from: ["container:owlat-docker-socket-proxy-1"]\n'),
		expected:
			'intruder volumes_from container:owlat-docker-socket-proxy-1 names a container the gate cannot resolve; use a service name',
	},
	{
		breaks: 'use_api_socket',
		apply: offline('    use_api_socket: true\n'),
		expected: `intruder must not set use_api_socket (${ONLY_PROXY})`,
	},
	{
		breaks: 'the updater mounting the socket',
		apply: (s: string) =>
			replaceOnce(s, '\n  updater:\n', '\n  updater:\n    volumes_from: [docker-socket-proxy]\n'),
		expected: 'updater inherits Docker socket access from docker-socket-proxy via volumes_from',
	},
	{
		breaks: 'an unknown top-level key',
		apply: (s: string) => `unknown_policy: true\n${s}`,
		expected: 'has unknown top-level key unknown_policy (not in the Compose specification)',
	},
	{
		breaks: 'an unknown service key',
		apply: offline('    docker_socket: /var/run/docker.sock\n'),
		expected: 'intruder has unknown service key docker_socket (not in the Compose specification)',
	},
] as const;

describe.each(TEMPLATES)('$name keeps the Docker API off the app network', ({ name, env }) => {
	const original = readFileSync(join(REPOSITORY_ROOT, name), 'utf8');

	it(
		'passes the gate as checked in',
		() => {
			const result = runGate(env, original);
			expect(result.stderr).toBe('');
			expect(result.status).toBe(0);
		},
		GATE_TIMEOUT_MS
	);

	it(
		'accepts the network modes that stay off docker-proxy',
		() => {
			const result = runGate(
				env,
				addIntruder(
					'    network_mode: service:web\n\n  isolated:\n    image: alpine:3\n    network_mode: none\n'
				)(original)
			);
			expect(result.stderr).toBe('');
			expect(result.status).toBe(0);
		},
		GATE_TIMEOUT_MS
	);

	it(
		'accepts mounts that stay off the socket, and extension keys',
		() => {
			const result = runGate(
				env,
				both(
					(s: string) => `x-policy:\n  note: extension keys are free-form\n${s}`,
					offline(
						[
							'    x-owner: ops',
							'    volumes:',
							'      - /cache',
							'      - ./data:/data',
							'      - ${OWLAT_DATA_DIR:-./data}:/srv/data:ro',
							'      - /var/lib/owlat:/var/lib/owlat:ro',
							'      - /run/owlat:/run/owlat',
							'      - type: tmpfs',
							'        target: /tmp',
							'      - type: ${SCRATCH_MOUNT_TYPE:-tmpfs}',
							'        target: /scratch',
							'    volumes_from: [web:ro]',
							'    use_api_socket: false',
							'',
						].join('\n')
					)
				)(original)
			);
			expect(result.stderr).toBe('');
			expect(result.status).toBe(0);
		},
		GATE_TIMEOUT_MS
	);

	it.each([...MUTATIONS, ...SOCKET_MUTATIONS])(
		'rejects $breaks',
		({ apply, expected }) => {
			const result = runGate(env, apply(original));
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(expected);
		},
		GATE_TIMEOUT_MS
	);
});
