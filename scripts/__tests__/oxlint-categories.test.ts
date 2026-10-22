/**
 * oxlintrc.json turns on the perf category and the vue plugin. Both are easy to
 * lose silently: a `plugins` list that drops "vue" or a categories block that
 * drops "perf" still lints cleanly, it just stops reporting. These fixtures run
 * the repository config through the locked oxlint and check that each rule
 * family still fires on an offender and stays quiet on its clean counterpart.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LintDiagnostic } from '../check-lint-warnings';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const FIXTURES: Record<string, string> = {
	'perfOffender.ts': [
		'export const first = (xs: number[]) => xs.filter((x) => x > 1)[0];',
		'',
	].join('\n'),
	'perfClean.ts': ['export const first = (xs: number[]) => xs.find((x) => x > 1);', ''].join('\n'),
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

const codesFor = (file: string): string[] =>
	diagnostics
		.filter((diagnostic) => diagnostic.filename.endsWith(`/${file}`))
		.map((diagnostic) => diagnostic.code ?? '');

beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), 'owlat-oxlint-categories-'));
	for (const [name, source] of Object.entries(FIXTURES)) {
		writeFileSync(join(directory, name), source);
	}
	const run = spawnSync(
		join(REPOSITORY_ROOT, 'node_modules/.bin/oxlint'),
		['--config', 'oxlintrc.json', '--format', 'json', directory],
		{ cwd: REPOSITORY_ROOT, encoding: 'utf8' }
	);
	if (run.error) throw run.error;
	diagnostics = (JSON.parse(run.stdout) as { diagnostics: LintDiagnostic[] }).diagnostics;
});

afterAll(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('oxlintrc.json perf category', () => {
	it('reports a perf rule on an offender', () => {
		expect(codesFor('perfOffender.ts')).toContain('unicorn(prefer-array-find)');
	});

	it('stays quiet on the clean counterpart', () => {
		expect(codesFor('perfClean.ts')).toEqual([]);
	});

	it('leaves sequential awaits in loops alone', () => {
		expect(codesFor('awaitInLoop.ts')).toEqual([]);
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
