/**
 * The plugin as the repository actually runs it: the real oxlint binary, the
 * real root oxlintrc.json, launched from the repository root (the root lint
 * gates) and from a workspace with `--config ../../oxlintrc.json` (every
 * workspace `lint` script). The rule suites prove what each rule reports; this
 * suite proves the config loads the plugin in both places, turns the rules on
 * (as errors, or as warnings for the rules whose debt the owlat lint ratchet
 * holds) and makes a stale suppression fail.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
	'milestones.test.ts': [
		"import { it } from 'vitest';",
		'',
		"it('steps through held work', async () => {",
		'\tawait started(3);',
		'\tfor (let step = 3; step > 0; step--) {',
		'\t\trelease();',
		'\t\tawait new Promise((resolve) => setTimeout(resolve, 0));',
		'\t}',
		'});',
		'',
		'declare function started(count: number): Promise<void>;',
		'declare function release(): void;',
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
	'backoff.ts': [
		'export function retryDelayMs(attempt: number): number {',
		'\treturn Math.min(1_000 * 2 ** attempt, 60_000);',
		'}',
		'',
	].join('\n'),
	'uncheckedJson.ts': [
		'export async function read(request: Request): Promise<{ to: string }> {',
		'\treturn (await request.json()) as { to: string };',
		'}',
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
	// owlat/no-raw-keydown-listener is configured for apps/web/app only.
	'keydownListener.ts': ["window.addEventListener('keydown', () => {});", ''].join('\n'),
	'tsIgnore.ts': [
		'// a reason does not make @ts-ignore acceptable',
		'// @ts-ignore',
		"export const count: number = 'one';",
		'',
	].join('\n'),
	// The body-reset rule covers the test files of every workspace, run from the
	// root or from a workspace; `document` is a global the browser env provides.
	'apps/web/app/__tests__/bodyReset.test.ts': [
		"import { afterEach } from 'vitest';",
		'',
		'afterEach(() => {',
		"\tdocument.body.innerHTML = '';",
		'});',
		'',
	].join('\n'),
	// Removing a node found inside each child, one child's own children, a
	// filtered subset of the children, only the children a condition picks,
	// children down to a bound above zero, or every child after the first
	// leaves the body in place.
	'apps/web/app/__tests__/bodyOwnedRemoval.test.ts': [
		"import { afterEach } from 'vitest';",
		'',
		'afterEach(() => {',
		"\tfor (const child of document.body.children) child.querySelector('[data-owned]')?.remove();",
		'\tfor (const node of document.body.children[0].children) node.remove();',
		"\tfor (const node of [...document.body.children].filter((el) => el.matches('.toast'))) node.remove();",
		"\tfor (const child of document.body.children) { if (child.hasAttribute('data-owned')) child.remove(); }",
		'\twhile (document.body.childElementCount > 1) document.body.lastElementChild!.remove();',
		'\twhile (document.body.children[1]) document.body.children[1].remove();',
		'});',
		'',
	].join('\n'),
	'packages/email-builder/src/__tests__/bodyResetEmailBuilder.test.ts': [
		"import { afterEach } from 'vitest';",
		'',
		'afterEach(() => {',
		"\tdocument.body.innerHTML = '';",
		'});',
		'',
	].join('\n'),
	'packages/shared/src/__tests__/bodyResetShared.test.ts': [
		"import { afterEach } from 'vitest';",
		'',
		'afterEach(() => {',
		'\tdocument.body.replaceChildren();',
		'});',
		'',
	].join('\n'),
	// Application code is outside the rule: it may write a document it owns.
	'packages/shared/src/bodyWrite.ts': ["document.body.innerHTML = '';", ''].join('\n'),
};

let fixtureDirectory: string;

beforeAll(() => {
	fixtureDirectory = mkdtempSync(join(tmpdir(), 'owlat-oxlint-plugin-'));
	for (const [name, source] of Object.entries(FIXTURES)) {
		const path = join(fixtureDirectory, name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, source);
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

	it('rejects an elapsed-time check and a polling loop, and warns about a real-clock sleep', () => {
		expect(errorCodes(byFile.get('timing.test.ts')).sort()).toEqual([
			'owlat(no-polling-loop-in-tests)',
			'owlat(no-wall-clock-in-tests)',
		]);
		expect(warningCodes(byFile.get('timing.test.ts'))).toEqual([
			'owlat(no-real-time-wait-in-tests)',
		]);
	});

	it('accepts a test that awaits its milestone and then steps a fixed number of times', () => {
		expect(byFile.get('milestones.test.ts')).toBeUndefined();
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

	it('reports exponential backoff computed outside the retry policy module', () => {
		expect(errorCodes(byFile.get('backoff.ts'))).toEqual(['owlat(no-inline-backoff)']);
	});

	it('warns about a cast of parsed JSON for the ratchet', () => {
		expect(errorCodes(byFile.get('uncheckedJson.ts'))).toEqual([]);
		expect(warningCodes(byFile.get('uncheckedJson.ts'))).toEqual(['owlat(no-unchecked-json-cast)']);
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

	it('leaves keydown listeners outside the web app alone', () => {
		expect(byFile.get('keydownListener.ts')).toBeUndefined();
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

	it('reports a whole-body reset in the tests of every workspace', () => {
		for (const name of [
			'bodyReset.test.ts',
			'bodyResetEmailBuilder.test.ts',
			'bodyResetShared.test.ts',
		]) {
			expect(errorCodes(byFile.get(name)), name).toEqual(['owlat(no-document-body-reset)']);
		}
	});

	it('leaves application code that writes the body alone', () => {
		expect(byFile.get('bodyWrite.ts')).toBeUndefined();
	});

	it('accepts a loop over the body that removes only some of its nodes', () => {
		expect(byFile.get('bodyOwnedRemoval.test.ts')).toBeUndefined();
	});

	it('leaves a clean test file alone', () => {
		expect(byFile.get('clean.test.ts')).toBeUndefined();
	});
});
