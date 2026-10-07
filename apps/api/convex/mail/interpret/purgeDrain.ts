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
 *    changes (creation time, activity seq, owner id) and keeps a cursor:
 *    the last position and the ids handled at exactly that position, so
 *    rows that share one are neither skipped nor read twice.
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

import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import type { InterpretMode } from '@owlat/shared/threadBrief';
import type { InterpretationSource } from '../../lib/validators/threadBrief';
import {
	threadRefFromFields,
	threadRefToFields,
	type ThreadRef,
} from '../../lib/validators/threadRef';

/** Rows read per range query. */
export const DRAIN_CHUNK = 64;

/**
 * What one slice may spend: every document read and every index range
 * queried costs a unit. The erasure walkers adapt their own budget
 * (`contacts/erasure/threadBriefPhases.ts`).
 */
export interface DrainBudget {
	isExhausted(): boolean;
	read(doc: unknown): void;
	range(): void;
}

/** A budget of `units` reads and range queries. */
export function unitBudget(units: number): DrainBudget {
	let spent = 0;
	return {
		isExhausted: () => spent >= units,
		read: () => {
			spent += 1;
		},
		range: () => {
			spent += 1;
		},
	};
}

export type PurgeJob = Doc<'threadPurgeJobs'>;
export type PurgeCursor = NonNullable<PurgeJob['cursor']>;

/** The job's findings, carried across slices. */
export interface JobState {
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
		budget.range();
		const rows = await read(DRAIN_CHUNK);
		for (const row of rows) {
			if (budget.isExhausted()) return false;
			budget.read(row);
			if (!(await each(row))) return false;
		}
		if (rows.length < DRAIN_CHUNK) return true;
	}
}

/** A row's place in a range that keeps its rows: a number (creation time, seq) or a string (owner). */
export type RangePosition = number | string;

/**
 * Walk a range whose rows stay, from `cursor`, by a position a handled row
 * never changes. `read(from, n)` returns the first `n` rows at or after
 * position `from` (all of them when `from` is undefined), in position order.
 */
export async function scanRange<Row extends { _id: string }>(
	budget: DrainBudget,
	cursor: PurgeCursor | undefined,
	read: (from: RangePosition | undefined, n: number) => Promise<Row[]>,
	position: (row: Row) => RangePosition,
	each: (row: Row) => Promise<boolean>
): Promise<RangeOutcome> {
	let at: RangePosition | undefined = cursor?.key ?? cursor?.at;
	let ids = cursor?.ids ?? [];
	const save = (): RangeOutcome => ({
		isDone: false,
		cursor: {
			...(typeof at === 'string' ? { key: at } : at !== undefined ? { at } : {}),
			ids,
		},
	});
	for (;;) {
		if (budget.isExhausted()) return save();
		budget.range();
		const asked = DRAIN_CHUNK + ids.length;
		const rows = await read(at, asked);
		for (const row of rows) {
			const pos = position(row);
			if (pos === at && ids.includes(row._id)) continue;
			if (budget.isExhausted()) return save();
			budget.read(row);
			if (!(await each(row))) return save();
			if (pos === at) ids = [...ids, row._id];
			else {
				at = pos;
				ids = [row._id];
			}
		}
		if (rows.length < asked) return { isDone: true };
	}
}

/** The fields a new job starts from. */
export interface NewPurgeJob {
	ref: ThreadRef;
	kind: PurgeJob['kind'];
	jobKey?: string;
	sources?: InterpretationSource[];
	mode?: InterpretMode;
}

export async function createPurgeJob(ctx: MutationCtx, job: NewPurgeJob): Promise<PurgeJob> {
	const now = Date.now();
	const id = await ctx.db.insert('threadPurgeJobs', {
		...threadRefToFields(job.ref),
		kind: job.kind,
		...(job.jobKey ? { jobKey: job.jobKey } : {}),
		...(job.sources ? { sources: job.sources } : {}),
		...(job.mode ? { mode: job.mode } : {}),
		rangeIndex: 0,
		isInterpreted: false,
		isItemDeleted: false,
		isClaimChanged: false,
		isSurvivorChanged: false,
		createdAt: now,
		updatedAt: now,
	});
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
		return true;
	}
	await ctx.db.patch(job._id, {
		rangeIndex: index,
		cursor,
		...state,
		updatedAt: Date.now(),
	});
	return false;
}
