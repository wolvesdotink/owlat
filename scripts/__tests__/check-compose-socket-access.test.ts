/**
 * The Docker socket half of the compose gate (#1368).
 *
 * Keeping docker-socket-proxy on the internal docker-proxy network (see
 * check-compose-invariants.test.ts) only helps if the proxy is the one way to
 * the engine. A service with no network at all still drives the full API
 * through a socket mount, and `:ro` does not stop that, so only the proxy may
 * reach the socket by any route. Most cases give an offline service one such
 * route in a copy of a shipped template and run the real gate against it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
	TEMPLATES,
	addIntruder,
	addVolume,
	both,
	readTemplate,
	removeSandboxes,
	replaceOnce,
	runGate,
} from './composeGate.testlib';

afterEach(removeSandboxes);

const GIVES_SOCKET = 'gives the Docker socket away';
const ONLY_PROXY = 'only docker-socket-proxy may reach the Docker engine';
const UNRESOLVED_SOURCE = 'takes its source from interpolation the gate cannot resolve';
const THROUGH_PROCFS = 'goes through procfs';
const CLIMBS = 'has a .. segment';

/** An intruder with no network at all, so only the socket can reach the engine. */
const offline = (body: string) => addIntruder(`    network_mode: none\n${body}`);

/** Adds a mount to docker-socket-proxy, next to its socket bind. */
const proxyMount = (mount: string) => (s: string) =>
	replaceOnce(
		s,
		'      - /var/run/docker.sock:/var/run/docker.sock:ro\n',
		`      - /var/run/docker.sock:/var/run/docker.sock:ro\n      - ${mount}\n`
	);

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
		expected: `${CLIMBS} (./../../../../var/run)`,
	},
	{
		// The kernel follows /var/run to /run before it climbs, so this is /proc;
		// a lexical reading lands on /var/proc/1/root/run.
		breaks: 'a bind that climbs out of a link into procfs',
		apply: offline('    volumes:\n      - /var/run/../proc/1/root/run:/host-run:ro\n'),
		expected: `intruder volume "/var/run/../proc/1/root/run:/host-run:ro" ${CLIMBS} (/var/run/../proc/1/root/run)`,
	},
	{
		breaks: 'a named volume whose device climbs out of a link',
		apply: both(
			addVolume(
				'  engine-run:\n    driver_opts:\n      type: none\n      o: bind\n      device: /var/run/../proc/1/root/run\n'
			),
			offline('    volumes:\n      - engine-run:/host-run\n')
		),
		expected: `uses volume engine-run, whose device ${CLIMBS} (/var/run/../proc/1/root/run)`,
	},
	{
		breaks: 'a config file that climbs out of a link',
		apply: both(
			(s: string) =>
				`configs:\n  engine:\n    file: /var/run/../proc/self/root/run/docker.sock\n${s}`,
			offline('    configs: [engine]\n')
		),
		expected: `config engine file ${CLIMBS} (/var/run/../proc/self/root/run/docker.sock)`,
	},
	{
		breaks: "a bind of the socket directory through init's procfs root",
		apply: offline('    volumes:\n      - /proc/1/root/run:/host-run:ro\n'),
		expected: `intruder volume "/proc/1/root/run:/host-run:ro" ${THROUGH_PROCFS} (/proc/1/root/run)`,
	},
	{
		breaks: 'a bind of the host root through procfs (long syntax)',
		apply: offline(
			'    volumes:\n      - type: bind\n        source: /proc/self/root/\n        target: /host\n'
		),
		expected: `${THROUGH_PROCFS} (/proc/self/root/)`,
	},
	{
		breaks: 'a bind through a /dev link into procfs',
		apply: offline('    volumes:\n      - /dev/fd/3:/held-dir\n'),
		expected: `${THROUGH_PROCFS} (/dev/fd/3)`,
	},
	{
		breaks: 'a named volume backed by a procfs path',
		apply: both(
			addVolume(
				'  engine-run:\n    driver_opts:\n      type: none\n      o: bind\n      device: /proc/1/root/var/run\n'
			),
			offline('    volumes:\n      - engine-run:/host-run\n')
		),
		expected: `uses volume engine-run, whose device ${THROUGH_PROCFS} (/proc/1/root/var/run)`,
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
		// Sol r4: one Docker volume behind two keys. The proxy mounts the
		// socket-backed key, the intruder the plain one.
		breaks: 'a volume that shares its explicit name with a socket-backed one',
		apply: both(
			addVolume(
				'  proxy-run:\n    name: shared-engine-run\n    driver_opts:\n      type: none\n      o: bind\n      device: /var/run\n  alias-run:\n    name: shared-engine-run\n'
			),
			proxyMount('proxy-run:/host-run:ro'),
			offline('    volumes:\n      - alias-run:/host-run\n')
		),
		expected: `intruder volume "alias-run:/host-run" uses volume alias-run, which is the same Docker volume as proxy-run (shared-engine-run), so it also uses volume proxy-run, whose device ${GIVES_SOCKET} (/var/run)`,
	},
	{
		breaks: 'a volume named after the project-prefixed name of a socket-backed one',
		apply: both(
			addVolume(
				'  proxy-run:\n    driver_opts:\n      type: none\n      o: bind\n      device: /var/run\n  alias-run:\n    name: ${ALIAS_VOLUME:-owlat_proxy-run}\n'
			),
			offline(
				'    volumes:\n      - type: volume\n        source: alias-run\n        target: /host-run\n'
			)
		),
		expected:
			'uses volume alias-run, which may be the same Docker volume as proxy-run (owlat_proxy-run and <project>_proxy-run), so it also uses volume proxy-run',
	},
	{
		breaks: 'a volume whose name the gate cannot resolve, next to a socket-backed one',
		apply: both(
			addVolume(
				'  proxy-run:\n    name: shared-engine-run\n    driver_opts:\n      type: none\n      o: bind\n      device: /run\n  alias-run:\n    name: ${ENGINE_VOLUME}\n'
			),
			offline('    volumes:\n      - alias-run:/host-run\n')
		),
		expected:
			'uses volume alias-run, which may be the same Docker volume as proxy-run (${ENGINE_VOLUME} and shared-engine-run), so it also uses volume proxy-run',
	},
	{
		// An external volume without `name` is the Docker volume named like its key.
		breaks: 'a volume named like an external one',
		apply: both(
			addVolume('  host-engine:\n    external: true\n  alias-run:\n    name: host-engine\n'),
			offline('    volumes:\n      - alias-run:/host-run\n')
		),
		expected:
			'uses volume alias-run, which is the same Docker volume as host-engine (host-engine), so it also uses external volume host-engine, which the gate cannot see into',
	},
	{
		// Sol r5: the legacy `external: {name: X}` names the Docker volume like `name`.
		breaks: 'a volume named like a legacy external.name',
		apply: both(
			addVolume(
				'  host-engine:\n    external:\n      name: shared-engine-run\n  alias-run:\n    name: shared-engine-run\n'
			),
			offline('    volumes:\n      - alias-run:/host-run\n')
		),
		expected:
			'uses volume alias-run, which is the same Docker volume as host-engine (shared-engine-run), so it also uses external volume host-engine, which the gate cannot see into',
	},
	{
		breaks: 'a volume whose project-prefixed name a legacy external.name takes',
		apply: both(
			addVolume(
				'  host-engine:\n    external:\n      name: ${ENGINE_VOLUME:-owlat_alias-run}\n  alias-run: {}\n'
			),
			offline('    volumes:\n      - alias-run:/host-run\n')
		),
		expected:
			'uses volume alias-run, which may be the same Docker volume as host-engine (<project>_alias-run and owlat_alias-run), so it also uses external volume host-engine',
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

describe.each(TEMPLATES)('$name keeps the Docker socket to the proxy', ({ name, env }) => {
	const original = readTemplate(name);

	it('accepts mounts that stay off the socket, and extension keys', () => {
		const result = runGate(
			env,
			both(
				(s: string) => `x-policy:\n  note: extension keys are free-form\n${s}`,
				// Named volumes that cannot alias each other or a socket-backed one.
				addVolume(
					'  proxy-run:\n    driver_opts:\n      type: none\n      o: bind\n      device: /var/run\n  scratch:\n    name: ${SCRATCH_VOLUME:-owlat-scratch}\n  run:\n    name: owlat_proxy-run-cache\n'
				),
				proxyMount('proxy-run:/host-run:ro'),
				offline(
					[
						'    x-owner: ops',
						'    volumes:',
						'      - /cache',
						'      - ./data:/data',
						'      - ${OWLAT_DATA_DIR:-./data}:/srv/data:ro',
						'      - /var/lib/owlat:/var/lib/owlat:ro',
						'      - /run/owlat:/run/owlat',
						'      - /procedures:/srv/procedures:ro',
						'      - /dev/shm:/dev/shm',
						'      - /srv/./owlat//cache/:/srv/cache',
						'      - scratch:/scratch-volume',
						'      - run:/run-cache',
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
	});

	it.each(SOCKET_MUTATIONS)('rejects $breaks', ({ apply, expected }) => {
		const result = runGate(env, apply(original));
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(expected);
	});
});
