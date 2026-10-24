/**
 * release.yml's first step: classify the pushed tag and refuse a tag the
 * release policy (./release-policy.ts) does not allow.
 *
 * Writes `version` (the tag without `v`) and `channel` (stable | rc |
 * prerelease) to GITHUB_OUTPUT. A candidate must sit on a prepared commit (the
 * root package.json already holds its base version), so promoting it later
 * needs no new commit. A stable tag must point at the commit of its newest
 * candidate, whose release run succeeded.
 */
import { appendFileSync } from 'node:fs';
import { repository } from './github';
import { candidateEvidence, peeledCommit, preparedVersion } from './release-evidence';
import { checkPromotion, classifyReleaseTag } from './release-policy';

const tag = process.env['TAG'] ?? '',
	sha = process.env['GITHUB_SHA'] ?? '',
	output = process.env['GITHUB_OUTPUT'];
if (!output || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('Missing Actions context');
const parsed = classifyReleaseTag(tag);
if (!parsed) throw new Error(`${tag} is not a unified release tag (vX.Y.Z or vX.Y.Z-<pre>)`);
const root = process.cwd();
const lines: string[] = [];
// The pushed tag, not the run's SHA, names the commit under test.
if (peeledCommit(root, `refs/tags/${tag}`) !== sha)
	throw new Error(`${tag} no longer points at ${sha}; it was moved after the push`);

if (parsed.channel !== 'prerelease') {
	const prepared = preparedVersion(root, sha);
	if (prepared !== parsed.base)
		throw new Error(
			`${tag} is on a commit prepared for ${prepared}, not ${parsed.base}; cut it with \`bun run release:cut\``
		);
}
if (parsed.channel === 'stable') {
	const result = checkPromotion(tag, sha, candidateEvidence(root, repository(), parsed.base));
	if (!result.ok) throw new Error(result.reason);
	lines.push(
		`Promoting ${result.candidate} to ${tag}: its [release run](${result.run.html_url}) succeeded on this commit.`
	);
} else {
	lines.push(
		`${tag} is a ${parsed.channel === 'rc' ? 'release candidate' : 'prerelease'}: it publishes a prerelease and moves no alias.`
	);
}

appendFileSync(output, `version=${parsed.version}\nchannel=${parsed.channel}\n`);
const summary = `${lines.join('\n')}\n`;
if (process.env['GITHUB_STEP_SUMMARY']) appendFileSync(process.env['GITHUB_STEP_SUMMARY'], summary);
process.stdout.write(summary);
