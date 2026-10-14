/**
 * The resumable drain behind every thread brief purge and scope change
 * (review round 1, S1): a job (`threadPurgeJobs`) walks its kind's ranges in
 * order, a bounded slice at a time, and persists where it stands in each
 * range. Completion is "every range exhausted", never "a page came back
 * short" on a set the walk leaves in place.
 *
 * Two kinds of range:
 *
 *  - {@link drainShrinking}: a range every handled row LEAVES (deleted, or
 *    patched out of the index range). Reading its first rows until a read
 *    comes back short empties it, so it needs no cursor.
 *  - {@link scanRange}: a range whose rows STAY (patched in place, or
 *    skipped). It walks by an index position that a handled row never
 *    changes and that is unique in the range (creation time, activity seq,
 *    an ask session's owner) and keeps the last handled position as its
 *    cursor; the next read starts strictly after it.
 *  - {@link drainSteps}: a list of sub-ranges, with the first unfinished
 *    one in the cursor, so emptied sub-ranges are never queried again.
 *
 * Reads are bounded by the rows AND the bytes a slice has left, and every
 * fetched document is charged (review round 2, F3).
 *
 * A row handler returns false when it ran out of budget before it finished
 * the row (an item whose links are still being cleared): the row is handled
 * again in the next slice, which continues where it stopped. Children always
 * go before their parent.
 *
 * The job's kind (its range list and how it settles) lives in `purge.ts`,
 * `purgeThread.ts` and `scopeChange.ts`; `purgeRun.ts` dispatches.
 *
 * Isolate-safe helpers, no Convex functions.
 */

import { getConvexSize, type Value } from 'convex/values';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { syncActivePurgeJobs } from './purgeActive';
import type { InterpretMode } from '@owlat/shared/threadBrief';
import type { InterpretationSource } from '../../lib/validators/threadBrief';
import {
	threadRefFromFields,
	threadRefToFields,
	type ThreadRef,
} from '../../lib/validators/threadRef';

/** Most rows one range query asks for. */
export const DRAIN_CHUNK = 64;
/** Convex's per-document size limit: the most one fetched row can cost. */
const MAX_DOCUMENT_BYTES = 1024 * 1024;
/** Charged per document on top of its encoded size (index entry, framing). */
const DOCUMENT_OVERHEAD_BYTES = 64;

/**
 * What one slice may spend: rows and bytes of the documents it fetches, and
 * the index ranges it queries. A read never asks for more rows than the rows
 * left, nor more than the bytes left could hold at the maximum document size
 * ({@link DrainBudget.chunk}); every fetched document is charged, handled or
 * not. The first row of a slice is always allowed, so a slice always moves.
 * The erasure walkers adapt their own budget
 * (`contacts/erasure/threadBriefPhases.ts walkerDrainBudget`).
 */
export interface DrainBudget {
	isExhausted(): boolean;
	/** Rows the next read may ask for (at least one, at most `max`). */
	chunk(max: number): number;
	/** A fetched document. */
	charge(doc: unknown): void;
	/** An index range queried. */
	range(): void;
	/** A row handled (deleted, patched, or finished with its children). */
	progress(): void;
}

export function documentBytes(doc: unknown): number {
	return doc === null || doc === undefined
		? DOCUMENT_OVERHEAD_BYTES
		: getConvexSize(doc as Value) + DOCUMENT_OVERHEAD_BYTES;
}

/**
 * Index range reads one slice may make, whatever else it has left. A hard cap
 * the progress rule never lifts: Convex fails a transaction past 4,096, and a
 * walk over empty sub-ranges makes no progress to stop it (review round 4, F4).
 * The sub-ranges a slice emptied are kept in the job cursor (`drainSteps`).
 */
export const MAX_RANGE_READS = 1000;

/** A budget of `rows` rows (each range query counts as one) and `bytes` fetched bytes. */
export function unitBudget(rows: number, bytes: number = 8 * MAX_DOCUMENT_BYTES): DrainBudget {
	let spentRows = 0;
	let spentBytes = 0;
	let spentRanges = 0;
	let handled = 0;
	const affordable = () => Math.floor((bytes - spentBytes) / MAX_DOCUMENT_BYTES);
	return {
		// Until a row is handled the slice is never exhausted by rows or bytes:
		// every slice moves (review round 3 F4). The range cap always holds. A
		// zero budget starts no work at all.
		isExhausted: () =>
			rows <= 0 ||
			spentRanges >= MAX_RANGE_READS ||
			(handled > 0 && (spentRows >= rows || affordable() < 1)),
		// Before the first handled row, one row at a time: a slice whose first
		// parent is large never fetches a whole batch it cannot then handle.
		chunk: (max) =>
			handled === 0 ? 1 : Math.max(1, Math.min(max, rows - spentRows, affordable())),
		charge: (doc) => {
			spentRows += 1;
			spentBytes += documentBytes(doc);
		},
		range: () => {
			spentRows += 1;
			spentRanges += 1;
		},
		progress: () => {
			handled += 1;
		},
	};
}

export type PurgeJob = Doc<'threadPurgeJobs'>;
export type PurgeCursor = NonNullable<PurgeJob['cursor']>;

/** The job's findings, carried across slices. */
export interface JobState {
	/** The purged sources (`sources` jobs); a range may add to them (a message's team replies). */
	sources: InterpretationSource[];
	isInterpreted: boolean;
	isItemDeleted: boolean;
	isClaimChanged: boolean;
	isSurvivorChanged: boolean;
}

export type RangeOutcome = { isDone: true } | { isDone: false; cursor: PurgeCursor | undefined };

/** One slice of one range, from `cursor`. */
export interface RangeRun {
	job: PurgeJob;
	ref: ThreadRef;
	cursor: PurgeCursor | undefined;
	budget: DrainBudget;
	state: JobState;
}

export type PurgeRange = (ctx: MutationCtx, run: RangeRun) => Promise<RangeOutcome>;

/** A kind's walk: its ranges in order, and what happens once all are exhausted. */
export interface JobPlan {
	ranges: readonly PurgeRange[];
	settle(ctx: MutationCtx, job: PurgeJob, ref: ThreadRef, state: JobState): Promise<void>;
}

/**
 * Drain a range its handled rows leave. `each` returns false when it ran out
 * of budget on a row; the row is then still in the range and is handled
 * again next time. Returns whether the range is empty.
 */
export async function drainShrinking<Row>(
	budget: DrainBudget,
	read: (n: number) => Promise<Row[]>,
	each: (row: Row) => Promise<boolean>
): Promise<boolean> {
	for (;;) {
		if (budget.isExhausted()) return false;
		const asked = budget.chunk(DRAIN_CHUNK);
		budget.range();
		const rows = await read(asked);
		for (const row of rows) budget.charge(row);
		for (const row of rows) {
			if (!(await each(row))) return false;
			budget.progress();
		}
		if (rows.length < asked) return true;
	}
}

/** A row's place in a range that keeps its rows: a number (creation time, seq) or a string (owner). */
export type RangePosition = number | string;

/**
 * Walk a range whose rows stay, from `cursor`, by a position that is unique
 * within the range and that a handled row never changes (creation time,
 * activity seq, an ask session's owner per target). `read(after, n)` returns
 * the first `n` rows strictly after position `after` (from the start when
 * undefined), in position order. The cursor is the last handled position.
 */
export async function scanRange<Row>(
	budget: DrainBudget,
	cursor: PurgeCursor | undefined,
	read: (after: RangePosition | undefined, n: number) => Promise<Row[]>,
	position: (row: Row) => RangePosition,
	each: (row: Row) => Promise<boolean>
): Promise<RangeOutcome> {
	let after: RangePosition | undefined = cursor?.key ?? cursor?.at;
	// A slice that stopped inside a row (its children outlasted the budget):
	// the next reads this range a row at a time, so the bytes go to children.
	const isNarrow = cursor?.isNarrow === true;
	const save = (isStopped = false): RangeOutcome => ({
		isDone: false,
		cursor: {
			...(typeof after === 'string' ? { key: after } : after !== undefined ? { at: after } : {}),
			...(isStopped || isNarrow ? { isNarrow: true } : {}),
		},
	});
	for (;;) {
		if (budget.isExhausted()) return save();
		const asked = isNarrow ? 1 : budget.chunk(DRAIN_CHUNK);
		budget.range();
		const rows = await read(after, asked);
		for (const row of rows) budget.charge(row);
		for (const row of rows) {
			if (!(await each(row))) return save(true);
			budget.progress();
			after = position(row);
		}
		if (rows.length < asked) return { isDone: true };
	}
}

/**
 * Walk a list of sub-ranges in order (`drainShrinking` each), keeping the
 * index of the first unfinished one in the cursor (`step`), so a slice never
 * re-reads the sub-ranges an earlier slice emptied.
 */
export async function drainSteps(
	budget: DrainBudget,
	cursor: PurgeCursor | undefined,
	steps: ReadonlyArray<() => Promise<boolean>>
): Promise<RangeOutcome> {
	for (let step = cursor?.step ?? 0; step < steps.length; step++) {
		if (!(await steps[step]!())) return { isDone: false, cursor: { step } };
	}
	return { isDone: true };
}

/** The fields a new job starts from. */
export interface NewPurgeJob {
	ref: ThreadRef;
	kind: PurgeJob['kind'];
	jobKey?: string;
	sources?: InterpretationSource[];
	/** `sources` jobs of a received Team Inbox message: its team replies are added as found. */
	inboundMessageId?: Id<'inboundMessages'>;
	mode?: InterpretMode;
}

export async function createPurgeJob(ctx: MutationCtx, job: NewPurgeJob): Promise<PurgeJob> {
	const now = Date.now();
	const id = await ctx.db.insert('threadPurgeJobs', {
		...threadRefToFields(job.ref),
		kind: job.kind,
		...(job.jobKey ? { jobKey: job.jobKey } : {}),
		...(job.sources ? { sources: job.sources } : {}),
		...(job.inboundMessageId ? { inboundMessageId: job.inboundMessageId } : {}),
		...(job.mode ? { mode: job.mode } : {}),
		rangeIndex: 0,
		isInterpreted: false,
		isItemDeleted: false,
		isClaimChanged: false,
		isSurvivorChanged: false,
		createdAt: now,
		updatedAt: now,
	});
	// The thread reads partial, and D3 holds, until the job's last slice.
	await syncActivePurgeJobs(ctx, job.ref);
	return (await ctx.db.get(id))!;
}

export async function findPurgeJob(ctx: MutationCtx, jobKey: string): Promise<PurgeJob | null> {
	return ctx.db
		.query('threadPurgeJobs')
		.withIndex('by_job_key', (q) => q.eq('jobKey', jobKey))
		.first();
}

/**
 * Run one slice of `job` within `budget`: its ranges from where it stood,
 * the cursor persisted after each. Settles and deletes the job once the last
 * range is exhausted. Returns whether it finished.
 */
export async function runJobPlan(
	ctx: MutationCtx,
	job: PurgeJob,
	plan: JobPlan,
	budget: DrainBudget
): Promise<boolean> {
	const ref = threadRefFromFields(job);
	const state: JobState = {
		sources: [...(job.sources ?? [])],
		isInterpreted: job.isInterpreted,
		isItemDeleted: job.isItemDeleted,
		isClaimChanged: job.isClaimChanged,
		isSurvivorChanged: job.isSurvivorChanged,
	};
	let index = job.rangeIndex;
	let cursor = job.cursor;
	while (index < plan.ranges.length && !budget.isExhausted()) {
		const outcome = await plan.ranges[index]!(ctx, { job, ref, cursor, budget, state });
		if (!outcome.isDone) {
			cursor = outcome.cursor;
			break;
		}
		index += 1;
		cursor = undefined;
	}
	if (index >= plan.ranges.length) {
		await plan.settle(ctx, job, ref, state);
		await ctx.db.delete(job._id);
		await syncActivePurgeJobs(ctx, ref);
		return true;
	}
	const { sources, ...findings } = state;
	await ctx.db.patch(job._id, {
		rangeIndex: index,
		cursor,
		...(job.kind === 'sources' ? { sources } : {}),
		...findings,
		updatedAt: Date.now(),
	});
	return false;
}
