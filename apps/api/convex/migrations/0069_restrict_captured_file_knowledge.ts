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
 * walk started — the ledger row's `startedAt`, written before the first page is
 * scheduled and kept by every resume, so a second `run` cannot move it (entries
 * written after it come from this release). A page stops after
 * {@link PAGE_SIZE} entries or {@link PAGE_BYTES} read, counting the entries
 * (each carries its embedding) and the source files it looks up, and always
 * handles at least one entry. Each page records its position in the migration
 * ledger (`migrationRuns` row `0069_restrict_captured_file_knowledge`,
 * lib/migrationLedger.ts) before the next is scheduled. Running `run` again on
 * an unfinished walk resumes it; on a finished one it does nothing
 * (`'{"restart":true}'` starts over with a new start time). Pages are idempotent.
 */

import { getDocumentSize, v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { logInfo } from '../lib/runtimeLog';
import { isInboxDerivedKnowledge } from '../inbox/access';
import { isMailCapture } from '../lib/semanticFileAccess';
import {
	beginMigrationRun,
	isCurrentMigrationPage,
	readMigrationRun,
	recordMigrationPage,
} from '../lib/migrationLedger';

export const MIGRATION = '0069_restrict_captured_file_knowledge';
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.13';
/** Entries a page handles at most. */
export const PAGE_SIZE = 32;
/**
 * Bytes a page reads before it stops: the entries (each carries a 1536-float
 * embedding) AND the source files it looks up. The check runs before each
 * entry, so one entry and its file (a document is at most 1 MiB each) and the
 * next entry read can still be added: a page reads under 10 MiB, inside the
 * 16 MiB a transaction may read.
 */
export const PAGE_BYTES = 8 * 1024 * 1024;

/** Where the sweep stands: just after the entry created at `time` with id `id`. */
export type SweepPosition = { time: number; id: Id<'knowledgeEntries'> };

/** The ledger cursor: `<_creationTime>:<_id>` of the last entry handled, or '' at the start. */
export function encodeCursor(position: SweepPosition | null): string {
	return position ? `${position.time}:${position.id}` : '';
}

export function decodeCursor(stored: string | null | undefined): SweepPosition | null {
	const split = stored ? stored.indexOf(':') : -1;
	if (!stored || split === -1) return null;
	return {
		time: Number(stored.slice(0, split)),
		id: stored.slice(split + 1) as Id<'knowledgeEntries'>,
	};
}

/** Whether an entry's content could hold a merged-in loser (`mergeContent` appends on a new line). */
export function couldHoldMergedContent(entry: Pick<Doc<'knowledgeEntries'>, 'content'>): boolean {
	return entry.content.includes('\n');
}

/** Reads the source files of one page, each once, counting the bytes read. */
class SourceFiles {
	bytes = 0;
	private readonly seen = new Map<string, Doc<'semanticFiles'> | null>();
	constructor(private readonly ctx: Pick<MutationCtx, 'db'>) {}

	/** For a file entry: `members` for an upload, `restricted` for a capture or a gone file. */
	async accessOf(entry: Doc<'knowledgeEntries'>): Promise<'members' | 'restricted'> {
		const fileId = entry.sourceId ? this.ctx.db.normalizeId('semanticFiles', entry.sourceId) : null;
		if (!fileId) return 'restricted';
		if (!this.seen.has(fileId)) {
			const file = await this.ctx.db.get(fileId);
			if (file) this.bytes += getDocumentSize(file);
			this.seen.set(fileId, file);
		}
		const file = this.seen.get(fileId);
		return file && !isMailCapture(file) ? 'members' : 'restricted';
	}
}

/** What this walk writes for one entry, or null to leave it. */
async function sweptAccess(
	files: SourceFiles,
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
	return await files.accessOf(entry);
}

/**
 * One page of the sweep: the entries created before `cutoff`, from just after
 * `after`, until the page has handled {@link PAGE_SIZE} entries or read
 * `maxBytes` (entries and source files together). At least one entry is
 * handled, so a resume always advances. The position is the last entry handled;
 * entries sharing its creation time that come before it are not handled twice,
 * except when it was deleted since, when they are (a page is idempotent).
 */
export async function sweepPage(
	ctx: MutationCtx,
	page: { cutoff: number; after: SweepPosition | null; maxBytes?: number }
): Promise<{
	after: SweepPosition | null;
	isDone: boolean;
	scanned: number;
	changed: number;
	bytesRead: number;
}> {
	const { cutoff, after } = page;
	const maxBytes = page.maxBytes ?? PAGE_BYTES;
	const rows = ctx.db
		.query('knowledgeEntries')
		.withIndex('by_creation_time', (q) =>
			after
				? q.gte('_creationTime', after.time).lt('_creationTime', cutoff)
				: q.lt('_creationTime', cutoff)
		);
	const files = new SourceFiles(ctx);
	let entryBytes = 0;
	let last = after;
	let scanned = 0;
	let changed = 0;
	// Entries tied with `after`'s creation time, read before `after` itself.
	let held: Doc<'knowledgeEntries'>[] = [];
	let isPastAfter = after === null;

	const handle = async (entry: Doc<'knowledgeEntries'>): Promise<void> => {
		const access = await sweptAccess(files, entry);
		if (access !== null && access !== entry.memberAccess) {
			await ctx.db.patch(entry._id, { memberAccess: access });
			changed++;
		}
		scanned++;
		last = { time: entry._creationTime, id: entry._id };
	};

	for await (const entry of rows) {
		entryBytes += getDocumentSize(entry);
		if (!isPastAfter && after) {
			if (entry._creationTime === after.time) {
				if (entry._id === after.id) {
					isPastAfter = true;
					held = []; // handled before `after`, by an earlier page
				} else {
					held.push(entry);
				}
				continue;
			}
			// `after` is gone: handle its ties again rather than skip one.
			isPastAfter = true;
			for (const tie of held) await handle(tie);
		}
		if (scanned > 0 && (scanned >= PAGE_SIZE || entryBytes + files.bytes >= maxBytes)) {
			return { after: last, isDone: false, scanned, changed, bytesRead: entryBytes + files.bytes };
		}
		await handle(entry);
	}
	if (!isPastAfter) for (const tie of held) await handle(tie);
	return { after: last, isDone: true, scanned, changed, bytesRead: entryBytes + files.bytes };
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
		const result = await sweepPage(ctx, {
			cutoff: run.startedAt,
			after: decodeCursor(args.cursor),
		});
		const next = encodeCursor(result.after);
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
		const cursor = begun.cursor ?? null;
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
