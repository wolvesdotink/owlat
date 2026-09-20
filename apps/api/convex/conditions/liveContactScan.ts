/**
 * The budgeted, resumable walk over the live (not soft-deleted) Contact
 * population — the scan every segment count/match convenience in
 * `segmentMatch.ts` is built on.
 *
 * Streaming the population with `for await` does NOT make it bounded: Convex
 * caps a single function execution at 16,384 document reads / 8 MiB no matter
 * how the rows are fetched, so an unbudgeted iteration over `contacts` fails
 * the moment the table outgrows that ceiling — and, in a mutation, it drags the
 * whole table into the transaction's OCC read set on the way. The walk
 * therefore carries a DOCUMENT budget and hands back a checkpoint, so its
 * callers scan a bounded slice per execution and reschedule themselves until
 * the population is exhausted.
 */

import type { DatabaseReader } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';

/**
 * Documents one execution of the walk may read.
 *
 * Charged in DOCUMENTS rather than Contacts because a Contact does not cost one
 * document: it costs its own row plus whatever the chunk's condition lookup
 * point-reads for it (`conditionsLookupReadsPerContact`), so a segment with two
 * `topic_membership` conditions costs three documents per Contact. A quarter of
 * the 16,384 ceiling leaves the caller room for its own reads — the segment
 * rows, the scheduler bookkeeping, the count patch — in the same transaction.
 */
const LIVE_SCAN_DOCUMENT_BUDGET = 4_000;

/**
 * Contacts that share one condition-lookup preload inside the walk. Matches the
 * campaign audience scan's `SEGMENT_LOOKUP_BATCH`: small enough that a chunk's
 * point reads stay noise against the budget, large enough that the per-chunk
 * set-up cost is amortized.
 */
const LOOKUP_CHUNK_SIZE = 200;

/** Where a walk stopped and whether anything is left. */
export interface LiveScanProgress {
	/** Live Contacts visited by THIS execution. */
	scanned: number;
	/** The population is exhausted (or the visitor stopped early on purpose). */
	done: boolean;
	/** Opaque resume point to hand the next execution; `null` when `done`. */
	cursor: string | null;
}

/** How a caller resumes and bounds one execution of the walk. */
export interface LiveScanOptions {
	/** Checkpoint from the previous execution, or `null`/absent to start over. */
	cursor?: string | null;
	/** Documents this execution may read. Defaults to {@link LIVE_SCAN_DOCUMENT_BUDGET}. */
	documentBudget?: number;
	/** Documents one Contact costs: its row plus its share of the chunk lookup. */
	documentsPerContact: number;
	/** Documents one chunk's lookup preload costs regardless of chunk size. */
	documentsPerChunk: number;
	/**
	 * Contacts per chunk, capped at {@link LOOKUP_CHUNK_SIZE}. A visitor that can
	 * stop early (a `limit`) should shrink this: the visitor only runs when a
	 * chunk flushes, so the chunk size is also how far past its stopping point
	 * the walk reads.
	 */
	chunkSize?: number;
}

/** The decoded checkpoint: a position in the `by_deleted_at` index. */
interface LiveScanPosition {
	creationTime: number;
	id: string;
}

function encodeCursor(contact: Doc<'contacts'>): string {
	return JSON.stringify({ creationTime: contact._creationTime, id: contact._id });
}

/**
 * Decode a checkpoint, treating anything unreadable as "start from the
 * beginning". A corrupt cursor is corrupt arguments, not user input, and
 * restarting the walk recounts rows — which is recoverable — whereas honouring
 * a bogus position would silently write a partial tally as the final count.
 */
function decodeCursor(cursor: string | null | undefined): LiveScanPosition | null {
	if (!cursor) return null;
	try {
		const parsed = JSON.parse(cursor) as Partial<LiveScanPosition>;
		if (typeof parsed.creationTime !== 'number' || typeof parsed.id !== 'string') return null;
		return { creationTime: parsed.creationTime, id: parsed.id };
	} catch {
		return null;
	}
}

/**
 * Walk the live Contacts in chunks, from `opts.cursor`, until the document
 * budget is spent or the population ends.
 *
 * Iterating `by_deleted_at` pinned to `deletedAt === undefined` keeps
 * soft-deleted rows out of the stream, and the continuation is expressed as an
 * explicit range on that index rather than `.paginate()`: Convex permits a
 * single `.paginate()` per function execution, and the cron refresh already
 * spends its one on the `segments` table.
 *
 * `visitChunk` returns `false` to stop early — the walk then reports `done`,
 * because the caller has what it asked for (the `matchLiveContacts` limit) and
 * has nothing to resume.
 */
export async function forEachLiveContactChunk(
	ctx: { db: DatabaseReader },
	opts: LiveScanOptions,
	visitChunk: (chunk: Doc<'contacts'>[]) => Promise<boolean | void>
): Promise<LiveScanProgress> {
	const budget = opts.documentBudget ?? LIVE_SCAN_DOCUMENT_BUDGET;
	const chunkSize = Math.max(1, Math.min(opts.chunkSize ?? LOOKUP_CHUNK_SIZE, LOOKUP_CHUNK_SIZE));
	const from = decodeCursor(opts.cursor);

	const stream = ctx.db.query('contacts').withIndex('by_deleted_at', (q) => {
		const live = q.eq('deletedAt', undefined);
		// `gte`, not `gt`: Convex creation times are effectively unique, but a tie
		// at the checkpoint's timestamp would drop a Contact, and re-entering that
		// timestamp costs one re-read to be certain it cannot.
		return from ? live.gte('_creationTime', from.creationTime) : live;
	});

	let spent = 0;
	let scanned = 0;
	let chunk: Doc<'contacts'>[] = [];
	let last: Doc<'contacts'> | null = null;
	let stoppedEarly = false;
	let outOfBudget = false;

	const flush = async (): Promise<boolean> => {
		if (chunk.length === 0) return true;
		const pending = chunk;
		chunk = [];
		return (await visitChunk(pending)) !== false;
	};

	for await (const contact of stream) {
		// Rows at the checkpoint's own creation time that the previous execution
		// already visited, skipped by id (the index orders ties by `_id`).
		if (from && contact._creationTime === from.creationTime && contact._id <= from.id) continue;

		const chunkSetup = chunk.length === 0 ? opts.documentsPerChunk : 0;
		// Charged BEFORE the reads, so the budget is a ceiling rather than an
		// after-the-fact observation. The first Contact of an execution is always
		// admitted: a budget too small for one Contact would otherwise checkpoint
		// at the same position forever.
		if (scanned > 0 && spent + chunkSetup + opts.documentsPerContact > budget) {
			outOfBudget = true;
			break;
		}
		spent += chunkSetup + opts.documentsPerContact;
		scanned++;
		last = contact;
		chunk.push(contact);

		if (chunk.length >= chunkSize && !(await flush())) {
			stoppedEarly = true;
			break;
		}
	}

	if (!stoppedEarly && !(await flush())) stoppedEarly = true;

	const done = stoppedEarly || !outOfBudget;
	return {
		scanned,
		done,
		cursor: done || last === null ? null : encodeCursor(last),
	};
}
