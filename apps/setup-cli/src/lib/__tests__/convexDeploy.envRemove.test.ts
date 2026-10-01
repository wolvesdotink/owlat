/**
 * `removeConvexEnvVars` end to end against stand-ins: a fake `docker` on PATH
 * records its argv and runs the container command locally, and a fake `convex`
 * records each `convex env remove` and fails for one chosen name. What is under
 * test is the real host-side invocation plus the real in-container loop.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConvexEnvRemoveError, removeConvexEnvVars } from '../convexDeploy';

const FAKE_DOCKER = `#!/bin/sh
printf '%s\\n' "$@" > "$OWLAT_TEST_OUT/docker.argv"
# Run what follows the service name, as the container would.
while [ "$#" -gt 0 ] && [ "$1" != "convex-deploy" ]; do shift; done
shift
exec "$@"
`;

const FAKE_CONVEX = `#!/bin/sh
printf '%s\\n' "$*" >> "$OWLAT_TEST_OUT/convex.calls"
[ "$4" = "$FAIL_ON" ] && { echo "backend unreachable" >&2; exit 1; }
exit 0
`;

describe('removeConvexEnvVars', () => {
	let root: string;
	let out: string;
	const savedPath = process.env['PATH'];

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'owlat-envremove-'));
		out = join(root, 'out');
		const bin = join(root, 'bin');
		await mkdir(out);
		await mkdir(bin);
		await writeFile(join(bin, 'docker'), FAKE_DOCKER);
		await writeFile(join(bin, 'convex'), FAKE_CONVEX);
		await chmod(join(bin, 'docker'), 0o755);
		await chmod(join(bin, 'convex'), 0o755);
		process.env['PATH'] = `${bin}:${savedPath}`;
		process.env['OWLAT_TEST_OUT'] = out;
		delete process.env['FAIL_ON'];
	});

	afterEach(async () => {
		process.env['PATH'] = savedPath;
		delete process.env['OWLAT_TEST_OUT'];
		delete process.env['FAIL_ON'];
		await rm(root, { recursive: true, force: true });
	});

	const calls = async () =>
		(await readFile(join(out, 'convex.calls'), 'utf-8')).split('\n').filter(Boolean);

	it('runs convex env remove for each name in the convex-deploy container', async () => {
		const lines: string[] = [];
		await removeConvexEnvVars(root, ['LLM_BASE_URL', 'DECISION_MODEL'], (line) => lines.push(line));

		const argv = (await readFile(join(out, 'docker.argv'), 'utf-8')).split('\n');
		expect(argv.slice(0, 7)).toEqual([
			'compose',
			'--profile',
			'deploy',
			'run',
			'--rm',
			'-T',
			'convex-deploy',
		]);
		expect(await calls()).toEqual(['env remove -- LLM_BASE_URL', 'env remove -- DECISION_MODEL']);
		expect(lines).toEqual(['env removed LLM_BASE_URL', 'env removed DECISION_MODEL']);
	});

	it('stops at the first failure and names what was already removed', async () => {
		process.env['FAIL_ON'] = 'DECISION_MODEL';

		const error = await removeConvexEnvVars(root, [
			'LLM_BASE_URL',
			'DECISION_MODEL',
			'LLM_MODEL',
		]).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ConvexEnvRemoveError);
		expect((error as ConvexEnvRemoveError).removed).toEqual(['LLM_BASE_URL']);
		expect((error as Error).message).toContain('Failed to remove Convex function-runtime env vars');
		expect((error as Error).message).toContain('backend unreachable');
		expect(await calls()).toEqual(['env remove -- LLM_BASE_URL', 'env remove -- DECISION_MODEL']);
	});

	it('refuses a name that is not a plain identifier before running anything', async () => {
		await expect(removeConvexEnvVars(root, ['LLM_BASE_URL', 'X; rm -rf /'])).rejects.toThrow(
			/invalid name/
		);
		expect(existsSync(join(out, 'docker.argv'))).toBe(false);
	});

	it('does nothing for an empty list', async () => {
		await removeConvexEnvVars(root, []);
		expect(existsSync(join(out, 'docker.argv'))).toBe(false);
	});
});
