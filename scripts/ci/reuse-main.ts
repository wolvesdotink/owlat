import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { github, repository } from './github';
import { type Run, type Verification } from './reuse';
import { probeMainCI } from './reuse-probe';
const repo = repository(),
	sha = process.env['GITHUB_SHA'];
if (!sha || !process.env['GITHUB_OUTPUT']) throw new Error('Missing Actions context');
const result = await probeMainCI({
	repo,
	sha,
	now: Date.now,
	sleep: () => Bun.sleep(15_000),
	runs: () =>
		github<{ workflow_runs: Run[] }>(
			`repos/${repo}/actions/workflows/test.yml/runs?head_sha=${sha}&branch=main&event=push&per_page=20`
		).workflow_runs,
	current: (run) => github<Run>(`repos/${repo}/actions/runs/${run.id}`),
	evidence: (run) => {
		const artifacts = github<{ artifacts: { name: string; expired: boolean }[] }>(
			`repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`
		).artifacts;
		if (!artifacts.some((a) => a.name === 'ci-verification' && !a.expired))
			throw new Error('No current verification artifact');
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
				{ stdio: 'pipe', timeout: 60_000 }
			);
			return JSON.parse(readFileSync(join(directory, 'verification.json'), 'utf8')) as Verification;
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
});
appendFileSync(process.env['GITHUB_OUTPUT'], `reused=${Boolean(result.run)}\n`);
const summary = result.run
	? `Verified exact commit using [main CI attempt ${result.run.run_attempt}](${result.run.html_url}).\n`
	: `${result.reason}; full shared CI will run.\n`;
if (process.env['GITHUB_STEP_SUMMARY']) appendFileSync(process.env['GITHUB_STEP_SUMMARY'], summary);
process.stdout.write(summary);
