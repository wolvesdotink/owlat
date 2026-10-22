/**
 * The plugin as the repository actually runs it: the real oxlint binary, the
 * real root oxlintrc.json, launched from the repository root (the root lint
 * gates) and from a workspace with `--config ../../oxlintrc.json` (every
 * workspace `lint` script). The rule suites prove what each rule reports; this
 * suite proves the config loads the plugin in both places, turns the rules on
 * (as errors, or as warnings for the rules whose debt the owlat lint ratchet
 * holds) and makes a stale suppression fail.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PARALLEL_GATE_TIMEOUT_MS } from '../../../../vitest.timeouts';
import { type Diagnostic, lintFixtures } from './runOxlint.ts';

// Vitest reads a pragma anywhere in this file's text, so the fixture builds it.
const PRAGMA_TAG = '@vitest-environment';

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
		`// ${PRAGMA_TAG} node`,
		"import { it } from 'vitest';",
		"it('a', () => {});",
		'',
	].join('\n'),
	// The test-timing rules: one real-clock sleep inside one polling loop, and
	// one stopwatch subtraction.
	'timing.test.ts': [
		"import { it } from 'vitest';",
		'',
		"it('waits', async () => {",
		'\tconst started = Date.now();',
		'\twhile (!ready()) {',
		'\t\tawait new Promise((resolve) => setTimeout(resolve, 10));',
		'\t}',
		'\texpect(Date.now() - started).toBeLessThan(1000);',
		'});',
		'',
		'declare function ready(): boolean;',
		'',
	].join('\n'),
	'timeout.test.ts': [
		"import { it } from 'vitest';",
		'',
		"it('slow', async () => {}, 30_000);",
		'',
	].join('\n'),
	'quarantined.test.ts': [
		"import { it } from 'vitest';",
		'',
		'// quarantine: #1234 the relay drops the second hello under load',
		"it.skip('relays twice', () => {});",
		'',
	].join('\n'),
	'vitest.config.ts': [
		"import { defineConfig } from 'vitest/config';",
		'',
		'export default defineConfig({ test: { retry: 1 } });',
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
	// The reason may sit on the line above a TypeScript directive, so the
	// built-in ban-ts-comment must not insist on an inline description too.
	'tsReasonAbove.ts': [
		'export const count: number =',
		'\t// the string is the deliberate type error under test',
		'\t// @ts-expect-error',
		"\t'one';",
		'',
	].join('\n'),
	'tsReasonInline.ts': [
		'export const count: number =',
		'\t// @ts-expect-error the string is the deliberate type error under test',
		"\t'one';",
		'',
	].join('\n'),
	'tsUnexplained.ts': [
		'export const count: number =',
		'\t// @ts-expect-error',
		"\t'one';",
		'',
	].join('\n'),
	// TypeScript obeys a `///` directive too, so the rule must see it there.
	'tsTripleSlashUnexplained.ts': [
		'export const count: number =',
		'\t/// @ts-expect-error',
		"\t'one';",
		'',
	].join('\n'),
	'tsTripleSlashReason.ts': [
		'export const count: number =',
		'\t/// @ts-expect-error the string is the deliberate type error under test',
		"\t'one';",
		'',
	].join('\n'),
	'tsIgnore.ts': [
		'// a reason does not make @ts-ignore acceptable',
		'// @ts-ignore',
		"export const count: number = 'one';",
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

const codesWith = (severity: string) => (diagnostics: Diagnostic[] | undefined) =>
	(diagnostics ?? []).filter((d) => d.severity === severity).map((d) => d.code ?? d.message);
const errorCodes = codesWith('error');
// A rule that lands with debt is a warning; scripts/check-owlat-lint.sh ratchets it.
// Sorted: one fixture can trip several warning rules, reported in source order.
const warningCodes = (diagnostics: Diagnostic[] | undefined) =>
	codesWith('warning')(diagnostics).sort();

describe.each(['.', 'apps/web'])('oxlint run from %s with the root config', (cwd) => {
	let byFile: Map<string, Diagnostic[]>;

	// One real oxlint process per directory, loading the plugin from source: a
	// fixed start-up cost that grows with machine load, hence the shared budget.
	beforeAll(() => {
		byFile = lintFixtures(fixtureDirectory, cwd);
	}, PARALLEL_GATE_TIMEOUT_MS);

	it('loads the plugin and reports a test declared in a loop', () => {
		expect(errorCodes(byFile.get('loop.test.ts'))).toEqual(['owlat(no-test-in-loop)']);
	});

	it('warns about a real-clock sleep, a polling loop and an elapsed-time check', () => {
		expect(errorCodes(byFile.get('timing.test.ts'))).toEqual([]);
		expect(warningCodes(byFile.get('timing.test.ts'))).toEqual([
			'owlat(no-polling-loop-in-tests)',
			'owlat(no-real-time-wait-in-tests)',
			'owlat(no-wall-clock-in-tests)',
		]);
	});

	it('reports a per-file test environment pragma', () => {
		expect(errorCodes(byFile.get('pragma.test.ts'))).toEqual(['owlat(no-test-environment-pragma)']);
	});

	it('reports a local test timeout and a retry in a vitest config for the ratchet', () => {
		expect(warningCodes(byFile.get('timeout.test.ts'))).toEqual([
			'owlat(no-test-timeout-or-unreasoned-skip)',
		]);
		expect(warningCodes(byFile.get('vitest.config.ts'))).toEqual([
			'owlat(no-test-timeout-or-unreasoned-skip)',
		]);
	});

	it('accepts a skip that names its tracking issue', () => {
		expect(byFile.get('quarantined.test.ts')).toBeUndefined();
	});

	it('reports a suppression that does not say why', () => {
		expect(errorCodes(byFile.get('unexplained.ts'))).toEqual(['owlat(require-suppression-reason)']);
	});

	it('accepts a TypeScript directive explained above it or inline', () => {
		expect(byFile.get('tsReasonAbove.ts')).toBeUndefined();
		expect(byFile.get('tsReasonInline.ts')).toBeUndefined();
	});

	it('reports an unexplained TypeScript directive once, through the owlat rule', () => {
		expect(errorCodes(byFile.get('tsUnexplained.ts'))).toEqual([
			'owlat(require-suppression-reason)',
		]);
	});

	it('reports an unexplained triple-slash TypeScript directive and accepts an explained one', () => {
		expect(errorCodes(byFile.get('tsTripleSlashUnexplained.ts'))).toEqual([
			'owlat(require-suppression-reason)',
		]);
		expect(byFile.get('tsTripleSlashReason.ts')).toBeUndefined();
	});

	it('keeps @ts-ignore banned even with a reason', () => {
		expect(errorCodes(byFile.get('tsIgnore.ts'))).toEqual(['typescript(ban-ts-comment)']);
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
