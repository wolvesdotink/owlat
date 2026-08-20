/**
 * Re-hydration of persisted rows, with the shape checks the type system cannot
 * make.
 *
 * Everything the store reads back was written by this process — but "was" is
 * doing a lot of work: the file outlives the process, an operator can edit it,
 * a downgrade can leave a row a newer policy wrote, and a half-restored backup
 * is a normal way for a database to become inconsistent. A bare
 * `JSON.parse(...) as SnapshotFile` would carry any of those straight into a
 * signed snapshot and into the DNS zone, so each value is checked here instead:
 * an out-of-vocabulary tier or a malformed explanation fails loudly, at the
 * read, naming the row.
 *
 * The materialized view is a pure function of the log, so failing loudly costs
 * an operator one `rm` and one refresh — much less than publishing a signed
 * artifact derived from a corrupt row.
 */

import { isRfc3339, isSha256Hex } from '@owlat/ostr-core';
import { STH_SIGNATURE_TYPE } from '@owlat/ostr-core/merkle';
import type {
	ExplanationGroup,
	LogEntryRef,
	SignedTreeHead,
	SnapshotEntry,
	SnapshotFile,
	SubjectRef,
	Tier,
} from '@owlat/ostr-core';

/**
 * The tier vocabulary, as an exhaustive map over the union: adding a tier to
 * `@owlat/ostr-core` breaks this file at compile time rather than silently
 * leaving the new tier unaccepted here and rejected by the SQL constraint.
 */
const TIERS: Readonly<Record<Tier, true>> = Object.freeze({
	unknown: true,
	establishing: true,
	trusted: true,
	warned: true,
	flagged: true,
});

/** The tier vocabulary as SQL literals, so the schema constraint cannot drift from the type. */
export const TIER_SQL_LIST: string = Object.keys(TIERS)
	.map((tier) => `'${tier}'`)
	.join(', ');

export function isTier(value: unknown): value is Tier {
	return typeof value === 'string' && Object.hasOwn(TIERS, value);
}

/** Thrown when a persisted row cannot be read back as the type it was written as. */
export class StoreCorruptionError extends Error {
	constructor(what: string, detail: string) {
		super(`aggregator store: ${what} is corrupt (${detail}); delete the view and refresh`);
		this.name = 'StoreCorruptionError';
	}
}

function corrupt(what: string, detail: string): never {
	throw new StoreCorruptionError(what, detail);
}

function parseJson(what: string, text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		return corrupt(what, error instanceof Error ? error.message : 'unparseable JSON');
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkTier(what: string, value: unknown): Tier {
	return isTier(value) ? value : corrupt(what, `unknown tier ${JSON.stringify(value)}`);
}

function checkScore(what: string, value: unknown): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
		corrupt(what, `score ${JSON.stringify(value)} is not an integer in [0, 100]`);
	}
	return value;
}

function checkSubject(what: string, value: unknown): SubjectRef {
	if (!isRecord(value)) corrupt(what, 'subject is not an object');
	const subject: SubjectRef = {};
	const domain = value['domain'];
	const ip = value['ip'];
	if (domain !== undefined) {
		if (typeof domain !== 'string') corrupt(what, 'subject.domain is not a string');
		subject.domain = domain;
	}
	if (ip !== undefined) {
		if (typeof ip !== 'string') corrupt(what, 'subject.ip is not a string');
		subject.ip = ip;
	}
	return subject;
}

/** A stored tier, checked against the vocabulary. */
export function hydrateTier(key: string, value: unknown): Tier {
	return checkTier(`tier of ${key}`, value);
}

function checkEvidence(what: string, value: unknown): LogEntryRef[] {
	if (!Array.isArray(value)) corrupt(what, 'evidence is not an array');
	return value.map((ref): LogEntryRef => {
		if (!isRecord(ref)) corrupt(what, 'evidence ref is not an object');
		const logId = ref['logId'];
		const index = ref['index'];
		if (typeof logId !== 'string') corrupt(what, 'evidence ref has no logId');
		if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
			corrupt(what, 'evidence ref has no log index');
		}
		return { logId, index };
	});
}

/** A stored score explanation. */
export function hydrateExplanation(key: string, text: string): ExplanationGroup[] {
	const what = `explanation of ${key}`;
	const parsed = parseJson(what, text);
	if (!Array.isArray(parsed)) corrupt(what, 'not an array');
	return parsed.map((group): ExplanationGroup => {
		if (!isRecord(group)) corrupt(what, 'group is not an object');
		const signal = group['signal'];
		const contribution = group['contribution'];
		const summary = group['summary'];
		if (typeof signal !== 'string') corrupt(what, 'group.signal is not a string');
		if (typeof contribution !== 'number' || !Number.isFinite(contribution)) {
			corrupt(what, 'group.contribution is not a finite number');
		}
		if (typeof summary !== 'string') corrupt(what, 'group.summary is not a string');
		return { signal, contribution, summary, evidence: checkEvidence(what, group['evidence']) };
	});
}

function checkSnapshotEntry(what: string, value: unknown): SnapshotEntry {
	if (!isRecord(value)) corrupt(what, 'entry is not an object');
	return {
		subject: checkSubject(what, value['subject']),
		tier: checkTier(what, value['tier']),
		score: checkScore(what, value['score']),
	};
}

/** A stored diff-feed line's entry. */
export function hydrateDiffEntry(seq: number, text: string): SnapshotEntry {
	return checkSnapshotEntry(`diff feed line ${seq}`, parseJson(`diff feed line ${seq}`, text));
}

function checkHead(what: string, value: unknown): SignedTreeHead {
	if (!isRecord(value)) corrupt(what, 'head is not an object');
	const logId = value['logId'];
	const treeSize = value['treeSize'];
	const rootHash = value['rootHash'];
	const timestamp = value['timestamp'];
	const sig = value['sig'];
	if (value['v'] !== 1) corrupt(what, 'head has an unsupported version');
	if (value['type'] !== STH_SIGNATURE_TYPE) corrupt(what, 'head is not an STH');
	if (typeof logId !== 'string' || logId === '') corrupt(what, 'head has no logId');
	if (typeof treeSize !== 'number' || !Number.isSafeInteger(treeSize) || treeSize < 0) {
		corrupt(what, 'head has no tree size');
	}
	if (!isSha256Hex(rootHash)) corrupt(what, 'head has no root hash');
	if (!isRfc3339(timestamp)) corrupt(what, 'head has no RFC 3339 timestamp');
	if (typeof sig !== 'string') corrupt(what, 'head has no signature');
	return { v: 1, type: STH_SIGNATURE_TYPE, logId, treeSize, rootHash, timestamp, sig };
}

/**
 * The as-of head set of a persisted snapshot, shape-checked. Signatures are not
 * re-verified here: an STH is the *log's* signature, checked by whoever holds
 * the log's key, and this layer holds only the aggregator's.
 */
export function hydrateHeads(what: string, text: string): SignedTreeHead[] {
	const parsed = parseJson(what, text);
	if (!Array.isArray(parsed)) corrupt(what, 'heads is not an array');
	return parsed.map((head) => checkHead(what, head));
}

/**
 * The persisted snapshot. Only the shape is checked, never the signature: the
 * signature is the consumer's check, and re-verifying it here would need the
 * public key the aggregator signs with, which this layer does not hold.
 */
export function hydrateSnapshot(text: string): SnapshotFile {
	const what = 'snapshot';
	const parsed = parseJson(what, text);
	if (!isRecord(parsed)) corrupt(what, 'not an object');
	if (parsed['v'] !== 1) corrupt(what, `unsupported version ${JSON.stringify(parsed['v'])}`);
	const policy = parsed['policy'];
	const asOf = parsed['asOf'];
	const heads = parsed['heads'];
	const entries = parsed['entries'];
	const sig = parsed['sig'];
	if (typeof policy !== 'string') corrupt(what, 'policy is not a string');
	if (typeof asOf !== 'string') corrupt(what, 'asOf is not a string');
	if (typeof sig !== 'string') corrupt(what, 'sig is not a string');
	if (!Array.isArray(heads)) corrupt(what, 'heads is not an array');
	if (!Array.isArray(entries)) corrupt(what, 'entries is not an array');
	return {
		v: 1,
		policy,
		asOf,
		heads: heads.map((head) => checkHead(what, head)),
		entries: entries.map((entry) => checkSnapshotEntry(what, entry)),
		sig,
	};
}
