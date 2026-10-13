/**
 * The Docker API isolation half of scripts/check-compose-invariants.sh.
 *
 * docker-socket-proxy serves the Docker API unauthenticated, and the grants the
 * updater needs (CONTAINERS + POST) are enough to start a container with a host
 * bind mount. It must sit on the internal docker-proxy network with the updater
 * as its only neighbour. The VPS template had it on `default` with every other
 * service while the gate only looked at the root file (#1329), so each case
 * breaks one template in a copy and runs the real gate against it.
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

const NOT_ONLY_MEMBERS = 'docker-proxy network must hold exactly docker-socket-proxy and updater';
const SHARES_NAMESPACE = "joins a docker-proxy member's network namespace";

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

	it.each(MUTATIONS)(
		'rejects $breaks',
		({ apply, expected }) => {
			const result = runGate(env, apply(original));
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(expected);
		},
		GATE_TIMEOUT_MS
	);
});
