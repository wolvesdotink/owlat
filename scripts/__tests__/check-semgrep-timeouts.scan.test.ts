/**
 * Conformance for `check-semgrep-timeouts.sh --scan`, the mode the SAST job
 * runs: the script runs the scan, checks its report, and re-runs a scan once
 * when fixpoint timeouts were its only problem. A stand-in `semgrep` plays
 * each run. The last case pins the workflow wiring.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	REPOSITORY_ROOT,
	RULE_PARSE_ERROR,
	cleanup,
	fixpointTimeout,
	report,
	scan,
} from './semgrepTimeouts.testlib';

afterAll(cleanup);

const TIMED_OUT = report({ timeouts: [fixpointTimeout('apps/a.ts', 12, 15, 1, 'rule.a')] });
const OTHER_TIMEOUT = report({ timeouts: [fixpointTimeout('apps/b.ts', 1, 0, 2, 'rule.b')] });
const CLEAN = report();

describe('check-semgrep-timeouts --scan', () => {
	it('runs the scan once with --time --json-output and passes a clean report', async () => {
		const result = await scan([{ report: report({ errors: [RULE_PARSE_ERROR] }) }]);
		expect(result.code).toBe(0);
		expect(result.invocations).toEqual([
			['scan', '--error', '--time', '--json-output', '<dir>/semgrep.json'],
		]);
		expect(result.stdout).toContain(
			'Semgrep scan coverage (first scan): 0 fixpoint timeout(s), 1 error(s), 0 warning(s).'
		);
		expect(result.summary).toContain('## Semgrep scan coverage (first scan)');
	});

	it('re-runs once after fixpoint timeouts and passes when the re-run has none', async () => {
		const result = await scan([{ report: TIMED_OUT }, { report: CLEAN }]);
		expect(result.code).toBe(0);
		expect(result.invocations).toEqual([
			['scan', '--error', '--time', '--json-output', '<dir>/semgrep.json'],
			['scan', '--error', '--time', '--json-output', '<dir>/semgrep-retry.json'],
		]);
		expect(result.stdout).toContain('Re-running the scan once');
		// The first scan's timeouts are warnings: they did not fail the job.
		expect(result.stdout).toContain(
			'::warning file=apps/a.ts,line=12,title=Semgrep fixpoint timeout::'
		);
		expect(result.stdout).not.toContain('::error');
		// Both reports are in the summary.
		expect(result.summary).toContain('## Semgrep scan coverage (first scan)');
		expect(result.summary).toContain('| apps/a.ts:12 | function | 1 | rule.a |');
		expect(result.summary).toContain('## Semgrep scan coverage (re-run)');
	});

	it('fails when the re-run has fixpoint timeouts too', async () => {
		const result = await scan([{ report: TIMED_OUT }, { report: OTHER_TIMEOUT }]);
		expect(result.code).toBe(1);
		expect(result.invocations).toHaveLength(2);
		expect(result.stdout).toContain(
			'::error file=apps/b.ts,line=1,title=Semgrep fixpoint timeout::'
		);
		expect(result.stdout).toContain('Failing: fixpoint timeouts in two complete scans.');
		expect(result.summary).toContain('| apps/a.ts:12 | function | 1 | rule.a |');
		expect(result.summary).toContain('| apps/b.ts:1 | top-level code | 2 | rule.b |');
	});

	it('fails at once on findings, without a re-run, and still reports the coverage', async () => {
		const result = await scan([{ report: TIMED_OUT, exitCode: 1 }, { report: CLEAN }]);
		expect(result.code).toBe(1);
		expect(result.invocations).toHaveLength(1);
		expect(result.stdout).toContain(
			'Semgrep exited 1 (findings or a scan failure). Not re-running.'
		);
		expect(result.stdout).toContain(
			'::error file=apps/a.ts,line=12,title=Semgrep fixpoint timeout::'
		);
		expect(result.summary).toContain('## Semgrep scan coverage (first scan)');
	});

	it('fails on findings in the re-run', async () => {
		const result = await scan([{ report: TIMED_OUT }, { report: CLEAN, exitCode: 1 }]);
		expect(result.code).toBe(1);
		expect(result.invocations).toHaveLength(2);
		expect(result.stdout).toContain(
			'Semgrep exited 1 (findings or a scan failure). Not re-running.'
		);
	});

	it("keeps a crashed scan's exit code when it wrote no report", async () => {
		const result = await scan([{ report: null, exitCode: 7 }]);
		expect(result.code).toBe(7);
		expect(result.invocations).toHaveLength(1);
		expect(result.stdout).toContain('Semgrep exited 7');
	});

	it('fails closed, without a re-run, when a clean exit left no usable report', async () => {
		const result = await scan([{ report: null }, { report: CLEAN }]);
		expect(result.code).toBe(2);
		expect(result.invocations).toHaveLength(1);
		expect(result.stdout).toContain('::error title=Semgrep report unusable::');
	});

	it('is wired into the SAST job as a single-job scan', async () => {
		const workflow = await readFile(
			join(REPOSITORY_ROOT, '.github/workflows/security.yml'),
			'utf8'
		);
		const start = workflow.indexOf('- name: Semgrep scan');
		const end = workflow.indexOf('\n\n', start);
		const step = workflow.slice(start, end === -1 ? undefined : end);
		expect(step.split('\n').map((line) => line.trim())).toEqual([
			'- name: Semgrep scan',
			'run: >-',
			'bash scripts/check-semgrep-timeouts.sh --scan "$RUNNER_TEMP" --',
			'semgrep scan --error',
			'--jobs 1',
			'--config p/javascript',
			'--config p/typescript',
			'--config p/nodejs',
			'--config p/xss',
			'--config p/security-audit',
			'--config p/secrets',
			'--config .semgrep.yml',
		]);
	});
});
