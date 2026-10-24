/**
 * The derived-field drift sampler: the one job that checks every cached field
 * in the registry (`./registry.ts`) against what it is a cache of.
 *
 * Each hourly tick of {@link sampleAll} picks the next few parent rows of every
 * derived field, in creation order from where the last tick stopped, and
 * schedules one {@link checkParent} per parent. Picking and checking are
 * separate transactions: the pick reads a handful of rows per field, and each
 * check pays for one parent's recount on its own, so one large parent can
 * neither crowd out the others nor push the tick past Convex's limits.
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
 * Parents read per field per tick, as a multiple of the sample, so a table
 * where most rows have nothing cached (inbound mail has no outbound state)
 * still yields a sample.
 */
const SCAN_FACTOR = 4;

const DERIVED_ENTRIES: readonly DerivedFieldEntry[] = DERIVED_FIELD_REGISTRY.filter(
	(entry): entry is DerivedFieldEntry => entry.kind === 'derived'
);

type AnyDoc = Doc<TableNames>;

function isEligible(entry: DerivedFieldEntry, parent: AnyDoc, now: number): boolean {
	if (entry.isEligible) return entry.isEligible(parent, now);
	// A soft-deleted row is frozen while it waits for its purge.
	return (parent as { deletedAt?: number }).deletedAt === undefined;
}

export interface SamplePlan {
	readonly picked: readonly string[];
	/** The new mark; undefined when the scan reached the end and the next pass starts over. */
	readonly afterCreationTime: number | undefined;
	readonly wrapped: boolean;
}

/**
 * Which scanned parents to check, and where the next tick starts. Rows are
 * consumed in order until the sample is full; a row the sample had no room for
 * stays ahead of the mark. A scan that came back short reached the end of the
 * table, so the mark clears and the next tick begins at the oldest row.
 */
export function planSample(
	scanned: ReadonlyArray<{ id: string; creationTime: number; isEligible: boolean }>,
	scanLimit: number,
	sampleSize: number
): SamplePlan {
	const picked: string[] = [];
	let mark: number | undefined;
	let consumed = 0;
	for (const row of scanned) {
		if (picked.length >= sampleSize) break;
		consumed += 1;
		mark = row.creationTime;
		if (row.isEligible) picked.push(row.id);
	}
	const wrapped = consumed === scanned.length && scanned.length < scanLimit;
	return { picked, afterCreationTime: wrapped ? undefined : mark, wrapped };
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

/** Read the next parents of one field and schedule their checks. */
async function sampleField(
	ctx: MutationCtx,
	entry: DerivedFieldEntry,
	sampleSize: number,
	now: number,
	clock: number | undefined
): Promise<SamplePlan> {
	const cursor = await ctx.db
		.query('derivedFieldCursors')
		.withIndex('by_field_id', (q) => q.eq('fieldId', entry.id))
		.unique();
	const after = cursor?.afterCreationTime;
	const scanLimit = sampleSize * SCAN_FACTOR;
	const scanned = (await ctx.db
		.query(entry.table)
		.withIndex('by_creation_time', (q) => (after === undefined ? q : q.gt('_creationTime', after)))
		.take(scanLimit)) as AnyDoc[];
	const plan = planSample(
		scanned.map((parent) => ({
			id: parent._id,
			creationTime: parent._creationTime,
			isEligible: isEligible(entry, parent, now),
		})),
		scanLimit,
		sampleSize
	);
	for (const parentId of plan.picked) {
		await ctx.scheduler.runAfter(0, internal.maintenance.derivedFields.sampler.checkParent, {
			fieldId: entry.id,
			parentId,
			...(clock !== undefined ? { now: clock } : {}),
		});
	}
	const fields = {
		afterCreationTime: plan.afterCreationTime,
		rotations: (cursor?.rotations ?? 0) + (plan.wrapped ? 1 : 0),
		sampledCount: (cursor?.sampledCount ?? 0) + plan.picked.length,
		updatedAt: now,
	};
	if (cursor) await ctx.db.patch(cursor._id, fields);
	else await ctx.db.insert('derivedFieldCursors', { fieldId: entry.id, ...fields });
	return plan;
}

/** Cron: schedule the next sample of every derived field. */
export const sampleAll = internalMutation({
	args: {
		// Parents per field; DEFAULT_SAMPLE_SIZE when absent, clamped to MAX_SAMPLE_SIZE.
		sampleSize: v.optional(v.number()),
		// The instant eligibility is judged at, passed on to the checks; the real clock when absent.
		now: v.optional(v.number()),
	},
	returns: v.object({ scheduled: v.number() }),
	handler: async (ctx, args) => {
		// A workspace deletion empties these tables; a repair would be refused by
		// the write fence, and a recount of a half-emptied parent means nothing.
		if (await readActiveWorkspaceDeletion(ctx.db)) return { scheduled: 0 };
		const now = resolveNow(args.now);
		const sampleSize = clampSampleSize(args.sampleSize);
		let scheduled = 0;
		let wrapped = 0;
		for (const entry of DERIVED_ENTRIES) {
			const plan = await sampleField(ctx, entry, sampleSize, now, args.now);
			scheduled += plan.picked.length;
			if (plan.wrapped) wrapped += 1;
		}
		logEvent('derived_field.sampled', {
			detail: { fields: DERIVED_ENTRIES.length, scheduled, wrapped, sampleSize },
		});
		return { scheduled };
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
