import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { github, repository } from './github';
import { assertVerification, eligibleRun, type Run, type Verification } from './reuse';
const repo = repository(),
	sha = process.env['GITHUB_SHA'];
if (!sha || !process.env['GITHUB_OUTPUT']) throw new Error('Missing Actions context');
const start = Date.now(),
	maxWait = 20 * 60 * 1000;
let reused = false;
while (Date.now() - start < maxWait) {
	const runs = github<{ workflow_runs: Run[] }>(
		`repos/${repo}/actions/workflows/test.yml/runs?head_sha=${sha}&branch=main&event=push&per_page=20`
	).workflow_runs;
	// The newest matching run controls the decision: never hide a new failure
	// behind an older green run for the same source revision.
	const run = runs
		.filter((candidate) => eligibleRun(candidate, sha))
		.sort((a, b) => b.id - a.id)[0];
	if (!run) {
		if (Date.now() - start >= 90_000) break;
	} else if (run.status === 'completed') {
		if (run.conclusion === 'cancelled' || run.conclusion === 'skipped') break;
		if (run.conclusion !== 'success') throw new Error(`Main CI failed: ${run.html_url}`);
		const artifacts = github<{ artifacts: { name: string; expired: boolean }[] }>(
			`repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`
		).artifacts;
		if (!artifacts.some((a) => a.name === 'ci-verification' && !a.expired)) break;
		const directory = mkdtempSync(join(tmpdir(), 'owlat-verify-'));
		try {
			execFileSync(
				'gh',
				[
					'run',
					'download',
					String(run.id),
					'--repo',
					repo,
					'--name',
					'ci-verification',
					'--dir',
					directory,
				],
				{ stdio: 'pipe' }
			);
			assertVerification(
				JSON.parse(readFileSync(join(directory, 'verification.json'), 'utf8')) as Verification,
				run,
				repo
			);
			// Reject a rerun started while evidence was being downloaded.
			const current = github<Run>(`repos/${repo}/actions/runs/${run.id}`);
			const newest = github<{ workflow_runs: Run[] }>(
				`repos/${repo}/actions/workflows/test.yml/runs?head_sha=${sha}&branch=main&event=push&per_page=20`
			)
				.workflow_runs.filter((candidate) => eligibleRun(candidate, sha))
				.sort((a, b) => b.id - a.id)[0];
			if (newest?.id !== run.id)
				throw new Error('A newer main verification appeared during lookup');

			if (
				current.status !== 'completed' ||
				current.conclusion !== 'success' ||
				current.run_attempt !== run.run_attempt
			)
				throw new Error('Main CI changed during verification lookup');
			appendFileSync(
				process.env['GITHUB_STEP_SUMMARY']!,
				`Verified exact commit using [main CI attempt ${run.run_attempt}](${run.html_url}).\n`
			);
			reused = true;
			break;
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
	await Bun.sleep(15_000);
}
appendFileSync(process.env['GITHUB_OUTPUT'], `reused=${reused}\n`);
if (!reused) process.stdout.write('No qualifying main evidence; full shared CI will run.\n');
