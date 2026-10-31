/**
 * oxlintrc.json turns on the suspicious and perf categories (as errors, along
 * with unicorn/no-array-for-each) and the vue plugin. All are easy to lose
 * silently: a `plugins` list that drops "vue", a categories block that drops
 * "perf" or a severity back at "warn" still lints cleanly, it just stops
 * reporting or failing. These fixtures run the repository config through the
 * locked oxlint and check that each rule family still fires on an offender,
 * fails the run, and stays quiet on its clean counterpart.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type LintDiagnostic, parseLintReport } from '../lint-diagnostics';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const FIXTURES: Record<string, string> = {
	// The offenders of the promoted rules sit in a directory of their own, so
	// the run over it shows that they alone fail the lint.
	'promoted/perfOffender.ts': [
		'export const first = (xs: number[]) => xs.filter((x) => x > 1)[0];',
		'',
	].join('\n'),
	'perfClean.ts': ['export const first = (xs: number[]) => xs.find((x) => x > 1);', ''].join('\n'),
	'promoted/suspiciousOffender.ts': ['export class Empty {}', ''].join('\n'),
	'suspiciousClean.ts': ['export const empty = {};', ''].join('\n'),
	'promoted/forEachOffender.ts': [
		'export function sum(xs: number[]) {',
		'\tlet total = 0;',
		'\txs.forEach((x) => {',
		'\t\ttotal += x;',
		'\t});',
		'\treturn total;',
		'}',
		'',
	].join('\n'),
	'forEachClean.ts': [
		'export function sum(xs: number[]) {',
		'\tlet total = 0;',
		'\tfor (const x of xs) total += x;',
		'\treturn total;',
		'}',
		'',
	].join('\n'),
	// Sequential awaits are allowed: the perf category's no-await-in-loop is off.
	'awaitInLoop.ts': [
		'export async function drain(jobs: (() => Promise<void>)[]) {',
		'\tfor (const job of jobs) await job();',
		'}',
		'',
	].join('\n'),
	'HookAfterAwait.vue': [
		'<script lang="ts">',
		"import { onMounted } from 'vue';",
		'export default {',
		'\tasync setup() {',
		"\t\tawait fetch('/status');",
		'\t\tonMounted(() => {});',
		'\t},',
		'};',
		'</script>',
		'',
	].join('\n'),
	'HookBeforeAwait.vue': [
		'<script lang="ts">',
		"import { onMounted } from 'vue';",
		'export default {',
		'\tasync setup() {',
		'\t\tonMounted(() => {});',
		"\t\tawait fetch('/status');",
		'\t},',
		'};',
		'</script>',
		'',
	].join('\n'),
};

let directory = '';
let diagnostics: LintDiagnostic[] = [];
let promotedExitStatus: number | null = null;

const diagnosticsFor = (file: string): LintDiagnostic[] =>
	diagnostics.filter((diagnostic) => diagnostic.filename.endsWith(`/${file}`));

const codesFor = (file: string): string[] =>
	diagnosticsFor(file).map((diagnostic) => diagnostic.code ?? '');

const severityOf = (file: string, code: string): string | undefined =>
	diagnosticsFor(file).find((diagnostic) => diagnostic.code === code)?.severity;

const lint = (target: string) => {
	const run = spawnSync(
		join(REPOSITORY_ROOT, 'node_modules/.bin/oxlint'),
		['--config', 'oxlintrc.json', '--format', 'json', target],
		{ cwd: REPOSITORY_ROOT, encoding: 'utf8' }
	);
	if (run.error) throw run.error;
	return run;
};

beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), 'owlat-oxlint-categories-'));
	mkdirSync(join(directory, 'promoted'));
	for (const [name, source] of Object.entries(FIXTURES)) {
		writeFileSync(join(directory, name), source);
	}
	diagnostics = parseLintReport(lint(directory).stdout);
	promotedExitStatus = lint(join(directory, 'promoted')).status;
});

afterAll(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('oxlintrc.json perf category', () => {
	it('reports a perf rule on an offender', () => {
		expect(codesFor('perfOffender.ts')).toContain('unicorn(prefer-array-find)');
	});

	it('reports it as an error', () => {
		expect(severityOf('perfOffender.ts', 'unicorn(prefer-array-find)')).toBe('error');
	});

	it('stays quiet on the clean counterpart', () => {
		expect(codesFor('perfClean.ts')).toEqual([]);
	});

	it('leaves sequential awaits in loops alone', () => {
		expect(codesFor('awaitInLoop.ts')).toEqual([]);
	});
});

describe('oxlintrc.json suspicious category', () => {
	it('reports a suspicious rule on an offender, as an error', () => {
		expect(codesFor('suspiciousOffender.ts')).toContain('typescript(no-extraneous-class)');
		expect(severityOf('suspiciousOffender.ts', 'typescript(no-extraneous-class)')).toBe('error');
	});

	it('stays quiet on the clean counterpart', () => {
		expect(codesFor('suspiciousClean.ts')).toEqual([]);
	});
});

describe('oxlintrc.json unicorn/no-array-for-each', () => {
	it('reports forEach as an error', () => {
		expect(severityOf('forEachOffender.ts', 'unicorn(no-array-for-each)')).toBe('error');
	});

	it('stays quiet on a for-of loop', () => {
		expect(codesFor('forEachClean.ts')).toEqual([]);
	});
});

describe('oxlintrc.json severities', () => {
	it('fails the run on the promoted offenders without --deny-warnings', () => {
		expect(promotedExitStatus).toBe(1);
	});
});

describe('oxlintrc.json vue plugin', () => {
	it('reports a lifecycle hook registered after await in setup()', () => {
		expect(codesFor('HookAfterAwait.vue')).toContain('vue(no-lifecycle-after-await)');
	});

	it('stays quiet when the hook is registered before the await', () => {
		expect(codesFor('HookBeforeAwait.vue')).toEqual([]);
	});
});
