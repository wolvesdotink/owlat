/**
 * Publish a release candidate as the stable release: create the annotated
 * `vX.Y.Z` tag on the candidate's own commit. Nothing is committed: the
 * candidate was cut from a commit that already holds X.Y.Z, its notes and its
 * schema snapshot (scripts/release.ts).
 *
 *   bun run release:promote vX.Y.Z-rc.N [--push] [--dry-run]
 *
 * Runs the same check release.yml runs on the stable tag
 * (scripts/ci/release-policy.ts): the candidate is the newest of its version,
 * is published as a prerelease, and its release run succeeded on that commit.
 * Needs `gh` signed in with read access to the repository.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { repository } from './ci/github';
import { candidateEvidence, fileAt, peeledCommit, preparedVersion } from './ci/release-evidence';
import { checkPromotion, classifyReleaseTag } from './ci/release-policy';
import { changelogSection } from './release-body';

const ROOT = join(import.meta.dir, '..');

function git(...args: string[]): string {
	return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function fail(message: string): never {
	console.error(`\nrelease: ${message}`);
	process.exit(1);
}

const rawArgs = process.argv.slice(2);
const flags = new Set(rawArgs.filter((a) => a.startsWith('--')));
for (const flag of flags) {
	if (!['--push', '--dry-run'].includes(flag)) fail(`unknown flag ${flag}`);
}
const request = rawArgs.find((a) => !a.startsWith('--'));
const candidate = request ? classifyReleaseTag(`v${request.replace(/^v/, '')}`) : null;
if (candidate?.channel !== 'rc')
	fail('usage: bun run release:promote vX.Y.Z-rc.N [--push] [--dry-run]');
const stableTag = `v${candidate.base}`;

git('fetch', 'origin', '--tags');
if (git('tag', '--list', stableTag) !== '') fail(`${stableTag} already exists`);
if (git('tag', '--list', candidate.tag) === '') fail(`${candidate.tag} does not exist`);
const commit = peeledCommit(ROOT, `refs/tags/${candidate.tag}`);
const prepared = preparedVersion(ROOT, commit);
if (prepared !== candidate.base)
	fail(`${candidate.tag}'s commit is prepared for ${prepared}, not ${candidate.base}`);
if (!changelogSection(fileAt(ROOT, commit, 'CHANGELOG.md'), candidate.base))
	fail(`${candidate.tag}'s commit has no CHANGELOG section for ${candidate.base}`);

const result = checkPromotion(
	stableTag,
	commit,
	candidateEvidence(ROOT, repository(), candidate.base)
);
if (!result.ok) fail(result.reason);
if (result.candidate !== candidate.tag)
	fail(`${result.candidate} is the newest candidate of ${candidate.base}; promote that one`);
console.info(`${candidate.tag} passed its release run: ${result.run.html_url}`);

if (flags.has('--dry-run')) {
	console.info(`[dry-run] Would tag ${stableTag} at ${commit}.`);
	process.exit(0);
}
git('tag', '-a', stableTag, '-m', `Owlat ${stableTag}`, commit);
console.info(`Tagged ${stableTag} at ${commit} (${candidate.tag}).`);
if (flags.has('--push')) {
	git('push', 'origin', `refs/tags/${stableTag}`);
	console.info(`Pushed ${stableTag} — the release pipeline is now publishing it:`);
	console.info(`  https://github.com/wolvesdotink/owlat/actions/workflows/release.yml`);
} else {
	console.info(`To publish it:\n  git push origin ${stableTag}`);
}
