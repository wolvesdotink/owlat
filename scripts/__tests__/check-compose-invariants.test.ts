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
	const result = spawnSync('bash', [SCRIPT], {
		encoding: 'utf8',
		env: { ...process.env, [env]: file },
	});
	return { status: result.status, stderr: result.stderr };
}

const MUTATIONS = [
	{
		breaks: 'the proxy also attached to default',
		apply: (s: string) =>
			replaceOnce(
				s,
				'      - docker-proxy\n    restart: unless-stopped',
				'      - default\n      - docker-proxy\n    restart: unless-stopped'
			),
		expected: 'docker-socket-proxy must mount the socket :ro, attach to docker-proxy only',
	},
	{
		breaks: 'the proxy with no networks key (implicitly on default)',
		apply: (s: string) =>
			replaceOnce(
				s,
				'    networks:\n      - docker-proxy\n    restart: unless-stopped',
				'    restart: unless-stopped'
			),
		expected: 'docker-socket-proxy must mount the socket :ro, attach to docker-proxy only',
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
		breaks: 'a third service on docker-proxy',
		apply: (s: string) =>
			replaceOnce(
				s,
				'\n  updater:\n',
				'\n  intruder:\n    image: alpine:3\n    networks:\n      - docker-proxy\n\n  updater:\n'
			),
		expected: 'has 3 services on the docker-proxy network',
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
