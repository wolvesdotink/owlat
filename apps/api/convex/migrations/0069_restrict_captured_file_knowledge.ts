/**
 * Restrict the knowledge a historical merge may have written private text
 * into (migration 0069).
 *
 *   npx convex run migrations/0069_restrict_captured_file_knowledge:run
 *
 * WHAT IS ALREADY SAFE WITHOUT IT. From the deploy on, a captured file keeps
 * its mailbox's permission (lib/semanticFileAccess.ts) and a capture whose
 * source is not recorded on the row stays with owners and admins for good: no
 * Message-ID is taken as proof of where a file came from. Every knowledge write
 * stamps `memberAccess` from its source (knowledge/entryDedupe.ts
 * `resolveMemberAccess`), a merge never widens it, and the dedup leaves rows
 * without the stamp (written before this release) alone, so no merge can move
 * old text into a newer member-visible entry while this walk is under way
 * (knowledge/maintenance.ts).
 *
 * WHAT IS NOT. Before this release, knowledge learned from a capture was
 * member-visible, and before 2026-09-29 the dedup did not keep Team Inbox
 * knowledge apart either (`9b5732a64`). The daily dedup (`knowledge/
 * maintenance.ts` `dedupeContactEntries`) folds a loser into a survivor and
 * deletes the loser: the survivor takes the loser's content (on a new line, or
 * not at all when it already contains it), its tags and its contact links.
 * Nothing records that a merge happened, and an edit can rewrite the content
 * afterwards. So no property of an entry today proves it never took in
 * private text, and that includes Team Inbox entries, which a personal
 * capture's facts could have been folded into.
 *
 * WHICH ENTRIES A MERGE COULD REACH. Every version of the dedup, from 0.1.0
 * on, clusters the entries linked to one contact (`knowledgeEntryContacts`)
 * that carry a vector, of ANY source type, and picks the survivor by
 * confidence alone. Any entry can carry a contact link: `updateEntry` sets
 * `contactIds` on every entry a member may edit (on a curated answer, an
 * admin), and a contact merge repoints them. So no source type (file, email,
 * chat, manual, curated, Team Inbox) is provably out of a merge's reach, and
 * none is exempt.
 *
 * THE RULE (Marcel, 2026-10-14): every entry that existed when the walk
 * started becomes owner/admin-only (`memberAccess: 'restricted'`), whatever its
 * source, content, tags or source file. The walk never opens anything. The
 * Team Inbox agent still reads them: its retrieval includes what is kept from
 * members (`includeInboxDerived: true`). Entries written after the walk started
 * follow the write-time rules. An owner or admin who wants members to see one
 * again shares it after reviewing it (knowledge/sharing.ts), unless its
 * source keeps it from members. A `restart` restricts shared entries again.
 *
 * ONE SWEEP, BOUNDED: `knowledgeEntries` in creation order up to the time the
 * walk started, the ledger row's `startedAt`, written before the first page is
 * scheduled and kept by every resume, so a second `run` cannot move it. Each
 * page is ONE `paginate` (its cursor survives ties and deletions) of at most
 * {@link PAGE_SIZE} entries and about {@link PAGE_BYTES} read; see there for
 * why that stays inside a transaction. Each page records its cursor in the
 * migration ledger (`migrationRuns` row `0069_restrict_captured_file_knowledge`,
 * lib/migrationLedger.ts) before the next is scheduled. Running `run` again on
 * an unfinished walk resumes it; on a finished one it does nothing
 * (`'{"restart":true}'` starts over with a new start time). Pages are idempotent.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { logInfo } from '../lib/runtimeLog';
import {
	beginMigrationRun,
	isCurrentMigrationPage,
	readMigrationRun,
	recordMigrationPage,
	scheduleMigrationPage,
} from '../lib/migrationLedger';

export const MIGRATION = '0069_restrict_captured_file_knowledge';
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.13';
/** Entries a page reads at most. */
export const PAGE_SIZE = 4;
/**
 * Bytes a page's `paginate` reads before it stops early (`maximumBytesRead`;
 * every row carries a 1536-float embedding). A page reads at most
 * {@link PAGE_SIZE} documents of at most 1 MiB, so under 4 MiB, and patching
 * each re-reads it, under 4 MiB more; with the ledger row that stays far inside
 * the 16 MiB a transaction may read, and the writes under 4 MiB.
 */
export const PAGE_BYTES = 2 * 1024 * 1024;

/** What this walk writes for one entry that existed when it started. */
export function sweptAccess(
	entry: Pick<Doc<'knowledgeEntries'>, 'memberAccess'>
): 'restricted' | null {
	return entry.memberAccess === 'restricted' ? null : 'restricted';
}

/** One page of the sweep: one `paginate` over the entries created before `cutoff`. */
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
		const access = sweptAccess(entry);
		if (access === null) continue;
		await ctx.db.patch(entry._id, { memberAccess: access });
		changed++;
	}
	return {
		cursor: result.continueCursor,
		isDone: result.isDone,
		scanned: result.page.length,
		changed,
	};
}

/** Run one page and schedule the next one of the same run. */
export const processPage = internalMutation({
	args: { cursor: v.union(v.string(), v.null()), generation: v.number() },
	handler: async (ctx, args): Promise<{ isDone: boolean; isSuperseded?: boolean }> => {
		const run = await readMigrationRun(ctx, MIGRATION);
		if (!isCurrentMigrationPage(run, args.generation)) {
			logInfo('migration.0069_restrict_captured_file_knowledge.superseded', {
				generation: args.generation,
			});
			return { isDone: false, isSuperseded: true };
		}
		// The walk covers what existed when it was started. The start time lives
		// on the ledger row, written before the first page is scheduled and kept
		// by every resume, so a second `run` cannot move it.
		const result = await sweepPage(ctx, { cutoff: run.startedAt, cursor: args.cursor });
		await recordMigrationPage(ctx, run, {
			cursor: result.cursor,
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
			await scheduleMigrationPage(
				ctx,
				run,
				0,
				internal.migrations['0069_restrict_captured_file_knowledge'].processPage,
				{ cursor: result.cursor, generation: run.generation }
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
		const cursor = begun.cursor ?? null;
		await scheduleMigrationPage(
			ctx,
			begun,
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
