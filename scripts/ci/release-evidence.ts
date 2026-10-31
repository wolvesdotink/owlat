import { execFileSync } from 'node:child_process';
import { boolean, object } from '../json';
import { parsePackageManifest, requiredVersion } from '../package-manifest';
import { github } from './github';
import { decodeWorkflowRuns } from './reuse';
import { candidatesOf, type CandidateEvidence } from './release-policy';

const decodeReleaseState = object({ draft: boolean, prerelease: boolean });

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** The commit `ref` peels to; an annotated tag resolves through its tag object. */
export function peeledCommit(cwd: string, ref: string): string {
	return git(cwd, 'rev-parse', '--verify', `${ref}^{commit}`);
}

/** `path` as committed at `commit`, e.g. the root package.json of a candidate. */
export function fileAt(cwd: string, commit: string, path: string): string {
	return git(cwd, 'show', `${commit}:${path}`);
}

/** The version field of the root package.json at `commit`. */
export function preparedVersion(cwd: string, commit: string): string {
	const label = `${commit}:package.json`;
	return requiredVersion(parsePackageManifest(fileAt(cwd, commit, 'package.json'), label), label);
}

/**
 * Every candidate tag of `base` in the local clone (fetch tags first), with
 * its peeled commit, its published GitHub release and its release.yml runs.
 */
export function candidateEvidence(cwd: string, repo: string, base: string): CandidateEvidence[] {
	const tags = git(cwd, 'tag', '--list', `v${base}-rc.*`).split('\n').filter(Boolean);
	return candidatesOf(base, tags).map(({ tag }) => {
		const commit = peeledCommit(cwd, `refs/tags/${tag}`);
		let release: CandidateEvidence['release'] = null;
		try {
			release = github(`repos/${repo}/releases/tags/${tag}`, decodeReleaseState);
		} catch (error) {
			// Only "no such release" means unpublished; anything else must not
			// read as an answer.
			if (!/HTTP 404/.test(String(error))) throw error;
		}
		const runs = github(
			`repos/${repo}/actions/workflows/release.yml/runs?head_sha=${commit}&event=push&per_page=100`,
			decodeWorkflowRuns
		);
		return { tag, commit, release, runs };
	});
}
