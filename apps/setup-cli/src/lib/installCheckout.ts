/**
 * Which release the git checkout in the install directory holds, read from the
 * files under `.git` alone: the setup image that runs doctor has no `git`.
 *
 * Only what those files state plainly is used: `HEAD`, loose refs, and
 * `packed-refs` with its peeled (`^<commit>`) lines, which is what the
 * installer's `git clone --depth 1 --branch v<version>` leaves. A tag whose
 * object would have to be read out of a pack to find its commit stays unknown
 * rather than guessed, so a checkout moved by hand is never misreported.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
	isReleaseVersion,
	parseVersionRecordVersion,
	VERSION_RECORD_FILE,
} from '@owlat/shared/installVersionRecord';
import type { DoctorFinding } from './doctorReport';
import { doctorText } from './doctorText';

const SHA = /^[0-9a-f]{40}$/;

export interface InstallCheckout {
	/** The commit `HEAD` names. */
	head: string;
	/** Tags known to point at `head`, without the `refs/tags/` prefix. */
	tagsAtHead: string[];
	/**
	 * The commit each tag points at, where the files say it: packed tags (peeled
	 * when annotated) and loose tags whose ref holds `head` itself.
	 */
	tagCommits: Map<string, string>;
	/** Loose tags whose commit cannot be read without unpacking the object. */
	unresolvedTags: Set<string>;
}

async function readText(path: string): Promise<string | null> {
	return readFile(path, 'utf-8').catch(() => null);
}

interface PackedRef {
	ref: string;
	commit: string;
}

/** `packed-refs` entries, with an annotated tag resolved to its peeled commit. */
function parsePackedRefs(text: string): PackedRef[] {
	const refs: PackedRef[] = [];
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (line === '' || line.startsWith('#')) continue;
		if (line.startsWith('^')) {
			const peeled = line.slice(1);
			const last = refs.at(-1);
			if (last && SHA.test(peeled)) last.commit = peeled;
			continue;
		}
		const [sha, ref] = line.split(' ');
		if (sha && ref && SHA.test(sha)) refs.push({ ref, commit: sha });
	}
	return refs;
}

async function looseTags(gitDir: string, prefix = ''): Promise<Array<[string, string]>> {
	const dir = join(gitDir, 'refs', 'tags', prefix);
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const tags: Array<[string, string]> = [];
	for (const entry of entries) {
		const name = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			tags.push(...(await looseTags(gitDir, name)));
		} else {
			const sha = (await readText(join(dir, entry.name)))?.trim() ?? '';
			if (SHA.test(sha)) tags.push([name, sha]);
		}
	}
	return tags;
}

/**
 * The checkout in `dir`, or null when `dir` holds no `.git` directory this can
 * read (a tarball install, a linked worktree, a detached `HEAD` it cannot
 * resolve).
 */
export async function readInstallCheckout(dir: string): Promise<InstallCheckout | null> {
	const gitDir = join(dir, '.git');
	const headText = (await readText(join(gitDir, 'HEAD')))?.trim();
	if (!headText) return null;

	const packed = parsePackedRefs((await readText(join(gitDir, 'packed-refs'))) ?? '');
	let head: string | undefined;
	if (SHA.test(headText)) {
		head = headText;
	} else if (headText.startsWith('ref: ')) {
		const ref = headText.slice('ref: '.length);
		const loose = (await readText(join(gitDir, ref)))?.trim();
		head = loose && SHA.test(loose) ? loose : packed.find((p) => p.ref === ref)?.commit;
	}
	if (!head) return null;

	const tagCommits = new Map<string, string>();
	for (const { ref, commit } of packed) {
		if (ref.startsWith('refs/tags/')) tagCommits.set(ref.slice('refs/tags/'.length), commit);
	}
	// A loose ref replaces a packed one of the same name. Holding `head` itself
	// it is a lightweight tag of the checked-out commit; anything else may be
	// an annotated tag object, whose commit is not in the ref.
	const unresolvedTags = new Set<string>();
	for (const [tag, sha] of await looseTags(gitDir)) {
		if (sha === head) {
			tagCommits.set(tag, sha);
		} else {
			tagCommits.delete(tag);
			unresolvedTags.add(tag);
		}
	}

	const tagsAtHead = [...tagCommits]
		.filter(([, commit]) => commit === head)
		.map(([tag]) => tag)
		.sort();
	return { head, tagsAtHead, tagCommits, unresolvedTags };
}

export type CheckoutComparison =
	| { kind: 'matches' }
	/** The checkout is provably not at `tag`; `at` names what it is at. */
	| { kind: 'differs'; at: string[]; head: string }
	/** Nothing in `.git` says whether the checkout is at `tag`. */
	| { kind: 'unknown'; head: string };

/** Whether `checkout` is at the release tag `tag`. */
export function compareCheckout(checkout: InstallCheckout, tag: string): CheckoutComparison {
	const { head, tagsAtHead } = checkout;
	if (tagsAtHead.includes(tag)) return { kind: 'matches' };
	if (checkout.unresolvedTags.has(tag)) return { kind: 'unknown', head };
	const commit = checkout.tagCommits.get(tag);
	if (tagsAtHead.length > 0 || (commit !== undefined && commit !== head)) {
		return { kind: 'differs', at: tagsAtHead, head };
	}
	return { kind: 'unknown', head };
}

const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Doctor's `version.source` finding: whether the source tree in the install
 * directory is the release `.env` says runs. Null when there is nothing to
 * compare: no release pinned (a `dev` stack runs this very tree), or no
 * checkout to read.
 */
export async function evaluateSourceCheckout(
	owlatDir: string,
	configuredVersion: string
): Promise<DoctorFinding | null> {
	if (!isReleaseVersion(configuredVersion)) return null;
	const checkout = await readInstallCheckout(owlatDir);
	if (!checkout) return null;

	const tag = `v${configuredVersion}`;
	const commit = checkout.head.slice(0, 12);
	const comparison = compareCheckout(checkout, tag);
	if (comparison.kind === 'matches') {
		return {
			check: 'version.source',
			ok: true,
			message: doctorText`The source tree in the install directory is ${tag}, the release that runs`,
		};
	}
	if (comparison.kind === 'unknown') {
		return {
			check: 'version.source',
			ok: true,
			message: doctorText`${tag} runs; the source tree in the install directory is at commit ${commit}, which doctor cannot match to a release`,
		};
	}
	const releaseTags = comparison.at.filter((name) => RELEASE_TAG.test(name));
	const at = releaseTags.length > 0 ? releaseTags.join(', ') : doctorText`commit ${commit}`;
	return {
		check: 'version.source',
		ok: false,
		message: doctorText`The source tree in the install directory is ${at}, but ${tag} runs: updates replace docker-compose.yml and .env, not the checkout. Read the running source at https://github.com/wolvesdotink/owlat/tree/${tag}.`,
	};
}

/**
 * Doctor's `version.record` finding: a VERSION file that names another release
 * than `.env` pins, which a manual update leaves behind. Null when there is no
 * file, or nothing to compare it with.
 */
export async function evaluateVersionRecord(
	owlatDir: string,
	configuredVersion: string
): Promise<DoctorFinding | null> {
	if (!isReleaseVersion(configuredVersion)) return null;
	const text = await readText(join(owlatDir, VERSION_RECORD_FILE));
	if (text === null) return null;
	const recorded = parseVersionRecordVersion(text);
	if (recorded === configuredVersion) {
		return {
			check: 'version.record',
			ok: true,
			message: doctorText`VERSION names ${configuredVersion}, as .env does`,
		};
	}
	return {
		check: 'version.record',
		ok: false,
		message: doctorText`VERSION in the install directory names ${recorded ?? 'no version'}, but .env pins ${configuredVersion}. Updates through the app or \`owlat upgrade\` rewrite it; after a manual update, set its version= and tag= lines to the release that runs.`,
	};
}
