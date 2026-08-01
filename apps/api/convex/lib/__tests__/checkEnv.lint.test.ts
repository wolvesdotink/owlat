/**
 * Self-test for the `scripts/check-env.sh` lint rule: every `process.env` read
 * in convex/ must go through lib/env.ts. It guards the guard — the rule is one
 * grep, and a grep that stops matching is indistinguishable from a codebase
 * that stopped violating it.
 *
 * The bracket cases are why this file exists: `process.env['FOO']` is the same
 * read as `process.env.FOO` and is the form a runtime-computed key takes, which
 * is precisely what the EnvKey union exists to prevent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'..',
	'scripts',
	'check-env.sh'
);

/** Run the lint against `root`. Returns the process exit code (0 = pass). */
function runLint(root: string): number {
	try {
		execFileSync('bash', [scriptPath, root], { encoding: 'utf8', stdio: 'pipe' });
		return 0;
	} catch (err) {
		const status = (err as { status?: number }).status;
		return typeof status === 'number' ? status : 1;
	}
}

let workDir: string;

/** Write `contents` to `<workDir>/<name>/<relPath>` and lint that tree. */
function lintTree(name: string, files: Record<string, string>): number {
	const root = join(workDir, name);
	for (const [relPath, contents] of Object.entries(files)) {
		const file = join(root, relPath);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, contents);
	}
	return runLint(root);
}

beforeAll(() => {
	workDir = mkdtempSync(join(tmpdir(), 'check-env-lint-'));
});

afterAll(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe('check-env.sh', () => {
	it('passes a tree that reads env only through lib/env.ts accessors', () => {
		expect(
			lintTree('clean', {
				'delivery/poller.ts': "const url = getOptional('SNDS_DATA_FEED_URLS') ?? '';\n",
			})
		).toBe(0);
	});

	it('fails a dotted process.env read', () => {
		expect(
			lintTree('dotted', { 'delivery/poller.ts': 'const url = process.env.SNDS_DATA_FEED_URLS;\n' })
		).toBe(1);
	});

	it('fails a bracket process.env read with a literal key', () => {
		expect(
			lintTree('bracket-literal', {
				'delivery/poller.ts': "const url = process.env['SNDS_DATA_FEED_URLS'];\n",
			})
		).toBe(1);
	});

	it('fails a bracket process.env read with a computed key', () => {
		// The worst case the EnvKey union exists to prevent: a key no reviewer can
		// grep for and no union can constrain.
		expect(
			lintTree('bracket-computed', {
				'delivery/poller.ts': 'const url = process.env[`SNDS_${suffix}`];\n',
			})
		).toBe(1);
	});

	it('exempts lib/env.ts itself in both access forms (it is the one reader)', () => {
		expect(
			lintTree('env-module', {
				'lib/env.ts': 'export const get = (k: string) => process.env[k] ?? process.env.FALLBACK;\n',
			})
		).toBe(0);
	});

	it('exempts test files, which configure a test run rather than a deployment', () => {
		expect(
			lintTree('tests', {
				'delivery/__tests__/fixtures.ts':
					"const mode = process.env['OWLAT_RAMP_GATE_MATRIX_MODE'];\n",
				'delivery/poller.test.ts': 'const flag = process.env.CI;\n',
			})
		).toBe(0);
	});
});
