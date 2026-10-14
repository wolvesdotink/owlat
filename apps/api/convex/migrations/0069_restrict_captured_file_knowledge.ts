/**
 * Restrict knowledge that may hold captured mail, and give members back the
 * knowledge proven to come from an uploaded file (migration 0069, #1322).
 *
 *   npx convex run migrations/0069_restrict_captured_file_knowledge:run
 *
 * WHAT IS ALREADY SAFE WITHOUT IT. From the deploy on, a captured file keeps
 * its mailbox's permission (lib/semanticFileAccess.ts) and a capture whose
 * source is not recorded on the row stays with owners and admins for good: no
 * Message-ID is taken as proof of where a file came from, since a sender can
 * reuse one and a mailbox can hold it many times. Knowledge from ANY file stays
 * with owners and admins until it is proven to come from an upload
 * (inbox/access.ts `isInboxDerivedKnowledge`).
 *
 * WHAT IS NOT. Before this release, knowledge learned from a capture was
 * member-visible, so the daily dedup (knowledge/maintenance.ts) could fold it
 * into a member-visible entry and delete it. A merge appends the loser's
 * content on a new line (lib/knowledgeDedup.ts `mergeContent`) and leaves no
 * other trace: not the capture, which may be gone, nor the contact link, which
 * an edit can change. So this walk restricts, among the entries that existed
 * when it started, EVERY member-visible one whose content has more than one
 * line, whatever its source and whether or not any file still exists. Then a
 * single-line entry from an uploaded file is opened to members, and one from a
 * capture or a file that is gone is restricted.
 *
 * ONE SWEEP, BOUNDED: `knowledgeEntries` in creation order up to the time the
 * walk started (entries written after it come from this release), a few rows a
 * page and at most {@link PAGE_BYTES} read, since every row carries its
 * embedding. Each page records its cursor in the migration ledger
 * (`migrationRuns` row `0069_restrict_captured_file_knowledge`,
 * lib/migrationLedger.ts) before the next is scheduled, and a page always
 * advances past at least one row. Running `run` again on an unfinished walk
 * resumes it; on a finished one it does nothing (`'{"restart":true}'` starts
 * over with a new start time). Pages are idempotent.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { logInfo } from '../lib/runtimeLog';
import { isInboxDerivedKnowledge } from '../inbox/access';
import { resolveMemberAccess } from '../knowledge/entryDedupe';
import {
	beginMigrationRun,
	isCurrentMigrationPage,
	readMigrationRun,
	recordMigrationPage,
} from '../lib/migrationLedger';

export const MIGRATION = '0069_restrict_captured_file_knowledge';
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.13';
/** Rows per page at most. */
export const PAGE_SIZE = 16;
/** Bytes a page reads at most (rows carry 1536-float embeddings), well inside a transaction. */
export const PAGE_BYTES = 4 * 1024 * 1024;

/** The ledger cursor: `<walk start ms>:<convex cursor>`. */
export function encodeCursor(cutoff: number, cursor: string | null): string {
	return `${cutoff}:${cursor ?? ''}`;
}

export function decodeCursor(stored: string): { cutoff: number; cursor: string | null } {
	const split = stored.indexOf(':');
	return { cutoff: Number(stored.slice(0, split)), cursor: stored.slice(split + 1) || null };
}

/** Whether an entry's content could hold a merged-in loser (`mergeContent` appends on a new line). */
export function couldHoldMergedContent(entry: Pick<Doc<'knowledgeEntries'>, 'content'>): boolean {
	return entry.content.includes('\n');
}

/** What this walk writes for one entry, or null to leave it. */
export async function sweptAccess(
	ctx: Pick<MutationCtx, 'db'>,
	entry: Doc<'knowledgeEntries'>
): Promise<Doc<'knowledgeEntries'>['memberAccess'] | null> {
	if (entry.memberAccess === 'restricted') return null;
	if (
		couldHoldMergedContent(entry) &&
		(entry.sourceType === 'file' || !isInboxDerivedKnowledge(entry))
	) {
		return 'restricted';
	}
	if (entry.sourceType !== 'file' || entry.memberAccess === 'members') return null;
	return (await resolveMemberAccess(ctx, entry)) ?? null;
}

/** One page of the sweep; `maxBytes` is a parameter so a test can make it small. */
export async function sweepPage(
	ctx: MutationCtx,
	page: { cutoff: number; cursor: string | null; maxBytes?: number }
) {
	const result = await ctx.db
		.query('knowledgeEntries')
		.withIndex('by_creation_time', (q) => q.lt('_creationTime', page.cutoff))
		.paginate({
			numItems: PAGE_SIZE,
			cursor: page.cursor,
			maximumBytesRead: page.maxBytes ?? PAGE_BYTES,
		});
	let changed = 0;
	for (const entry of result.page) {
		const access = await sweptAccess(ctx, entry);
		if (access === null || access === entry.memberAccess) continue;
		await ctx.db.patch(entry._id, { memberAccess: access });
		changed++;
	}
	return { ...result, scanned: result.page.length, changed };
}

/** Run one page and schedule the next one of the same run. */
export const processPage = internalMutation({
	args: { cursor: v.string(), generation: v.number() },
	handler: async (ctx, args): Promise<{ isDone: boolean; isSuperseded?: boolean }> => {
		const run = await readMigrationRun(ctx, MIGRATION);
		if (!isCurrentMigrationPage(run, args.generation)) {
			logInfo('migration.0069_restrict_captured_file_knowledge.superseded', {
				generation: args.generation,
			});
			return { isDone: false, isSuperseded: true };
		}
		const { cutoff, cursor } = decodeCursor(args.cursor);
		const result = await sweepPage(ctx, { cutoff, cursor });
		const next = encodeCursor(cutoff, result.continueCursor);
		await recordMigrationPage(ctx, run, {
			cursor: next,
			isDone: result.isDone,
			scanned: result.scanned,
			changed: result.changed,
		});
		logInfo('migration.0069_restrict_captured_file_knowledge.page', {
			scanned: result.scanned,
			changed: result.changed,
			isDone: result.isDone,
			generation: run.generation,
		});
		if (!result.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.migrations['0069_restrict_captured_file_knowledge'].processPage,
				{ cursor: next, generation: run.generation }
			);
		}
		return { isDone: result.isDone };
	},
});

/**
 * Start the background walk, or resume an unfinished one from its recorded
 * cursor (or from `cursor` when given). A finished migration is left alone
 * unless `restart` is set.
 */
export const run = internalMutation({
	args: {
		cursor: v.optional(v.union(v.string(), v.null())),
		restart: v.optional(v.boolean()),
	},
	handler: async (
		ctx,
		args
	): Promise<{ started: boolean; generation?: number; reason?: string }> => {
		const begun = await beginMigrationRun(ctx, {
			migration: MIGRATION,
			introducedIn: INTRODUCED_IN,
			cursor: args.cursor,
			restart: args.restart,
		});
		if (!begun) {
			return { started: false, reason: 'Already completed; pass restart to run it again' };
		}
		const cursor = begun.cursor ?? encodeCursor(Date.now(), null);
		await ctx.scheduler.runAfter(
			0,
			internal.migrations['0069_restrict_captured_file_knowledge'].processPage,
			{ cursor, generation: begun.generation }
		);
		logInfo('migration.0069_restrict_captured_file_knowledge.started', {
			cursor,
			generation: begun.generation,
		});
		return { started: true, generation: begun.generation };
	},
});
