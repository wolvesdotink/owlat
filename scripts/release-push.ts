/**
 * Push a release candidate: its commit to main first, the tag only once main
 * CI of that exact commit has passed.
 *
 *   bun run release:push vX.Y.Z-rc.N
 *
 * The pipeline's verify job (.github/workflows/_verify.yml) accepts only full
 * main CI of the tagged commit, and waits for it when the tag arrives first.
 * Waiting here instead keeps that wait off the release run, and a commit whose
 * main CI fails never gets a tag that would have to be deleted. The check is
 * the pipeline's own (scripts/ci/main-evidence.ts), which runs again on the
 * tag, so nothing is skipped. Needs `gh` signed in with read access.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { repository } from './ci/github';
import { findMainEvidence } from './ci/main-evidence';
import type { Run } from './ci/reuse';

interface PushDeps {
	git: (...args: string[]) => string;
	/** Throws when trusted main CI of `sha` failed. */
	evidence: (sha: string) => Promise<{ run?: Run; reason?: string }>;
}

export async function pushCandidate(
	tag: string,
	deps: PushDeps
): Promise<{ pushed: true; run: Run } | { pushed: false; reason: string }> {
	const sha = deps.git('rev-parse', `refs/tags/${tag}^{commit}`);
	// push.followTags would publish the annotated tag along with its commit.
	deps.git('push', '--no-follow-tags', 'origin', `${sha}:refs/heads/main`);
	const result = await deps.evidence(sha);
	if (!result.run) return { pushed: false, reason: result.reason ?? 'No main CI evidence' };
	deps.git('push', 'origin', `refs/tags/${tag}`);
	return { pushed: true, run: result.run };
}

export function defaultPushDeps(): PushDeps {
	const repo = repository();
	const root = join(import.meta.dir, '..');
	return {
		git: (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(),
		evidence: (sha) => findMainEvidence(repo, sha),
	};
}

/** Pushes `tag` as `pushCandidate` does and reports the outcome; exits 1 when the tag stayed local. */
export async function pushCandidateCli(tag: string): Promise<void> {
	console.info(`Pushing ${tag}'s commit to main and waiting for its main CI (up to 35 minutes)…`);
	try {
		const result = await pushCandidate(tag, defaultPushDeps());
		if (result.pushed) {
			console.info(`Main CI passed: ${result.run.html_url}`);
			console.info(`Pushed ${tag} — the release pipeline is now building the candidate:`);
			console.info(`  https://github.com/wolvesdotink/owlat/actions/workflows/release.yml`);
			return;
		}
		console.error(`\nrelease: ${result.reason}; ${tag} was not pushed.`);
		console.error(`Once main CI of its commit is green, run: bun run release:push ${tag}`);
		console.error(`(Pushing the tag directly works too; the pipeline then runs full CI itself.)`);
	} catch (error) {
		console.error(`\nrelease: ${error instanceof Error ? error.message : String(error)}`);
		console.error(`${tag} was not pushed. If a rerun of main CI passes, run`);
		console.error(
			`bun run release:push ${tag} again; if main needs a fix, cut the next candidate after it.`
		);
	}
	process.exit(1);
}

if (import.meta.main) {
	const tag = process.argv[2];
	if (!tag || process.argv.length !== 3) {
		console.error('usage: bun run release:push vX.Y.Z-rc.N');
		process.exit(1);
	}
	await pushCandidateCli(tag);
}
