/**
 * The derived-field drift sampler: the one job that checks every cached field
 * in the registry (`./registry.ts`) against what it is a cache of.
 *
 * Each hourly tick of {@link sampleAll} starts one {@link samplePage} per
 * derived field, which reads the next few parent rows in creation order from
 * the field's saved pagination cursor and schedules one {@link checkParent} per
 * parent. Every page and every check is its own transaction: a page reads a
 * handful of rows within a byte bound, and each check pays for one parent's
 * recount on its own, so one field with large rows or one large parent can
 * neither crowd out the others nor push a transaction past Convex's limits.
 *
 * A check recounts the parent from its source rows and compares. A difference
 * is logged once as `derived_field.drift` and repaired in the same
 * transaction as the recount, so a writer that commits in between makes the
 * check retry rather than be overwritten. A recount that would read more than
 * its budget, or whose source is known to be incomplete, is logged as
 * `derived_field.skipped` and writes nothing: no partial count, no zero for a
 * row whose history aged out. A repair only patches the cache; it never runs
 * the writer's side effects again.
 *
 * Reads are what this costs, so the sample stays small: `DEFAULT_SAMPLE_SIZE`
 * parents per field per tick, at most `MAX_SAMPLE_SIZE`.
 */

import { v } from 'convex/values';
import { internal } from '../../_generated/api';
import type { Doc, Id, TableNames } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internalMutation, readActiveWorkspaceDeletion } from '../../lib/writeFence';
import { resolveNow } from '../../lib/clock';
import { logEvent } from '../../lib/runtimeLog';
import { DERIVED_FIELD_REGISTRY } from './registry';
import {
	RECOUNT_BYTE_BUDGET,
	RECOUNT_ROW_BUDGET,
	RecountBudget,
	type DerivedFieldEntry,
	type DerivedValues,
} from './types';

/** Parents checked per field per tick. */
export const DEFAULT_SAMPLE_SIZE = 5;
const MAX_SAMPLE_SIZE = 50;

/**
 * Pages one field may read per tick, so a table where most rows have nothing
 * cached (inbound mail has no outbound state) still yields a sample. Each page
 * asks for at most the parents still missing from the sample, so a tick reads
 * at most this many times the sample size per field.
 */
const MAX_PAGES_PER_TICK = 4;

/**
 * Bytes one page of parents may read (`maximumBytesRead`). A parent is a whole
 * row, and some carry large bodies (a transactional email holds its content),
 * so the row count alone does not bound the read: 50 rows near the 1 MiB
 * document limit are past the 16 MiB a transaction may read. A page cut short
 * by this bound is retried smaller in its own transaction.
 */
const PAGE_BYTE_BUDGET = 4 * 1024 * 1024;

const DERIVED_ENTRIES: readonly DerivedFieldEntry[] = DERIVED_FIELD_REGISTRY.filter(
	(entry): entry is DerivedFieldEntry => entry.kind === 'derived'
);

type AnyDoc = Doc<TableNames>;

function isEligible(entry: DerivedFieldEntry, parent: AnyDoc, now: number): boolean {
	if (entry.isEligible) return entry.isEligible(parent, now);
	// A soft-deleted row is frozen while it waits for its purge.
	return (parent as { deletedAt?: number }).deletedAt === undefined;
}

interface PageResult {
	readonly rows: ReadonlyArray<{ id: string; isEligible: boolean }>;
	readonly isDone: boolean;
	readonly continueCursor: string;
	readonly pageStatus?: string | null;
}

interface PagePlan {
	/** Parents to check. */
	readonly picked: readonly string[];
	/** Where the next page starts; `null` is the oldest row. */
	readonly cursor: string | null;
	/** The page reached the end of the table, so the next pass starts over. */
	readonly wrapped: boolean;
	/** Rows to ask for in another page this tick; undefined when the tick is over for the field. */
	readonly nextPageRows: number | undefined;
}

/**
 * What to do with one page of parents. The cursor is the index position
 * (creation time, then id), so parents that share a creation time are still
 * visited one by one. A page the byte bound cut short may be missing rows, so
 * it picks nothing, keeps the cursor and asks again for half as many rows; a
 * page of one row is complete however it was stopped. Otherwise every eligible
 * row is picked (a page never holds more rows than the sample still misses),
 * and another page follows while the sample is short, the table is not
 * exhausted and the tick has pages left.
 */
export function planPage(
	page: PageResult,
	position: { cursor: string | null; remaining: number; pagesLeft: number }
): PagePlan {
	const hasNextPage = position.pagesLeft > 1;
	if (page.pageStatus === 'SplitRequired' && page.rows.length > 1) {
		return {
			picked: [],
			cursor: position.cursor,
			wrapped: false,
			nextPageRows: hasNextPage ? Math.floor(page.rows.length / 2) : undefined,
		};
	}
	const picked = page.rows.filter((row) => row.isEligible).map((row) => row.id);
	const remaining = position.remaining - picked.length;
	const isShort = !page.isDone && remaining > 0 && hasNextPage;
	return {
		picked,
		cursor: page.isDone ? null : page.continueCursor,
		wrapped: page.isDone,
		nextPageRows: isShort ? remaining : undefined,
	};
}

export interface DriftReport {
	/** Schema paths whose cache differs from the recount. */
	readonly drifted: readonly string[];
	/** Whether the entry's policy allows writing the recount back. */
	readonly isRepairable: boolean;
}

/** Compare the cache with the recount under the entry's repair policy. */
export function compareDerived(
	entry: Pick<DerivedFieldEntry, 'policy'>,
	current: DerivedValues,
	expected: DerivedValues
): DriftReport {
	const drifted = Object.keys(expected).filter((path) => current[path] !== expected[path]);
	if (entry.policy === 'exact') return { drifted, isRepairable: true };
	const isRaise = (path: string) => {
		const cached = current[path];
		const recount = expected[path];
		return typeof cached === 'number' && typeof recount === 'number' && recount > cached;
	};
	return { drifted, isRepairable: drifted.every(isRaise) };
}

/** Patch the drifted top-level fields; entries with nested paths bring their own repair. */
async function patchDrifted(
	ctx: MutationCtx,
	parent: AnyDoc,
	expected: DerivedValues,
	drifted: readonly string[]
): Promise<void> {
	const patch: Record<string, unknown> = {};
	for (const path of drifted) {
		if (path.includes('.')) throw new Error(`No repair for nested derived field ${path}`);
		patch[path] = expected[path];
	}
	await ctx.db.patch(parent._id, patch as Partial<AnyDoc>);
}

function clampSampleSize(requested: number | undefined): number {
	if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_SAMPLE_SIZE;
	return Math.max(1, Math.min(MAX_SAMPLE_SIZE, Math.floor(requested)));
}

const pageArgs = {
	fieldId: v.string(),
	// Parents the tick still wants for this field.
	remaining: v.number(),
	// Rows this page asks for; at most `remaining`, fewer after a page was cut short.
	pageRows: v.number(),
	pagesLeft: v.number(),
	// The instant eligibility is judged at, passed on to the checks; the real clock when absent.
	now: v.optional(v.number()),
};

/**
 * One page of one field's sample, in its own transaction: read the next parents
 * after the field's cursor, schedule their checks, move the cursor, and chain
 * the next page while the sample is short. Uses the transaction's one
 * `.paginate()`.
 */
export const samplePage = internalMutation({
	args: pageArgs,
	returns: v.null(),
	handler: async (ctx, args) => {
		// A deletion can start between the tick and a chained page.
		if (await readActiveWorkspaceDeletion(ctx.db)) return null;
		// A page queued by an older release can name an id this one dropped.
		const entry = DERIVED_ENTRIES.find((candidate) => candidate.id === args.fieldId);
		if (!entry) return null;
		const now = resolveNow(args.now);
		const state = await ctx.db
			.query('derivedFieldCursors')
			.withIndex('by_field_id', (q) => q.eq('fieldId', entry.id))
			.unique();
		const cursor = state?.pageCursor ?? null;
		const page = await ctx.db
			.query(entry.table)
			.withIndex('by_creation_time')
			.paginate({
				numItems: Math.max(1, Math.min(args.pageRows, args.remaining)),
				cursor,
				maximumBytesRead: PAGE_BYTE_BUDGET,
			});
		const plan = planPage(
			{
				rows: (page.page as AnyDoc[]).map((parent) => ({
					id: parent._id,
					isEligible: isEligible(entry, parent, now),
				})),
				isDone: page.isDone,
				continueCursor: page.continueCursor,
				pageStatus: page.pageStatus,
			},
			{ cursor, remaining: args.remaining, pagesLeft: args.pagesLeft }
		);
		for (const parentId of plan.picked) {
			await ctx.scheduler.runAfter(0, internal.maintenance.derivedFields.sampler.checkParent, {
				fieldId: entry.id,
				parentId,
				...(args.now !== undefined ? { now: args.now } : {}),
			});
		}
		const fields = {
			pageCursor: plan.cursor ?? undefined,
			rotations: (state?.rotations ?? 0) + (plan.wrapped ? 1 : 0),
			sampledCount: (state?.sampledCount ?? 0) + plan.picked.length,
			updatedAt: now,
		};
		if (state) await ctx.db.patch(state._id, fields);
		else await ctx.db.insert('derivedFieldCursors', { fieldId: entry.id, ...fields });

		const remaining = args.remaining - plan.picked.length;
		if (plan.nextPageRows !== undefined) {
			await ctx.scheduler.runAfter(0, internal.maintenance.derivedFields.sampler.samplePage, {
				...args,
				remaining,
				pageRows: plan.nextPageRows,
				pagesLeft: args.pagesLeft - 1,
			});
			return null;
		}
		logEvent('derived_field.sampled', {
			detail: {
				field: entry.id,
				pagesRead: MAX_PAGES_PER_TICK - args.pagesLeft + 1,
				remaining,
				wrapped: plan.wrapped,
			},
		});
		return null;
	},
});

/** Cron: start the next sample of every derived field, one transaction per field. */
export const sampleAll = internalMutation({
	args: {
		// Parents per field; DEFAULT_SAMPLE_SIZE when absent, clamped to MAX_SAMPLE_SIZE.
		sampleSize: v.optional(v.number()),
		// The instant eligibility is judged at, passed on to the checks; the real clock when absent.
		now: v.optional(v.number()),
	},
	returns: v.object({ fields: v.number() }),
	handler: async (ctx, args) => {
		// A workspace deletion empties these tables; a repair would be refused by
		// the write fence, and a recount of a half-emptied parent means nothing.
		if (await readActiveWorkspaceDeletion(ctx.db)) return { fields: 0 };
		const sampleSize = clampSampleSize(args.sampleSize);
		for (const entry of DERIVED_ENTRIES) {
			await ctx.scheduler.runAfter(0, internal.maintenance.derivedFields.sampler.samplePage, {
				fieldId: entry.id,
				remaining: sampleSize,
				pageRows: sampleSize,
				pagesLeft: MAX_PAGES_PER_TICK,
				...(args.now !== undefined ? { now: args.now } : {}),
			});
		}
		return { fields: DERIVED_ENTRIES.length };
	},
});

export type CheckOutcome =
	| 'unknown_field'
	| 'missing'
	| 'ineligible'
	| 'skipped'
	| 'clean'
	| 'repaired'
	| 'not_repaired';

const checkOutcomeValidator = v.union(
	v.literal('unknown_field'),
	v.literal('missing'),
	v.literal('ineligible'),
	v.literal('skipped'),
	v.literal('clean'),
	v.literal('repaired'),
	v.literal('not_repaired')
);

/** Recount one parent of one derived field; log and repair drift. */
export const checkParent = internalMutation({
	args: {
		fieldId: v.string(),
		parentId: v.string(),
		now: v.optional(v.number()),
		// Override of the recount allowance, for the budget tests.
		maxSourceRows: v.optional(v.number()),
	},
	returns: checkOutcomeValidator,
	handler: async (ctx, args): Promise<CheckOutcome> => {
		// A check queued by an older release can name an id this one dropped.
		const entry = DERIVED_ENTRIES.find((candidate) => candidate.id === args.fieldId);
		if (!entry) return 'unknown_field';
		const id = ctx.db.normalizeId(entry.table, args.parentId) as Id<TableNames> | null;
		const parent = id ? ((await ctx.db.get(id)) as AnyDoc | null) : null;
		// Deleted since it was picked: nothing to compare, nothing to write.
		if (!parent) return 'missing';
		const now = resolveNow(args.now);
		if (!isEligible(entry, parent, now)) return 'ineligible';

		const budget = new RecountBudget(args.maxSourceRows ?? RECOUNT_ROW_BUDGET, RECOUNT_BYTE_BUDGET);
		const result = await entry.recompute(ctx, parent, budget);
		const scope = { field: entry.id, table: entry.table, parentId: parent._id };
		if (result.status === 'skipped') {
			logEvent('derived_field.skipped', {
				outcome: result.reason,
				detail: { ...scope, sourceRowsRead: budget.rows },
			});
			return 'skipped';
		}

		const current = entry.current(parent);
		const report = compareDerived(entry, current, result.expected);
		if (report.drifted.length === 0) return 'clean';

		if (report.isRepairable) {
			if (entry.repair) await entry.repair(ctx, parent, result.expected, now);
			else await patchDrifted(ctx, parent, result.expected, report.drifted);
		}
		const values: Record<string, string | number | undefined> = {};
		for (const path of report.drifted) {
			values[`cached.${path}`] = current[path];
			values[`recount.${path}`] = result.expected[path];
		}
		const outcome = report.isRepairable ? 'repaired' : 'not_repaired';
		logEvent(
			'derived_field.drift',
			{
				outcome,
				detail: {
					...scope,
					policy: entry.policy,
					drifted: report.drifted.join(','),
					source: entry.source,
					...values,
				},
			},
			'warn'
		);
		return outcome;
	},
});
