/**
 * Embedding coverage (ADR-0073, D8): how many knowledge entries and files
 * vector search can find, and how many wait as unknown (written before
 * provenance), inactive (another space only) or unembedded.
 *
 * Counted against the space retrieval really searches (`readSearchableSpace`:
 * active AND still configured), or against none: with no searchable space (a
 * first upgrade, or a switch whose first vector has not landed) every vector
 * counts as not findable, which is exactly what retrieval does.
 *
 * Convex cannot count rows without reading them, and a row carries up to two
 * 1536-wide vectors, so a live count would not fit a query. A bounded paged
 * walk counts instead and stores the result in the `embeddingCoverage`
 * singleton, which the settings page reads (`status`). It runs after a switch,
 * an attestation, a slot move or a finished re-embed, and at most daily
 * otherwise. The counts are a snapshot: rows written since are not in them.
 * Of the rows outside the space it also counts the re-embed candidates (rows
 * the job embeds, by its own rule) apart from the rows the job skips.
 */

import { v, type Infer } from 'convex/values';
import { internal } from '../_generated/api';
import { internalAction, internalQuery, type MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { adminMutation } from '../lib/authedFunctions';
import {
	readSearchableSpace,
	rowCoverage,
	type SpaceRef,
} from '../lib/aiRouting/embeddingRegistry';
import {
	embeddingCoverageCountsValidator,
	embeddingCoverageFields,
	embeddingTableValidator,
} from '../lib/validators/embedding';
import { corpusRowInput } from '../lib/aiRouting/embeddingInputs';

type Counts = Infer<typeof embeddingCoverageFields.knowledgeEntries>;

const COVERAGE_PAGE_SIZE = 64;
/** Pages one action invocation walks before it reschedules itself. */
const PAGES_PER_RUN = 50;
/** A snapshot older than this is refreshed by the kickoff. */
const COVERAGE_MAX_AGE_MS = 24 * 60 * 60_000;

type FullCounts = Required<Counts>;

const zero = (): FullCounts => ({
	active: 0,
	unknown: 0,
	inactive: 0,
	unembedded: 0,
	reembedCandidates: 0,
	reembedSkipped: 0,
});

/** Whether a walk's running totals carry every count (one scheduled before the candidate counts did not). */
function isFull(counts: Counts): counts is FullCounts {
	return counts.reembedCandidates !== undefined && counts.reembedSkipped !== undefined;
}

/** One page of a table, counted against the searchable space (or none). */
export const coveragePage = internalQuery({
	args: {
		table: embeddingTableValidator,
		cursor: v.union(v.string(), v.null()),
		spaceId: v.optional(v.id('embeddingSpaces')),
	},
	handler: async (ctx, args) => {
		const space = args.spaceId ? await ctx.db.get(args.spaceId) : null;
		const ref: SpaceRef | null = space ? { spaceId: space._id, slot: space.slot } : null;
		const page = await ctx.db
			.query(args.table)
			.paginate({ cursor: args.cursor, numItems: COVERAGE_PAGE_SIZE });
		const counts = zero();
		const now = Date.now();
		for (const row of page.page) {
			const coverage = rowCoverage(row, ref);
			counts[coverage] += 1;
			if (coverage === 'active') continue;
			// The re-embed job's rule (`reembedPage`): outside the space, embedded
			// when the row has an input, skipped otherwise.
			if (corpusRowInput(args.table, row, now) !== null) counts.reembedCandidates += 1;
			else counts.reembedSkipped += 1;
		}
		return { counts, continueCursor: page.continueCursor, isDone: page.isDone };
	},
});

/** Walk both tables and store the counts. Resumes itself in slices. */
export const scan = internalAction({
	args: {
		spaceId: v.optional(v.id('embeddingSpaces')),
		startedAt: v.number(),
		table: embeddingTableValidator,
		cursor: v.union(v.string(), v.null()),
		knowledgeEntries: embeddingCoverageCountsValidator,
		semanticFiles: embeddingCoverageCountsValidator,
	},
	handler: async (ctx, args): Promise<void> => {
		// A walk scheduled before the candidate counts existed starts over, so
		// every stored count covers the same rows.
		const isResumable = isFull(args.knowledgeEntries) && isFull(args.semanticFiles);
		const totals = {
			knowledgeEntries:
				isFull(args.knowledgeEntries) && isResumable ? args.knowledgeEntries : zero(),
			semanticFiles: isFull(args.semanticFiles) && isResumable ? args.semanticFiles : zero(),
		};
		let table = isResumable ? args.table : 'knowledgeEntries';
		let cursor = isResumable ? args.cursor : null;
		for (let pages = 0; pages < PAGES_PER_RUN; pages++) {
			const page = await ctx.runQuery(internal.aiRouting.embeddingCoverage.coveragePage, {
				table,
				cursor,
				spaceId: args.spaceId,
			});
			const sum = totals[table];
			for (const key of Object.keys(sum) as (keyof FullCounts)[]) sum[key] += page.counts[key];
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
				...totals,
				searchableSpaceId: args.spaceId,
				measuredAt: args.startedAt,
			});
			return;
		}
		await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingCoverage.scan, {
			...args,
			table,
			cursor,
			...totals,
		});
	},
});

/** The stored count, or null before the first walk finished. */
export async function readCoverage(db: MutationCtx['db']) {
	return db.query('embeddingCoverage').first(); // bounded: singleton
}

export const saveCoverage = internalMutation({
	args: {
		...embeddingCoverageFields,
		searchableSpaceId: v.optional(v.id('embeddingSpaces')),
	},
	handler: async (ctx, args) => {
		const stored = await readCoverage(ctx.db);
		// Concurrent walks: the one that started last wins.
		if (stored && stored.measuredAt > args.measuredAt) return;
		if (stored) await ctx.db.replace(stored._id, args);
		else await ctx.db.insert('embeddingCoverage', args);
	},
});

async function scheduleScan(ctx: MutationCtx, isForced: boolean): Promise<boolean> {
	const searchable = await readSearchableSpace(ctx.db);
	const stored = await readCoverage(ctx.db);
	const isCurrent =
		stored !== null &&
		stored.searchableSpaceId === searchable?._id &&
		Date.now() - stored.measuredAt < COVERAGE_MAX_AGE_MS;
	if (!isForced && isCurrent) return false;
	await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingCoverage.scan, {
		...(searchable ? { spaceId: searchable._id } : {}),
		startedAt: Date.now(),
		table: 'knowledgeEntries',
		cursor: null,
		knowledgeEntries: zero(),
		semanticFiles: zero(),
	});
	return true;
}

/** Count coverage now (`isForced`), or when the count is a day old or the searchable space moved. */
export const requestScan = internalMutation({
	args: { isForced: v.boolean() },
	handler: async (ctx, args): Promise<boolean> => scheduleScan(ctx, args.isForced),
});

/** The settings page's "count again". */
export const refresh = adminMutation({
	args: {},
	handler: async (ctx): Promise<boolean> => scheduleScan(ctx, true),
});
