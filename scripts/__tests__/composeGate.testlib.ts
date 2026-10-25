/**
 * Shared fixture for the compose gate tests (check-compose-invariants.test.ts,
 * check-compose-socket-access.test.ts): each case breaks one shipped template
 * in a temporary copy and runs the real scripts/check-compose-invariants.sh
 * against it.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from 'vitest';
import { PARALLEL_GATE_TIMEOUT_MS } from '../../vitest.timeouts';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..');
const SCRIPT = join(REPOSITORY_ROOT, 'scripts/check-compose-invariants.sh');

export const TEMPLATES = [
	{ name: 'docker-compose.yml', env: 'COMPOSE_INVARIANTS_ROOT' },
	{ name: 'infra/templates/docker-compose.vps.yml', env: 'COMPOSE_INVARIANTS_VPS' },
] as const;

// A test runs the gate once. Half the suite's per-test budget kills a hung gate
// with time left for the test to report the spawn error.
const GATE_DEADLINE_MS = PARALLEL_GATE_TIMEOUT_MS / 2;

const sandboxes: string[] = [];

/** Deletes the copies runGate wrote; register it with afterEach. */
export function removeSandboxes(): void {
	while (sandboxes.length > 0) {
		const dir = sandboxes.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
}

/** A shipped template as checked in, by its repository path. */
export const readTemplate = (name: string): string =>
	readFileSync(join(REPOSITORY_ROOT, name), 'utf8');

/** Replaces the single occurrence of `from`; a missing anchor fails loudly. */
export function replaceOnce(source: string, from: string, to: string): string {
	expect(source.split(from), `anchor not found exactly once: ${JSON.stringify(from)}`).toHaveLength(
		2
	);
	return source.replace(from, to);
}

export function runGate(env: string, compose: string): { status: number | null; stderr: string } {
	const dir = mkdtempSync(join(tmpdir(), 'owlat-compose-invariants-'));
	sandboxes.push(dir);
	const file = join(dir, 'docker-compose.yml');
	writeFileSync(file, compose);
	// A sync spawn blocks the event loop, so vitest's own timeout cannot stop a
	// hung gate; the spawn has to time out by itself.
	const result = spawnSync('bash', [SCRIPT], {
		encoding: 'utf8',
		env: { ...process.env, [env]: file },
		timeout: GATE_DEADLINE_MS,
	});
	expect(result.error).toBeUndefined();
	return { status: result.status, stderr: result.stderr };
}

/** Adds a service, written as `body`, ahead of the updater. */
export function addIntruder(body: string): (s: string) => string {
	return (s) =>
		replaceOnce(s, '\n  updater:\n', `\n  intruder:\n    image: alpine:3\n${body}\n  updater:\n`);
}

/** Declares an extra top-level volume next to the shipped ones. */
export function addVolume(body: string): (s: string) => string {
	return (s) => replaceOnce(s, '\nvolumes:\n', `\nvolumes:\n${body}`);
}

export const both =
	(...steps: ((s: string) => string)[]) =>
	(s: string) =>
		steps.reduce((acc, step) => step(acc), s);
