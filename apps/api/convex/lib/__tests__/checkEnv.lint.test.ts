/**
 * Self-test for the `scripts/check-env.sh` lint rule: a workspace reads the
 * process environment only in its config module (lib/env.ts for convex/, the
 * Node services' config.ts and logger). It guards the guard — the rule is one
 * grep, and a grep that stops matching is indistinguishable from a codebase
 * that stopped violating it.
 *
 * The non-dotted cases are why this file exists: bracket, destructuring and
 * optional-chaining reads are the same read as `process.env.FOO`, and the first
 * two are the forms a runtime-computed key takes — precisely what the EnvKey
 * union exists to prevent. The rule matches the object, not any access syntax,
 * so the failing set below is a sample of an open class rather than the list.
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

/**
 * Run the lint with `args` from `cwd`. Returns the process exit code (0 = pass,
 * 1 = a read outside the allowed files, 2 = a usage error).
 */
function runScript(args: string[], cwd?: string): number {
	try {
		execFileSync('bash', [scriptPath, ...args], { encoding: 'utf8', stdio: 'pipe', cwd });
		return 0;
	} catch (err) {
		const status = (err as { status?: number }).status;
		return typeof status === 'number' ? status : 1;
	}
}

/** Run the lint against `root` with convex/'s allowlist. */
function runLint(root: string): number {
	return runScript([root, 'lib/env.ts']);
}

let workDir: string;

/** Write `files` under `<workDir>/<name>` and return that root. */
function writeTree(name: string, files: Record<string, string>): string {
	const root = join(workDir, name);
	for (const [relPath, contents] of Object.entries(files)) {
		const file = join(root, relPath);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, contents);
	}
	return root;
}

/** Write `files` under `<workDir>/<name>` and lint that tree. */
function lintTree(name: string, files: Record<string, string>): number {
	return runLint(writeTree(name, files));
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

	it('fails a destructured process.env read', () => {
		expect(
			lintTree('destructured', {
				'delivery/poller.ts': 'const { SNDS_DATA_FEED_URLS } = process.env;\n',
			})
		).toBe(1);
	});

	it('fails an optional-chained process.env read', () => {
		expect(
			lintTree('optional-chain', {
				'delivery/poller.ts': 'const url = process.env?.SNDS_DATA_FEED_URLS;\n',
			})
		).toBe(1);
	});

	it('fails an enumeration of process.env', () => {
		// No key at all, so no union to violate — and every value in the sandbox
		// reachable without one.
		expect(
			lintTree('enumerated', {
				'delivery/poller.ts': 'const all = Object.entries(process.env);\n',
			})
		).toBe(1);
	});

	it.each([
		['bracket on process', "const env = process['env'];\n"],
		['destructured from process', 'const { env } = process;\n'],
		['renamed in a destructuring', 'const { argv, env: e } = globalThis.process;\n'],
		['imported from node:process', "import { env } from 'node:process';\n"],
	])('fails the environment object taken another way: %s', (name, line) => {
		expect(lintTree(`object-${name.replace(/\W+/g, '-')}`, { 'delivery/poller.ts': line })).toBe(1);
	});

	it('passes code that only mentions process or an env-like name', () => {
		expect(
			lintTree('near-misses', {
				'delivery/poller.ts':
					'const { argv } = process;\n' +
					'const entry = process.argv[1];\n' +
					'const environment = 1;\n' +
					'const { env } = processor;\n',
			})
		).toBe(0);
	});

	it('exempts lib/env.ts itself in every access form (it is the one reader)', () => {
		expect(
			lintTree('env-module', {
				'lib/env.ts':
					'const { NODE_ENV } = process.env;\n' +
					'export const get = (k: string) => process.env[k] ?? process.env.FALLBACK ?? NODE_ENV;\n',
			})
		).toBe(0);
	});

	it('exempts test files, which configure a test run rather than a deployment', () => {
		expect(
			lintTree('tests', {
				'delivery/__tests__/fixtures.ts':
					"const mode = process.env['OWLAT_RAMP_GATE_MATRIX_MODE'];\n",
				'delivery/poller.test.ts': 'const flag = process.env.CI;\n',
				'delivery/poller.spec.ts': 'const flag = process.env.CI;\n',
			})
		).toBe(0);
	});
});

describe('check-env.sh for a Node service', () => {
	const service = {
		'config.ts': "export const port = process.env['PORT'];\n",
		'monitoring/logger.ts': "export const level = process.env['LOG_LEVEL'] ?? 'info';\n",
		'server.ts': "import { port } from './config.js';\n",
	};
	const allowed = ['config.ts', 'monitoring/logger.ts'];

	it('passes reads in exactly the allowed files', () => {
		const root = writeTree('service-clean', service);
		expect(runScript([root, ...allowed])).toBe(0);
	});

	it('fails a read anywhere else', () => {
		const root = writeTree('service-stray', {
			...service,
			'routes/scan.ts': "const host = process.env['CLAMAV_HOST'];\n",
		});
		expect(runScript([root, ...allowed])).toBe(1);
	});

	it('matches allowed paths exactly, not by name or prefix', () => {
		// Same basename in another directory, a longer name, a lookalike prefix.
		for (const stray of [
			'routes/config.ts',
			'logger.ts',
			'config.tsx.ts',
			'monitoring/logger.ts.ts',
		]) {
			const root = writeTree(`service-lookalike-${stray.replace(/\W+/g, '-')}`, {
				...service,
				[stray]: 'const x = process.env.X;\n',
			});
			expect(runScript([root, ...allowed]), stray).toBe(1);
		}
	});

	it('resolves a relative root from the directory it runs in', () => {
		writeTree('relative/src', { ...service, 'stray.ts': 'const x = process.env.X;\n' });
		const cwd = join(workDir, 'relative');
		expect(runScript(['src', ...allowed], cwd)).toBe(1);
		expect(runScript(['./src/', 'config.ts', 'monitoring/logger.ts', 'stray.ts'], cwd)).toBe(0);
	});

	it('refuses a root that does not exist, rather than scanning nothing', () => {
		expect(runScript([join(workDir, 'no-such-root'), 'config.ts'])).toBe(2);
	});

	it('refuses a root with no allowed file named', () => {
		expect(runScript([writeTree('service-no-allow', service)])).toBe(2);
	});
});

describe('check-env.sh with no arguments', () => {
	it('checks convex/ against lib/env.ts, and it is clean', () => {
		expect(runScript([])).toBe(0);
	});
});
