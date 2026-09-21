/**
 * Shape guards for everything this package accepts from outside the process:
 * the snapshot and diff-feed JSON an aggregator serves, and the text a
 * persistence adapter hands back.
 *
 * The signature is what makes a snapshot trustworthy, but a signature check
 * comes after the bytes have been read as a `SnapshotFile`, and a caller must
 * not be able to walk into a `TypeError` inside the verifier by serving `null`
 * where an array belongs. These guards are the layer that turns `unknown` into
 * the typed value the verifier and the store are allowed to assume.
 */

import type {
	DiffFeedEntry,
	SnapshotEntry,
	SnapshotFile,
	SubjectRef,
	Tier,
} from '@owlat/ostr-core';

/**
 * The five tier names, as a `Record<Tier, true>` rather than a `string[]`.
 *
 * The list is duplicated from the (unexported) `TIERS` in
 * `@owlat/ostr-core/distribution` — see the report note asking for it to be
 * exported. Until it is, the exhaustive record is the guard against silent
 * drift: adding a tier to `Tier` in core makes this object a type error here,
 * so a new tier cannot become "every snapshot carrying it is rejected" without
 * the build saying so. `src/__tests__/parse.test.ts` pins the same list against
 * core's own `parseDnsTierAnswer` at runtime.
 */
const TIER_NAMES: Readonly<Record<Tier, true>> = {
	unknown: true,
	establishing: true,
	trusted: true,
	warned: true,
	flagged: true,
};

/** True when `value` is one of the five tier names. */
export function isTier(value: unknown): value is Tier {
	return typeof value === 'string' && Object.hasOwn(TIER_NAMES, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

function isSubjectRef(value: unknown): value is SubjectRef {
	if (!isRecord(value)) return false;
	const domain = value['domain'];
	const ip = value['ip'];
	if (domain !== undefined && typeof domain !== 'string') return false;
	if (ip !== undefined && typeof ip !== 'string') return false;
	return isNonEmptyString(domain) || isNonEmptyString(ip);
}

export function isSnapshotEntry(value: unknown): value is SnapshotEntry {
	if (!isRecord(value)) return false;
	if (!isSubjectRef(value['subject'])) return false;
	if (!isTier(value['tier'])) return false;
	const score = value['score'];
	return typeof score === 'number' && Number.isInteger(score) && score >= 0 && score <= 100;
}

/**
 * A structural check. The contents of `heads` are carried through to the
 * signature verification, which is what actually attests to them — but the set
 * must not be *empty*: spec 08 §8.3 requires a snapshot to carry the as-of head
 * set, and a snapshot claiming to be scored against no log at all states no
 * coverage. Rejecting it here keeps `heads()` (and the `asof` rule of §8.1,
 * which reads the oldest head's timestamp) from having to answer for it.
 */
export function isSnapshotFile(value: unknown): value is SnapshotFile {
	if (!isRecord(value)) return false;
	if (value['v'] !== 1) return false;
	if (!isNonEmptyString(value['policy'])) return false;
	if (!isNonEmptyString(value['asOf'])) return false;
	if (!isNonEmptyString(value['sig'])) return false;
	const heads = value['heads'];
	if (!Array.isArray(heads) || heads.length === 0 || !heads.every(isRecord)) return false;
	const entries = value['entries'];
	return Array.isArray(entries) && entries.every(isSnapshotEntry);
}

export function isDiffFeedEntry(value: unknown): value is DiffFeedEntry {
	if (!isRecord(value)) return false;
	const seq = value['seq'];
	if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return false;
	if (!isNonEmptyString(value['asOf'])) return false;
	return isSnapshotEntry(value['entry']);
}

/**
 * The diff feed, from either shape an aggregator might serve: a bare array, or
 * an envelope `{ entries: [...] }`. Returns `null` when the payload is neither.
 */
export function parseDiffFeed(value: unknown): DiffFeedEntry[] | null {
	const list = Array.isArray(value) ? value : isRecord(value) ? value['entries'] : undefined;
	if (!Array.isArray(list)) return null;
	if (!list.every(isDiffFeedEntry)) return null;
	return list as DiffFeedEntry[];
}

/** The document a {@link SnapshotPersistence} adapter round-trips. */
export interface PersistedSnapshot {
	v: 1;
	snapshot: SnapshotFile;
	/** Diff-feed entries applied on top of `snapshot`, in ascending `seq`. */
	diffs: DiffFeedEntry[];
}

export function parsePersistedSnapshot(text: string): PersistedSnapshot | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(value) || value['v'] !== 1) return null;
	if (!isSnapshotFile(value['snapshot'])) return null;
	const diffs = value['diffs'];
	if (!Array.isArray(diffs) || !diffs.every(isDiffFeedEntry)) return null;
	return { v: 1, snapshot: value['snapshot'], diffs: diffs as DiffFeedEntry[] };
}
