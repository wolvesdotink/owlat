/**
 * Maintained counts (plan 3.1) — the engine behind `counterBuckets` and
 * `counterScopes` (schema/counters.ts).
 *
 * A count the UI shows used to be a scan: the label rail read up to 2,000 unread
 * messages to tally labels, a section header read up to 100 of its unread rows,
 * the Workbench read 151 messages to print "new mail", and the campaign,
 * template and automation facets walked every row of every status. Every one of
 * those reads a whole document (bodies included) to add one to a number.
 *
 * Here each such number is a bucket row. The write that changes a source row
 * moves its buckets in the SAME transaction: the caller hands
 * {@link applyCounterChange} the buckets the row counted in before the write
 * and after it, and only the difference is written. A flag flip that touches no
 * counted field costs nothing — the diff is empty and no row is read.
 *
 * ── BACKFILL WITHOUT A RACE ──────────────────────────────────────────────────
 * Rows that existed before a scope did are counted by a paged walk over the
 * scope's source index, in bounded mutations. While the walk is under way a
 * write can land on a row the walk has already counted, or on one it has not
 * reached yet. The scope stores a WATERMARK — the source position (index key,
 * then `_creationTime`) of the last row it counted — and a write moves the
 * buckets only for a row at or before it. A row past the watermark is left
 * alone: the walk will count it in whatever state it is in when it gets there.
 * An insert is always past the watermark for its key (its `_creationTime` is
 * newer than any row the walk has seen), so {@link AFTER_EVERY_ROW} stands in
 * for its not-yet-known creation time. Scope, watermark and buckets are read
 * and written inside the same transactions as the writes that race them, so
 * Convex's serializable commits make "counted exactly once" hold for every
 * interleaving.
 *
 * A scope with no `counterScopes` row is not maintained at all (nothing reads
 * or writes its buckets), and a scope that is not ready yet reads as `null`:
 * every reader keeps its old bounded scan for that case.
 */

import type { Doc } from '../_generated/dataModel';
import type { DatabaseReader, MutationCtx } from '../_generated/server';

export type CounterKind = Doc<'counterScopes'>['kind'];

/** Where a source row sits in its scope's backfill index. */
export interface CounterPosition {
	/** The index's ordering field (`receivedAt`, or `_creationTime` itself). */
	key: number;
	creationTime: number;
}

/** Creation time for a row that is being inserted: newer than every row that exists. */
export const AFTER_EVERY_ROW = Number.POSITIVE_INFINITY;

/**
 * More buckets than this in one scope and the scope is not trusted for a whole-
 * scope read (the reader falls back to its scan). Label and section scopes sit
 * far below it; range reads (days, hours) never read a whole scope.
 */
export const MAX_SCOPE_BUCKETS = 1000;

/** Buckets written per step when a scope is cleared for a rebuild. */
const CLEAR_BATCH = 500;

/** Position in a creation-order walk; an insert sorts after every existing row. */
export function creationPosition(row: { _creationTime?: number }): CounterPosition {
	const time = row._creationTime ?? AFTER_EVERY_ROW;
	return { key: time, creationTime: time };
}

export function counterScopeKey(kind: CounterKind, ownerId?: string): string {
	return ownerId === undefined ? kind : `${kind}:${ownerId}`;
}

/** Per-bucket difference between two bucket lists (either may repeat a bucket). */
export function bucketDelta(
	before: readonly string[],
	after: readonly string[]
): Map<string, number> {
	const delta = new Map<string, number>();
	for (const bucket of before) delta.set(bucket, (delta.get(bucket) ?? 0) - 1);
	for (const bucket of after) delta.set(bucket, (delta.get(bucket) ?? 0) + 1);
	for (const [bucket, value] of delta) if (value === 0) delta.delete(bucket);
	return delta;
}

/** Has a backfill that stopped at `watermark` already counted the row at `position`? */
export function isCountedPosition(
	position: CounterPosition,
	watermark: CounterPosition | undefined
): boolean {
	if (!watermark) return false;
	if (position.key !== watermark.key) return position.key < watermark.key;
	return position.creationTime <= watermark.creationTime;
}

export async function loadCounterScope(
	db: DatabaseReader,
	scope: string
): Promise<Doc<'counterScopes'> | null> {
	return db
		.query('counterScopes')
		.withIndex('by_scope', (q) => q.eq('scope', scope))
		.first();
}

async function addToBuckets(
	ctx: MutationCtx,
	scope: string,
	delta: ReadonlyMap<string, number>
): Promise<void> {
	const now = Date.now();
	for (const [bucket, change] of delta) {
		if (change === 0) continue;
		const row = await ctx.db
			.query('counterBuckets')
			.withIndex('by_scope_and_bucket', (q) => q.eq('scope', scope).eq('bucket', bucket))
			.first();
		if (row) {
			const next = row.count + change;
			// An empty bucket is no row: readers treat absent as zero, and a label
			// or section that empties out stops costing a read.
			if (next <= 0) await ctx.db.delete(row._id);
			else await ctx.db.patch(row._id, { count: next, updatedAt: now });
		} else if (change > 0) {
			await ctx.db.insert('counterBuckets', { scope, bucket, count: change, updatedAt: now });
		}
	}
}

/**
 * Move one source row's buckets from `before` to `after` in `scope`. Call it in
 * the mutation that writes the row, with the row's position in the scope's
 * backfill index (see the header for why the position matters).
 */
export async function applyCounterChange(
	ctx: MutationCtx,
	scope: string,
	position: CounterPosition,
	before: readonly string[],
	after: readonly string[]
): Promise<void> {
	const delta = bucketDelta(before, after);
	if (delta.size === 0) return;
	const state = await loadCounterScope(ctx.db, scope);
	if (!state) return;
	if (!state.isReady && !isCountedPosition(position, state.watermark)) return;
	await addToBuckets(ctx, scope, delta);
}

/**
 * Every bucket of a ready scope, or `null` when the scope is not ready (or has
 * grown past {@link MAX_SCOPE_BUCKETS}) and the caller must fall back to its scan.
 */
export async function readCounterScope(
	db: DatabaseReader,
	scope: string
): Promise<Map<string, number> | null> {
	const state = await loadCounterScope(db, scope);
	if (!state?.isReady) return null;
	const rows = await db
		.query('counterBuckets')
		.withIndex('by_scope_and_bucket', (q) => q.eq('scope', scope))
		.take(MAX_SCOPE_BUCKETS + 1);
	if (rows.length > MAX_SCOPE_BUCKETS) return null;
	return new Map(rows.map((row) => [row.bucket, row.count]));
}

// ── Backfill ────────────────────────────────────────────────────────────────

/** One page of a scope's source rows, as the kind-specific walker read it. */
export interface CounterBackfillPage {
	items: ReadonlyArray<{ position: CounterPosition; buckets: readonly string[] }>;
	continueCursor: string;
	isDone: boolean;
}

/**
 * Create a scope's state row. `isEmpty` marks a scope whose source is known to
 * hold no rows yet (a mailbox being provisioned): it is ready at once and needs
 * no walk. Idempotent — an existing scope is left alone and its state returned.
 */
export async function startCounterScope(
	ctx: MutationCtx,
	kind: CounterKind,
	ownerId: string | undefined,
	options: { isEmpty?: boolean } = {}
): Promise<'ready' | 'running' | 'started'> {
	const scope = counterScopeKey(kind, ownerId);
	const existing = await loadCounterScope(ctx.db, scope);
	if (existing) return existing.isReady ? 'ready' : 'running';
	const now = Date.now();
	const isReady = options.isEmpty === true;
	await ctx.db.insert('counterScopes', {
		scope,
		kind,
		ownerId,
		isReady,
		cursor: null,
		startedAt: now,
		completedAt: isReady ? now : undefined,
		updatedAt: now,
	});
	return isReady ? 'ready' : 'started';
}

/**
 * Drop a scope so it can be rebuilt from scratch. The state row goes first, so
 * from that commit on no write moves a bucket and no queued backfill step runs;
 * then up to one batch of buckets per call. Returns true while buckets remain —
 * call it until it returns false before starting the scope again.
 */
export async function clearCounterScope(ctx: MutationCtx, scope: string): Promise<boolean> {
	const state = await loadCounterScope(ctx.db, scope);
	if (state) await ctx.db.delete(state._id);
	const rows = await ctx.db
		.query('counterBuckets')
		.withIndex('by_scope_and_bucket', (q) => q.eq('scope', scope))
		.take(CLEAR_BATCH);
	for (const row of rows) await ctx.db.delete(row._id);
	return rows.length === CLEAR_BATCH;
}

/** Count one walked page into its scope and advance the watermark. */
export async function applyCounterBackfillPage(
	ctx: MutationCtx,
	state: Doc<'counterScopes'>,
	page: CounterBackfillPage
): Promise<void> {
	const delta = new Map<string, number>();
	for (const item of page.items) {
		for (const bucket of item.buckets) delta.set(bucket, (delta.get(bucket) ?? 0) + 1);
	}
	await addToBuckets(ctx, state.scope, delta);

	const now = Date.now();
	if (page.isDone) {
		await ctx.db.patch(state._id, {
			isReady: true,
			cursor: null,
			watermark: undefined,
			completedAt: now,
			updatedAt: now,
		});
		return;
	}
	const last = page.items[page.items.length - 1];
	await ctx.db.patch(state._id, {
		cursor: page.continueCursor,
		watermark: last ? last.position : state.watermark,
		updatedAt: now,
	});
}
