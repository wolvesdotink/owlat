/**
 * Which unified release tags exist, what each one may do, and when a stable
 * tag may be published.
 *
 * Unified tags come in three kinds:
 *   - `vX.Y.Z`        stable: claims GitHub's "latest" release, the image
 *                      aliases, the installer and every updater default;
 *   - `vX.Y.Z-rc.N`   release candidate: runs the whole pipeline (verify,
 *                      server images, desktop apps, install gates, the update
 *                      flow) and publishes a prerelease that no default reaches;
 *   - `vX.Y.Z-<pre>`  any other prerelease: published like a candidate, but it
 *                      can never be promoted.
 *
 * A stable tag is only published from the commit of the newest candidate of
 * the same version, after that candidate's release run succeeded. Nothing is
 * rebuilt from a different tree than the one that was tested; the stable run
 * rebuilds the artifacts only so they carry the stable version and signatures.
 */
import type { Run } from './reuse';

type ReleaseChannel = 'stable' | 'rc' | 'prerelease';

interface ReleaseTag {
	tag: string;
	/** The tag without its leading `v`. */
	version: string;
	/** The `X.Y.Z` the tag releases or is a candidate for. */
	base: string;
	channel: ReleaseChannel;
	/** The candidate number N of `-rc.N`; only set for `rc`. */
	rc?: number;
}

const NUMBER = '(0|[1-9]\\d*)';
const TAG_RE = new RegExp(
	`^v(${NUMBER}\\.${NUMBER}\\.${NUMBER})(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$`
);
const RC_RE = /^rc\.([1-9]\d*)$/;

/** Classify a unified release tag; null for anything else (`server-v*`, junk). */
export function classifyReleaseTag(tag: string): ReleaseTag | null {
	const match = TAG_RE.exec(tag);
	if (!match) return null;
	const base = match[1]!;
	const numbers = [match[2], match[3], match[4]].map(Number);
	if (!numbers.every(Number.isSafeInteger)) return null;
	const pre = match[5];
	if (pre === undefined) return { tag, version: base, base, channel: 'stable' };
	const rc = RC_RE.exec(pre);
	if (rc && Number.isSafeInteger(Number(rc[1])))
		return { tag, version: `${base}-${pre}`, base, channel: 'rc', rc: Number(rc[1]) };
	return { tag, version: `${base}-${pre}`, base, channel: 'prerelease' };
}

/** The candidate tags of `base`, newest first. */
export function candidatesOf(base: string, tags: readonly string[]): ReleaseTag[] {
	return tags
		.map(classifyReleaseTag)
		.filter((tag): tag is ReleaseTag => tag?.channel === 'rc' && tag.base === base)
		.sort((a, b) => b.rc! - a.rc!);
}

/** The tag the next candidate of `base` gets: one past the highest that exists. */
export function nextCandidateTag(base: string, tags: readonly string[]): string {
	return `v${base}-rc.${(candidatesOf(base, tags)[0]?.rc ?? 0) + 1}`;
}

/**
 * The Windows Installer version of a desktop build. MSI accepts only
 * `major.minor.patch[.build]` with numeric fields, so Tauri refuses a
 * prerelease version such as `0.7.0-rc.1` for the msi target. A prerelease
 * gets its trailing number as the fourth field (`0.7.0.1`); a stable version
 * returns null and Tauri derives the installer version itself.
 */
export function msiVersion(version: string): string | null {
	const parsed = classifyReleaseTag(`v${version}`);
	if (!parsed) throw new Error(`Invalid release version: ${version}`);
	if (parsed.channel === 'stable') return null;
	const [major, minor] = parsed.base.split('.').map(Number);
	if (major! > 255 || minor! > 255) throw new Error(`MSI cannot version ${version}`);
	const last = /(?:^|\.)(\d+)$/.exec(parsed.version.slice(parsed.base.length + 1))?.[1];
	const build = last === undefined ? 0 : Number(last);
	if (build > 65535) throw new Error(`MSI cannot version ${version}`);
	return `${parsed.base}.${build}`;
}

/** One candidate of the version being promoted, with what GitHub knows about it. */
export interface CandidateEvidence {
	tag: string;
	/** The commit the tag peels to (never the annotated tag object). */
	commit: string;
	/** Its GitHub release; null when none is published (drafts are invisible). */
	release: { draft: boolean; prerelease: boolean } | null;
	/** release.yml runs on `commit`; the newest run for the tag decides. */
	runs: Run[];
}

type PromotionResult = { ok: true; candidate: string; run: Run } | { ok: false; reason: string };

/**
 * Whether `stableTag` may be published at `commit`. The newest candidate of
 * the version must peel to that commit, be published as a prerelease, and its
 * newest release.yml run (latest attempt) must have completed successfully. An
 * older candidate is never promoted past a newer one, failed or not: cut
 * another candidate instead.
 */
export function checkPromotion(
	stableTag: string,
	commit: string,
	candidates: readonly CandidateEvidence[]
): PromotionResult {
	const stable = classifyReleaseTag(stableTag);
	if (stable?.channel !== 'stable')
		return { ok: false, reason: `${stableTag} is not a stable tag` };
	const newest = candidatesOf(
		stable.base,
		candidates.map((candidate) => candidate.tag)
	)[0];
	if (!newest)
		return {
			ok: false,
			reason: `${stableTag} has no release candidate; cut one with \`bun run release:cut\` first`,
		};
	const evidence = candidates.find((candidate) => candidate.tag === newest.tag)!;
	if (evidence.commit !== commit)
		return {
			ok: false,
			reason: `${stableTag} must point at ${newest.tag}'s commit ${evidence.commit}, not ${commit}`,
		};
	if (!evidence.release || evidence.release.draft)
		return { ok: false, reason: `${newest.tag} has no published GitHub release` };
	if (!evidence.release.prerelease)
		return { ok: false, reason: `${newest.tag} is not published as a prerelease` };
	const run = evidence.runs
		.filter(
			(run) =>
				run.head_branch === newest.tag &&
				run.head_sha === commit &&
				run.event === 'push' &&
				run.path.startsWith('.github/workflows/release.yml')
		)
		.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)[0];
	if (!run) return { ok: false, reason: `${newest.tag} has no release run on ${commit}` };
	if (run.status !== 'completed')
		return { ok: false, reason: `${newest.tag}'s release run is still ${run.status}` };
	if (run.conclusion !== 'success')
		return {
			ok: false,
			reason: `${newest.tag}'s release run concluded ${run.conclusion ?? 'without a result'}: ${run.html_url}`,
		};
	return { ok: true, candidate: newest.tag, run };
}
