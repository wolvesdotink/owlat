import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { arrayOf, boolean, object, string } from '../json';
import { github, repository } from './github';
import { decodeRun, decodeWorkflowRuns, parseVerification } from './reuse';
import { probeMainCI } from './reuse-probe';
const repo = repository(),
	sha = process.env['GITHUB_SHA'];
if (!sha || !process.env['GITHUB_OUTPUT']) throw new Error('Missing Actions context');
const decodeArtifacts = object({ artifacts: arrayOf(object({ name: string, expired: boolean })) });
const result = await probeMainCI({
	repo,
	sha,
	now: Date.now,
	sleep: () => Bun.sleep(15_000),
	runs: () =>
		github(
			`repos/${repo}/actions/workflows/test.yml/runs?head_sha=${sha}&branch=main&event=push&per_page=20`,
			decodeWorkflowRuns
		),
	current: (run) => github(`repos/${repo}/actions/runs/${run.id}`, decodeRun),
	evidence: (run) => {
		const { artifacts } = github(
			`repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`,
			decodeArtifacts
		);
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
			const file = join(directory, 'verification.json');
			return parseVerification(readFileSync(file, 'utf8'), 'verification.json');
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
