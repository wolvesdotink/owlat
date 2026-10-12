/**
 * Coverage of the active embedding space (ADR-0073, D8): how many knowledge
 * entries and files vector search can find, and how many wait as unknown
 * (written before provenance), inactive (another space only) or unembedded.
 *
 * Convex cannot count rows without reading them, and a row carries up to two
 * 1536-wide vectors, so a live count would not fit a query. A bounded paged
 * walk counts instead and stores the result on the space
 * (`embeddingSpaces.coverage`), which the settings page reads (`status`). It
 * runs after a switch, an attestation or a finished re-embed, and at most daily
 * otherwise. The counts are a snapshot: rows written since are not in them.
 */

import { v, type Infer } from 'convex/values';
import { internal } from '../_generated/api';
import { internalAction, internalQuery, type MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { adminMutation } from '../lib/authedFunctions';
import { readActiveSpace, rowCoverage, type SpaceRef } from '../lib/aiRouting/embeddingRegistry';
import { embeddingCoverageValidator, embeddingTableValidator } from '../lib/validators/embedding';

type Coverage = Infer<typeof embeddingCoverageValidator>;
type Counts = Coverage['knowledgeEntries'];

const COVERAGE_PAGE_SIZE = 64;
/** Pages one action invocation walks before it reschedules itself. */
const PAGES_PER_RUN = 50;
/** A snapshot older than this is refreshed by the kickoff. */
const COVERAGE_MAX_AGE_MS = 24 * 60 * 60_000;

const countsValidator = v.object({
	active: v.number(),
	unknown: v.number(),
	inactive: v.number(),
	unembedded: v.number(),
});

const zero = (): Counts => ({ active: 0, unknown: 0, inactive: 0, unembedded: 0 });

/** One page of a table, counted against the active space. */
export const coveragePage = internalQuery({
	args: {
		table: embeddingTableValidator,
		cursor: v.union(v.string(), v.null()),
		spaceId: v.id('embeddingSpaces'),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.spaceId);
		const ref: SpaceRef | null = space ? { spaceId: space._id, slot: space.slot } : null;
		const page = await ctx.db
			.query(args.table)
			.paginate({ cursor: args.cursor, numItems: COVERAGE_PAGE_SIZE });
		const counts = zero();
		for (const row of page.page) counts[rowCoverage(row, ref)] += 1;
		return { counts, continueCursor: page.continueCursor, isDone: page.isDone };
	},
});

/** Walk both tables and store the counts on the space. Resumes itself in slices. */
export const scan = internalAction({
	args: {
		spaceId: v.id('embeddingSpaces'),
		table: embeddingTableValidator,
		cursor: v.union(v.string(), v.null()),
		knowledgeEntries: countsValidator,
		semanticFiles: countsValidator,
	},
	handler: async (ctx, args): Promise<void> => {
		const totals = { knowledgeEntries: args.knowledgeEntries, semanticFiles: args.semanticFiles };
		let table = args.table;
		let cursor = args.cursor;
		for (let pages = 0; pages < PAGES_PER_RUN; pages++) {
			const page = await ctx.runQuery(internal.aiRouting.embeddingCoverage.coveragePage, {
				table,
				cursor,
				spaceId: args.spaceId,
			});
			const sum = totals[table];
			for (const key of Object.keys(sum) as (keyof Counts)[]) sum[key] += page.counts[key];
			if (!page.isDone) {
				cursor = page.continueCursor;
				continue;
			}
			if (table === 'knowledgeEntries') {
				table = 'semanticFiles';
				cursor = null;
				continue;
			}
			await ctx.runMutation(internal.aiRouting.embeddingCoverage.saveCoverage, {
				spaceId: args.spaceId,
				coverage: { ...totals, measuredAt: Date.now() },
			});
			return;
		}
		await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingCoverage.scan, {
			spaceId: args.spaceId,
			table,
			cursor,
			...totals,
		});
	},
});

export const saveCoverage = internalMutation({
	args: { spaceId: v.id('embeddingSpaces'), coverage: embeddingCoverageValidator },
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.spaceId);
		if (!space) return;
		// Concurrent scans: the newest snapshot wins.
		if (space.coverage && space.coverage.measuredAt > args.coverage.measuredAt) return;
		await ctx.db.patch(space._id, { coverage: args.coverage, updatedAt: Date.now() });
	},
});

async function scheduleScan(ctx: MutationCtx, isForced: boolean): Promise<boolean> {
	const active = await readActiveSpace(ctx.db);
	if (!active) return false;
	const age = active.coverage ? Date.now() - active.coverage.measuredAt : Infinity;
	if (!isForced && age < COVERAGE_MAX_AGE_MS) return false;
	await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingCoverage.scan, {
		spaceId: active._id,
		table: 'knowledgeEntries',
		cursor: null,
		knowledgeEntries: zero(),
		semanticFiles: zero(),
	});
	return true;
}

/** Count the active space's coverage now (`isForced`), or when the snapshot is a day old. */
export const requestScan = internalMutation({
	args: { isForced: v.boolean() },
	handler: async (ctx, args): Promise<boolean> => scheduleScan(ctx, args.isForced),
});

/** The settings page's "count again". */
export const refresh = adminMutation({
	args: {},
	handler: async (ctx): Promise<boolean> => scheduleScan(ctx, true),
});
