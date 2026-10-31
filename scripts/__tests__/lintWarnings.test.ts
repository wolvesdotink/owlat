import { describe, expect, it } from 'vitest';
import { lintVerdict, type LintRun } from '../check-lint-warnings';

const diagnostic = (code: string | undefined, severity: string) => ({
	filename: 'packages/x/src/a.ts',
	...(code === undefined ? {} : { code }),
	message: 'Dependency cycle detected',
	severity,
	labels: [{ span: { offset: 0, length: 9, line: 3 } }],
});

const run = (diagnostics: unknown[], overrides: Partial<LintRun> = {}): LintRun => ({
	signal: null,
	status: diagnostics.length ? 1 : 0,
	stdout: JSON.stringify({ diagnostics }),
	stderr: '',
	...overrides,
});

describe('zero-warning lint gate', () => {
	it('passes a clean report', () => {
		expect(lintVerdict(run([]))).toEqual({ ok: true, problems: [] });
	});

	it('fails on a single warning, including an import cycle', () => {
		const verdict = lintVerdict(run([diagnostic('import(no-cycle)', 'warning')]));
		expect(verdict.ok).toBe(false);
		expect(verdict.problems).toEqual([
			'packages/x/src/a.ts:3: warning import(no-cycle): Dependency cycle detected',
		]);
	});

	it('fails on an error and on a diagnostic without a rule code', () => {
		expect(lintVerdict(run([diagnostic('eslint(no-console)', 'error')])).ok).toBe(false);
		expect(lintVerdict(run([diagnostic(undefined, 'warning')])).problems).toEqual([
			'packages/x/src/a.ts:3: warning (oxlint): Dependency cycle detected',
		]);
	});

	it('leaves owlat warnings to their own gate, but not owlat errors', () => {
		expect(lintVerdict(run([diagnostic('owlat(no-test-in-loop)', 'warning')]))).toEqual({
			ok: true,
			problems: [],
		});
		expect(lintVerdict(run([diagnostic('owlat(no-test-in-loop)', 'error')])).ok).toBe(false);
	});

	it('fails when oxlint did not finish', () => {
		expect(lintVerdict(run([], { status: 2, stderr: 'bad config' })).problems).toEqual([
			'oxlint did not finish (exit status 2): bad config',
		]);
		expect(lintVerdict(run([], { status: null, signal: 'SIGKILL' })).ok).toBe(false);
		expect(lintVerdict(run([], { error: new Error('spawn bunx ENOENT') })).ok).toBe(false);
	});

	it('fails on a report it cannot read', () => {
		expect(lintVerdict(run([], { stdout: 'not json' })).ok).toBe(false);
		expect(lintVerdict(run([], { stdout: JSON.stringify({ findings: [] }) })).ok).toBe(false);
	});

	it('fails an exit 1 that reported nothing', () => {
		expect(lintVerdict(run([], { status: 1, stderr: 'panicked' })).problems).toEqual([
			'oxlint exited 1 without reporting a diagnostic: panicked',
		]);
	});
});
