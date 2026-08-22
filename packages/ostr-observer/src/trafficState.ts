/**
 * The serializable half of {@link TrafficAccumulator}: the state shape a held
 * window is persisted as, and the validation that runs when it comes back.
 *
 * Restore is the one place in this package that reads bytes the observer did
 * not just compute — a file on disk, a row in a table, possibly written by an
 * older or a newer build, possibly truncated mid-write. Trusting it is how a
 * negative counter becomes a signed attestation the log rejects, hours later,
 * as an unexplained `RangeError` from the signer. So the version is required,
 * every counter is re-checked against the core's `isCount` rule (non-negative
 * safe integer), subjects are re-normalized, and a duplicate subject key is
 * MERGED rather than silently overwritten — losing a subject's unpublished
 * traffic is the same bug as double-counting it, just quieter.
 */
import { compareRfc3339, isRfc3339, type SubjectRef } from '@owlat/ostr-core';
import { normalizeDomain, normalizeIp, subjectKey } from './types.js';

/** Serializable per-subject state — held windows outlive a process restart. */
export interface SubjectTotalsState {
	subject: SubjectRef;
	messages: number;
	spfPass: number;
	dkimPass: number;
	dmarcPass: number;
	tlsInbound: number;
	bounced: number;
	recipientTotal: number;
	/** Distinct recipient tokens seen; absent when the app supplies none. */
	recipientTokens?: string[];
	/** Earliest window start whose traffic is still unpublished (§7.4). */
	heldFrom?: string;
}

export interface TrafficAccumulatorState {
	v: 1;
	subjects: SubjectTotalsState[];
}

/** In-memory totals: the persisted shape plus the distinct-token set, which is
 *  a `Set` in memory and an array on disk. */
export interface SubjectTotals extends SubjectTotalsState {
	recipientTokenSet: Set<string> | null;
}

export function emptyTotals(subject: SubjectRef): SubjectTotals {
	return {
		subject,
		messages: 0,
		spfPass: 0,
		dkimPass: 0,
		dmarcPass: 0,
		tlsInbound: 0,
		bounced: 0,
		recipientTotal: 0,
		recipientTokenSet: null,
	};
}

/** Counters that can never exceed `messages` — the core rejects a denominator
 *  smaller than its numerator, and so does a restored blob. */
const SUBSET_COUNTERS = ['spfPass', 'dkimPass', 'dmarcPass', 'tlsInbound', 'bounced'] as const;

/** The core's `isCount` rule applied to untrusted state: anything that is not a
 *  non-negative safe integer counts as nothing. */
function count(value: unknown): number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Re-normalize a persisted subject. A subject that no longer names a usable
 *  party is dropped: it could never be published, and its recipient tokens
 *  would sit in the blob forever. */
function normalizeSubject(subject: SubjectRef | undefined): SubjectRef | undefined {
	if (subject === null || typeof subject !== 'object') return undefined;
	const domain = normalizeDomain(subject.domain);
	const ip = normalizeIp(subject.ip);
	if (domain !== undefined) return { domain };
	if (ip !== undefined) return { ip };
	return undefined;
}

function tokenSet(tokens: unknown): Set<string> | null {
	if (!Array.isArray(tokens)) return null;
	const set = new Set<string>();
	for (const token of tokens) {
		if (typeof token === 'string' && token.length > 0) set.add(token);
	}
	return set;
}

function sanitize(entry: SubjectTotalsState, subject: SubjectRef): SubjectTotals {
	const messages = count(entry.messages);
	const totals: SubjectTotals = {
		...emptyTotals(subject),
		messages,
		recipientTotal: count(entry.recipientTotal),
		recipientTokenSet: tokenSet(entry.recipientTokens),
	};
	for (const field of SUBSET_COUNTERS) totals[field] = Math.min(count(entry[field]), messages);
	if (isRfc3339(entry.heldFrom)) totals.heldFrom = entry.heldFrom;
	return totals;
}

/** Fold a duplicate key into the entry already restored. Counters add, tokens
 *  union, and the held window keeps the earlier start — the widening rule only
 *  ever moves `from` backwards. */
function merge(into: SubjectTotals, extra: SubjectTotals): void {
	into.messages += extra.messages;
	for (const field of SUBSET_COUNTERS) {
		into[field] = Math.min(into[field] + extra[field], into.messages);
	}
	into.recipientTotal += extra.recipientTotal;
	if (extra.recipientTokenSet !== null) {
		into.recipientTokenSet ??= new Set<string>();
		for (const token of extra.recipientTokenSet) into.recipientTokenSet.add(token);
	}
	if (extra.heldFrom !== undefined) {
		into.heldFrom =
			into.heldFrom === undefined || compareRfc3339(extra.heldFrom, into.heldFrom) < 0
				? extra.heldFrom
				: into.heldFrom;
	}
}

/**
 * Validate and rehydrate persisted accumulator state.
 *
 * @throws RangeError if the blob is not `v: 1` with a subject array — a future
 * version or a truncated file is a condition the app must see at startup, where
 * it can refuse to run or start from empty, rather than at signing time.
 */
export function restoreSubjects(state: TrafficAccumulatorState): Map<string, SubjectTotals> {
	if (state === null || typeof state !== 'object' || state.v !== 1) {
		throw new RangeError('traffic accumulator state must be version 1');
	}
	if (!Array.isArray(state.subjects)) {
		throw new RangeError('traffic accumulator state must carry a subjects array');
	}
	const subjects = new Map<string, SubjectTotals>();
	for (const entry of state.subjects) {
		if (entry === null || typeof entry !== 'object') continue;
		const subject = normalizeSubject(entry.subject);
		if (subject === undefined) continue;
		const key = subjectKey(subject);
		const totals = sanitize(entry, subject);
		const existing = subjects.get(key);
		if (existing === undefined) subjects.set(key, totals);
		else merge(existing, totals);
	}
	return subjects;
}
