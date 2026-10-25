import { expect, it } from 'vitest';
import {
	eligibleRun,
	assertVerification,
	decodeRun,
	decodeWorkflowRuns,
	FULL_JOBS,
	parseVerification,
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

it('waits for running main CI up to 35 minutes but abandons absent runs at 90 seconds', async () => {
	const { mainDecision, MAIN_WAIT_MS } = await import('../ci/reuse-probe');
	expect(mainDecision(undefined, 89_999)).toBe('wait');
	expect(mainDecision(undefined, 90_000)).toBe('fallback');
	expect(mainDecision({ ...run, status: 'in_progress' }, 20 * 60_000)).toBe('wait');
	expect(mainDecision({ ...run, status: 'queued' }, MAIN_WAIT_MS)).toBe('fallback');
	for (const conclusion of ['failure', 'timed_out', 'action_required'])
		expect(mainDecision({ ...run, conclusion }, 0)).toBe('block');
	for (const conclusion of ['cancelled', 'skipped'])
		expect(mainDecision({ ...run, conclusion }, 0)).toBe('fallback');
});

it('falls back on uncertain evidence while blocking observed main failures', async () => {
	const { probeMainCI } = await import('../ci/reuse-probe');
	const probe = {
		repo: 'example/repo',
		sha: 'abc',
		runs: () => [run],
		current: () => run,
		evidence: () => evidence,
		now: Date.now,
		sleep: async () => {},
	};
	expect((await probeMainCI(probe)).run).toEqual(run);
	for (const patch of [
		{
			runs: () => {
				throw new Error('HTTP 403');
			},
		},
		{
			evidence: () => {
				throw new Error('artifact deleted');
			},
		},
		{ evidence: () => ({ ...evidence, attempt: '1' }) },
		{ current: () => ({ ...run, status: 'in_progress', run_attempt: 3 }) },
	])
		expect((await probeMainCI({ ...probe, ...patch })).run).toBeUndefined();
	let lookup = 0;
	expect(
		(await probeMainCI({ ...probe, runs: () => [lookup++ ? { ...run, id: 11 } : run] })).run
	).toBeUndefined();
	lookup = 0;
	await expect(
		probeMainCI({ ...probe, runs: () => [lookup++ ? { ...run, conclusion: 'failure' } : run] })
	).rejects.toThrow('Main CI failed');
	await expect(
		probeMainCI({ ...probe, runs: () => [{ ...run, conclusion: 'failure' }] })
	).rejects.toThrow('Main CI failed');
	await expect(
		probeMainCI({ ...probe, current: () => ({ ...run, conclusion: 'failure' }) })
	).rejects.toThrow('Main CI failed');
});

it('waits for the same running commit without launching duplicate verification', async () => {
	const { probeMainCI } = await import('../ci/reuse-probe');
	let now = Date.now(),
		polls = 0;
	const result = await probeMainCI({
		repo: 'example/repo',
		sha: 'abc',
		now: () => now,
		runs: () => [{ ...run, status: polls++ < 2 ? 'in_progress' : 'completed' }],
		current: () => run,
		evidence: () => evidence,
		sleep: async () => {
			now += 11 * 60_000;
		},
	});
	expect(result.run).toEqual(run);
	expect(polls).toBe(4);
});

it('reads verification evidence only in the shape the summary job writes', () => {
	const text = JSON.stringify(evidence);
	expect(parseVerification(text, 'verification.json')).toEqual(evidence);
	for (const [patch, message] of [
		[{ full: 'false' }, 'verification.json.full must be a boolean'],
		[{ version: '1' }, 'verification.json.version must be an integer'],
		[{ expected: FULL_JOBS.join(',') }, 'verification.json.expected must be an array'],
		[
			{ results: { detect: { result: 'success' } } },
			'verification.json.results.detect must be a string',
		],
		[{ runId: 10 }, 'verification.json.runId must be a string'],
	] as const)
		expect(() =>
			parseVerification(JSON.stringify({ ...evidence, ...patch }), 'verification.json')
		).toThrow(message);
});

it('never grants reuse from evidence of the wrong shape', async () => {
	const { probeMainCI } = await import('../ci/reuse-probe');
	// A string "false" is truthy: read through a cast, it passed the full-run check.
	const text = JSON.stringify({ ...evidence, full: 'false' });
	const result = await probeMainCI({
		repo: 'example/repo',
		sha: 'abc',
		runs: () => [run],
		current: () => run,
		evidence: () => parseVerification(text, 'verification.json'),
		now: Date.now,
		sleep: async () => {},
	});
	expect(result).toEqual({ reason: 'Verification evidence unavailable' });
});

it('reads workflow runs, a branchless run included, and refuses a malformed one', () => {
	const page = { total_count: 2, workflow_runs: [run, { ...run, id: 11, head_branch: null }] };
	expect(decodeWorkflowRuns(page, 'runs').map((r) => r.head_branch)).toEqual(['main', null]);
	expect(decodeRun({ ...run, extra: 1 }, 'run')).toMatchObject(run);
	expect(() => decodeWorkflowRuns({ workflow_runs: [{ ...run, id: '10' }] }, 'runs')).toThrow(
		'runs.workflow_runs[0].id must be an integer'
	);
	expect(() => decodeWorkflowRuns([run], 'runs')).toThrow('runs must be an object');
	expect(() => decodeRun({ ...run, conclusion: undefined }, 'run')).toThrow(
		'run.conclusion must be a string'
	);
});
