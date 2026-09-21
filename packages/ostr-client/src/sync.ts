/**
 * Snapshot and diff-feed sync (spec 08 §8.3).
 *
 * HTTP is injected as `fetchJson(path)`. The package builds paths and verifies
 * signatures; it does not own a base URL, a TLS policy, a retry schedule or a
 * user agent, all of which belong to the deployment.
 *
 * The one rule that is not negotiable here: a snapshot whose aggregator
 * signature does not verify is discarded and the previous local set is kept.
 * A consumer running from local data has replaced "I trust the answer because
 * DNSSEC signed the zone" with "I trust the file because the aggregator signed
 * it", and skipping the check would leave nothing at all.
 *
 * The v1 diff feed has no signature to check, so {@link syncDiff} refuses to
 * apply it unless the store was explicitly opted in with `allowUnsignedDiffs`
 * — see {@link SnapshotStoreOptions.allowUnsignedDiffs}. Silently accepting it
 * would hand anything that can answer `/v1/diff` the ability to move a subject
 * between tiers without a key.
 *
 * The feed is also finite. An aggregator prunes it — the reference registry to
 * the newest 200,000 rows — so a consumer whose cursor has fallen off the end
 * gets a well-formed answer that begins somewhere above the cursor, applies it,
 * and is quietly missing every tier change in between. {@link syncDiff}
 * reports that shape as `gapDetected`, and the obligation it signals is a fresh
 * {@link syncSnapshot} rather than another page.
 */

import { verifySnapshotSignature, type DiffFeedEntry, type SnapshotFile } from '@owlat/ostr-core';
import { isSnapshotFile, parseDiffFeed } from './parse.js';
import type { SnapshotStore } from './store.js';

/** Fetches and JSON-decodes `path` against the aggregator's HTTPS API. */
export type FetchJson = (path: string) => Promise<unknown>;

export const SNAPSHOT_PATH = '/v1/snapshot';

/**
 * The feed path for a cursor. Throws on anything that is not a non-negative
 * integer, so `?since=NaN` cannot be built out of a caller's bad input and
 * handed to a server as a question.
 */
export function diffPath(since: number): string {
	if (!Number.isInteger(since) || since < 0) {
		throw new Error(`since must be a non-negative integer, got ${String(since)}`);
	}
	return `/v1/diff?since=${since}`;
}

export interface SyncSnapshotInput {
	fetchJson: FetchJson;
	/** The aggregator's ed25519 public key, base64. */
	aggregatorPublicKeyBase64: string;
	store: SnapshotStore;
}

export type SyncSnapshotResult =
	| { ok: true; entries: number; asOf: string; snapshot: SnapshotFile }
	| { ok: false; errors: string[] };

export interface SyncDiffInput {
	fetchJson: FetchJson;
	store: SnapshotStore;
	/**
	 * Cursor. A non-negative integer; defaults to the highest sequence the
	 * store has already applied. Entries at or below it are dropped from the
	 * answer rather than applied.
	 *
	 * The feed is history, not a view, and an aggregator prunes it (the
	 * reference registry keeps the newest `DIFF_FEED_MAX_ROWS` rows). A cursor
	 * that has fallen off the end is not an error the server reports — it just
	 * answers with entries that begin above the cursor. A consumer that lets its
	 * cursor go stale therefore owes itself a fresh {@link syncSnapshot}; see
	 * `gapDetected` on {@link SyncDiffResult}, which is this package's best
	 * effort at noticing on the consumer's behalf.
	 */
	since?: number;
}

export type SyncDiffResult =
	| {
			ok: true;
			applied: number;
			latestSeq: number;
			asOf: string | null;
			/**
			 * The feed's oldest fresh entry sat above `since + 1`, which is what a
			 * pruned cursor looks like: the entries between the two are gone, so
			 * subjects whose only diff line was in that range are still being
			 * answered from the snapshot while the consumer believes it is current.
			 *
			 * A heuristic, and deliberately the safe-erring one. Sequence numbers
			 * come from SQLite `AUTOINCREMENT`, so a rolled-back refresh leaves a
			 * hole that is not a prune and this flag is raised anyway. The reverse
			 * mistake — a pruned consumer told it is current — is the one that
			 * costs something. Treat it as "resync from {@link syncSnapshot}", not
			 * as "the sync failed": everything the answer did carry was applied.
			 */
			gapDetected: boolean;
	  }
	| { ok: false; errors: string[] };

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Fetch, verify and adopt the current snapshot.
 *
 * On any failure — transport, shape or signature — the store is left exactly
 * as it was, so a bad answer degrades a consumer to stale-but-verified data
 * rather than to no data.
 */
export async function syncSnapshot(input: SyncSnapshotInput): Promise<SyncSnapshotResult> {
	let payload: unknown;
	try {
		payload = await input.fetchJson(SNAPSHOT_PATH);
	} catch (error: unknown) {
		return { ok: false, errors: [`fetch failed: ${messageOf(error)}`] };
	}
	if (!isSnapshotFile(payload)) {
		return { ok: false, errors: [`${SNAPSHOT_PATH} did not return a snapshot document`] };
	}
	if (!verifySnapshotSignature(payload, input.aggregatorPublicKeyBase64)) {
		return { ok: false, errors: ['snapshot signature did not verify'] };
	}
	// The store re-verifies against its own configured key. Belt and braces on
	// purpose: this check catches the fetched document, that one catches every
	// other way a snapshot could reach the scored set.
	const adopted = await input.store.adopt(payload);
	if (!adopted.ok) return { ok: false, errors: adopted.errors };
	return { ok: true, entries: payload.entries.length, asOf: payload.asOf, snapshot: payload };
}

/**
 * Fetch the diff feed since the store's last applied sequence and apply it.
 *
 * Two preconditions, both refusals rather than warnings:
 *
 *  - the store must hold a verified snapshot, because v1 diff entries are an
 *    increment to something verified and never a source of truth; and
 *  - the store must accept unsigned diffs. Nothing signs a diff entry, so
 *    applying one is trusting whoever answered the request. A consumer that has
 *    not said so explicitly gets an error and its previous, signed scored set —
 *    and the request is not even sent.
 *
 * One call is one request. An aggregator is free to paginate (the reference
 * registry caps `/v1/diff` and expects the caller to resume from the last
 * `seq`), so a consumer draining a long feed calls this until `applied` is 0.
 */
export async function syncDiff(input: SyncDiffInput): Promise<SyncDiffResult> {
	if (input.store.snapshot() === null) {
		return { ok: false, errors: ['no verified snapshot to apply diffs to'] };
	}
	if (!input.store.acceptsUnsignedDiffs()) {
		return {
			ok: false,
			errors: [
				'diff feed refused: entries are unsigned, set allowUnsignedDiffs to accept transport-only trust (spec 08 §8.3)',
			],
		};
	}
	const since = input.since ?? input.store.latestSeq();
	if (!Number.isInteger(since) || since < 0) {
		return { ok: false, errors: [`since must be a non-negative integer, got ${String(since)}`] };
	}
	let payload: unknown;
	try {
		payload = await input.fetchJson(diffPath(since));
	} catch (error: unknown) {
		return { ok: false, errors: [`fetch failed: ${messageOf(error)}`] };
	}
	const entries: DiffFeedEntry[] | null = parseDiffFeed(payload);
	if (entries === null) {
		return { ok: false, errors: [`${diffPath(since)} did not return a diff feed`] };
	}
	// The cursor is the client's, not the server's: an answer holding entries
	// at or below `since` is answering a question that was not asked.
	const fresh = entries.filter((entry) => entry.seq > since);
	const gapDetected = hasGap(since, fresh);
	let applied: number;
	try {
		applied = await input.store.applyDiffs(fresh);
	} catch (error: unknown) {
		return { ok: false, errors: [messageOf(error)] };
	}
	return {
		ok: true,
		applied,
		latestSeq: input.store.latestSeq(),
		asOf: input.store.asOf(),
		gapDetected,
	};
}

/**
 * True when the feed's oldest fresh entry skips past `since + 1`.
 *
 * `since === 0` is exempt: that is the cursor of a store holding a snapshot and
 * no diffs, and the snapshot already accounts for the whole feed behind it, so
 * a first entry at seq 190_000 is the normal case rather than a gap.
 */
function hasGap(since: number, fresh: readonly DiffFeedEntry[]): boolean {
	if (since === 0) return false;
	let oldest: number | null = null;
	// The feed is served oldest-first, but the client does not depend on that.
	for (const entry of fresh) {
		if (oldest === null || entry.seq < oldest) oldest = entry.seq;
	}
	return oldest !== null && oldest > since + 1;
}
