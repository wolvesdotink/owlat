import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { arrayOf, boolean, object, string } from '../json';
import { github } from './github';
import { decodeRun, decodeWorkflowRuns, parseVerification } from './reuse';
import { probeMainCI } from './reuse-probe';

const decodeArtifacts = object({ artifacts: arrayOf(object({ name: string, expired: boolean })) });

/**
 * Trusted full main CI of exact commit `sha`, waited for while it runs. The
 * release pipeline's verify job and `release:push` share this lookup, so a
 * candidate tag is only pushed on the evidence the pipeline will accept.
 * Throws when trusted main CI of `sha` failed.
 */
export function findMainEvidence(repo: string, sha: string) {
	return probeMainCI({
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
}
