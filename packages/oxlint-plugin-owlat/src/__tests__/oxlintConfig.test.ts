/**
 * The plugin as the repository actually runs it: the real oxlint binary, the
 * real root oxlintrc.json, launched from the repository root (the root lint
 * gates) and from a workspace with `--config ../../oxlintrc.json` (every
 * workspace `lint` script). The rule suites prove what each rule reports; this
 * suite proves the config loads the plugin in both places, turns the rules on
 * as errors and makes a stale suppression fail.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PARALLEL_GATE_TIMEOUT_MS } from '../../../../vitest.timeouts';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const OXLINT_BIN = join(
	dirname(createRequire(import.meta.url).resolve('oxlint/package.json')),
	'bin/oxlint'
);

interface Diagnostic {
	filename: string;
	code?: string;
	message: string;
	severity: string;
}

const FIXTURES: Record<string, string> = {
	'clean.test.ts': [
		"import { describe, expect, it } from 'vitest';",
		'',
		"describe('clean', () => {",
		"\tit.each([1, 2])('handles %s', (n) => {",
		'\t\texpect(n).toBeGreaterThan(0);',
		'\t});',
		'});',
		'',
	].join('\n'),
	'loop.test.ts': [
		"import { it } from 'vitest';",
		'',
		'for (const n of [1, 2]) {',
		'\tit(`handles ${n}`, () => {});',
		'}',
		'',
	].join('\n'),
	'pragma.test.ts': [
		'// @vitest-environment node',
		"import { it } from 'vitest';",
		"it('a', () => {});",
		'',
	].join('\n'),
	'unexplained.ts': [
		'export function log(value: string): void {',
		'\t// oxlint-disable-next-line no-console',
		'\tconsole.log(value);',
		'}',
		'',
	].join('\n'),
	'stale.ts': [
		'export function log(value: string): void {',
		'\t// oxlint-disable-next-line no-console -- info is allowed, so this suppresses nothing',
		'\tconsole.info(value);',
		'}',
		'',
	].join('\n'),
};

let fixtureDirectory: string;

beforeAll(() => {
	fixtureDirectory = mkdtempSync(join(tmpdir(), 'owlat-oxlint-plugin-'));
	for (const [name, source] of Object.entries(FIXTURES)) {
		writeFileSync(join(fixtureDirectory, name), source);
	}
});

afterAll(() => {
	rmSync(fixtureDirectory, { recursive: true, force: true });
});

/** Lint the fixtures with the repository config, run from `cwd` (repo-relative). */
function lintFrom(cwd: string): Map<string, Diagnostic[]> {
	const directory = join(REPOSITORY_ROOT, cwd);
	const config = relative(directory, join(REPOSITORY_ROOT, 'oxlintrc.json'));
	const run = spawnSync(
		process.execPath,
		[OXLINT_BIN, '--config', config, '--format', 'json', fixtureDirectory],
		{ cwd: directory, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
	);
	if (run.status !== 0 && run.status !== 1) {
		throw new Error(`oxlint exited ${String(run.status)}: ${run.stderr}`);
	}
	const { diagnostics } = JSON.parse(run.stdout) as { diagnostics: Diagnostic[] };
	const byFile = new Map<string, Diagnostic[]>();
	for (const diagnostic of diagnostics) {
		const name = diagnostic.filename.split(/[\\/]/).at(-1)!;
		byFile.set(name, [...(byFile.get(name) ?? []), diagnostic]);
	}
	return byFile;
}

const errorCodes = (diagnostics: Diagnostic[] | undefined) =>
	(diagnostics ?? []).filter((d) => d.severity === 'error').map((d) => d.code ?? d.message);

describe.each(['.', 'apps/web'])('oxlint run from %s with the root config', (cwd) => {
	let byFile: Map<string, Diagnostic[]>;

	// One real oxlint process per directory, loading the plugin from source: a
	// fixed start-up cost that grows with machine load, hence the shared budget.
	beforeAll(() => {
		byFile = lintFrom(cwd);
	}, PARALLEL_GATE_TIMEOUT_MS);

	it('loads the plugin and reports a test declared in a loop', () => {
		expect(errorCodes(byFile.get('loop.test.ts'))).toEqual(['owlat(no-test-in-loop)']);
	});

	it('reports a per-file test environment pragma', () => {
		expect(errorCodes(byFile.get('pragma.test.ts'))).toEqual(['owlat(no-test-environment-pragma)']);
	});

	it('reports a suppression that does not say why', () => {
		expect(errorCodes(byFile.get('unexplained.ts'))).toEqual(['owlat(require-suppression-reason)']);
	});

	it('fails a suppression that no longer suppresses anything', () => {
		const stale = byFile.get('stale.ts') ?? [];
		expect(stale.map((d) => [d.severity, d.message])).toEqual([
			['error', expect.stringMatching(/^Unused oxlint-disable directive/)],
		]);
	});

	it('leaves a clean test file alone', () => {
		expect(byFile.get('clean.test.ts')).toBeUndefined();
	});
});
