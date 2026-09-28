/**
 * `setConvexEnvVars` end to end against stand-ins: a fake `docker` on PATH
 * records its argv and runs the container command locally, and a fake `convex`
 * records what `convex env set` would have stored. What is under test is the
 * real host-side invocation plus the real in-container script.
 */
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeEnvSetPayload, setConvexEnvVars } from '../convexDeploy';

const FAKE_DOCKER = `#!/bin/sh
printf '%s\\n' "$@" > "$OWLAT_TEST_OUT/docker.argv"
# Run what follows the service name, as the container would.
while [ "$#" -gt 0 ] && [ "$1" != "convex-deploy" ]; do shift; done
shift
exec "$@"
`;

// Records the value `convex env set` receives. Accepts both the old argv form
// (\`-- NAME VALUE\`) and the --from-file form, so the argv assertions below are
// what fails against the old implementation.
const FAKE_CONVEX = `#!/bin/sh
printf '%s\\n' "$@" >> "$OWLAT_TEST_OUT/convex.argv"
shift 2
if [ "$1" = "--from-file" ]; then
	file="$2"; name="$4"
	printf '%s' "$file" > "$OWLAT_TEST_OUT/$name.path"
	[ "$name" = "FAIL_ME" ] && exit 1
	cat "$file" > "$OWLAT_TEST_OUT/$name.value"
else
	name="$2"
	printf '%s' "$3" > "$OWLAT_TEST_OUT/$name.value"
fi
`;

describe('setConvexEnvVars', () => {
	let root: string;
	let out: string;
	const savedPath = process.env['PATH'];

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'owlat-envset-'));
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
	});

	afterEach(async () => {
		process.env['PATH'] = savedPath;
		delete process.env['OWLAT_TEST_OUT'];
		await rm(root, { recursive: true, force: true });
	});

	const vars: Array<[string, string]> = [
		['BETTER_AUTH_SECRET', '-starts-with-a-dash'],
		['LLM_API_KEY', 'sk x "q" \'s\' = # $HOME \\n'],
		['PEM_KEY', 'line1\nline2\n'],
		['DEFAULT_FROM_NAME', 'Ünïcode Mailer'],
	];

	it('keeps every value off the docker argv', async () => {
		await setConvexEnvVars(root, vars);
		const argv = await readFile(join(out, 'docker.argv'), 'utf-8');
		for (const [, value] of vars) {
			for (const piece of value.split('\n').filter((p) => p.trim().length > 3)) {
				expect(argv).not.toContain(piece);
			}
		}
		expect(argv.split('\n').slice(0, 7)).toEqual([
			'compose',
			'--profile',
			'deploy',
			'run',
			'--rm',
			'-T',
			'convex-deploy',
		]);
	});

	it('keeps every value off the in-container convex argv too', async () => {
		await setConvexEnvVars(root, vars);
		const argv = await readFile(join(out, 'convex.argv'), 'utf-8');
		for (const [, value] of vars) expect(argv).not.toContain(value.split('\n')[0]);
	});

	it('hands convex env set each value byte for byte', async () => {
		const lines: string[] = [];
		await setConvexEnvVars(root, vars, (line) => lines.push(line));
		for (const [key, value] of vars) {
			expect(await readFile(join(out, `${key}.value`), 'utf-8')).toBe(value);
		}
		// Progress names the keys, never the values.
		expect(lines).toEqual(vars.map(([key]) => `env set ${key}`));
	});

	it('stops at the first failure, reports it, and removes the temp file', async () => {
		await expect(
			setConvexEnvVars(root, [
				['FAIL_ME', 'secret-value'],
				['NEVER_REACHED', 'x'],
			])
		).rejects.toThrow(/Failed to set Convex function-runtime env vars/);
		const tempFile = await readFile(join(out, 'FAIL_ME.path'), 'utf-8');
		expect(existsSync(tempFile)).toBe(false);
		expect(await readdir(out)).not.toContain('NEVER_REACHED.value');
	});

	it('does nothing for an empty list', async () => {
		await setConvexEnvVars(root, []);
		expect(await readdir(out)).toEqual([]);
	});
});

describe('encodeEnvSetPayload', () => {
	it('emits one `KEY BASE64` line per variable', () => {
		expect(
			encodeEnvSetPayload([
				['A', 'x y'],
				['B', ''],
			])
		).toBe('A eCB5\nB \n');
	});

	it('refuses a key the script could misread', () => {
		expect(() => encodeEnvSetPayload([['BAD KEY', 'x']])).toThrow(/invalid name/);
		expect(() => encodeEnvSetPayload([['A\nB', 'x']])).toThrow(/invalid name/);
	});
});
