import { expect, it } from 'vitest';
import {
	eligibleRun,
	assertVerification,
	FULL_JOBS,
	type Run,
	type Verification,
} from '../ci/reuse';
const run: Run = {
	id: 10,
	run_attempt: 2,
	head_sha: 'abc',
	head_branch: 'main',
	event: 'push',
	path: '.github/workflows/test.yml',
	status: 'completed',
	conclusion: 'success',
	created_at: new Date().toISOString(),
	html_url: 'https://github.com/example/repo/actions/runs/10',
};
const evidence: Verification = {
	version: 1,
	sha: 'abc',
	repository: 'example/repo',
	runId: '10',
	attempt: '2',
	full: true,
	expected: FULL_JOBS,
	results: Object.fromEntries(FULL_JOBS.map((job) => [job, 'success'])),
};
it('limits reuse to recent main push verification of the exact commit', () => {
	expect(eligibleRun(run, 'abc')).toBe(true);
	for (const patch of [
		{ head_sha: 'old' },
		{ event: 'pull_request' },
		{ head_branch: 'integration/test' },
		{ path: '.github/workflows/other.yml' },
		{ created_at: '2000-01-01' },
	])
		expect(eligibleRun({ ...run, ...patch }, 'abc')).toBe(false);
});
it('rejects stale attempts and incomplete, skipped or failed evidence', () => {
	expect(() => assertVerification(evidence, run, 'example/repo')).not.toThrow();
	for (const patch of [
		{ version: 0 },
		{ sha: 'old' },
		{ repository: 'fork/repo' },
		{ attempt: '1' },
		{ full: false },
		{ expected: FULL_JOBS.slice(1) },
		{ results: { ...evidence.results, 'test-web-merge': 'skipped' } },
	])
		expect(() => assertVerification({ ...evidence, ...patch }, run, 'example/repo')).toThrow();
});
