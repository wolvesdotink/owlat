/**
 * Restrict knowledge learned from captured mail attachments (migration 0069).
 *
 *   npx convex run migrations/0069_restrict_captured_file_knowledge:run
 *
 * A file captured from inbound mail keeps its mailbox's permission
 * (lib/semanticFileAccess.ts), and since this release so do the knowledge
 * entries extracted from it: `extractFromFile` stamps them with the file's
 * `captureSource`, which makes them Team Inbox-derived (inbox/access.ts) and
 * shows them to shared-inbox readers only. Entries extracted before that
 * carry no marker and are still shown to every member. This walk stamps them.
 *
 * TWO PASSES, one ledger row: the Team Inbox captures, then the Postbox ones,
 * each read through `by_attachment_retention` (whose first field is
 * `captureSource`), so files a person uploaded are never read. Every entry
 * extracted from such a file (`by_source`, `sourceType: 'file'`) without the
 * marker gets the file's. Nothing else on the entry changes.
 *
 * The files themselves need no walk: a Postbox capture stored before its
 * mailbox was recorded is already shown to owners and admins only.
 *
 * DURABLE AND RESUMABLE: progress and completion live in the migration ledger
 * (`migrationRuns` row `0069_restrict_captured_file_knowledge`,
 * lib/migrationLedger.ts); the cursor carries its pass as a prefix. Running
 * `run` again on an unfinished walk resumes it; on a finished one it does
 * nothing (`'{"restart":true}'` starts over). Pages are idempotent: a stamped
 * entry is skipped.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import type { CaptureSource } from '../lib/literalValidators';
import { logInfo } from '../lib/runtimeLog';
import {
	beginMigrationRun,
	isCurrentMigrationPage,
	readMigrationRun,
	recordMigrationPage,
} from '../lib/migrationLedger';

export const MIGRATION = '0069_restrict_captured_file_knowledge';
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.13';
/** Captured files per page; each reads the few entries extracted from it. */
const PAGE_SIZE = 50;

const PASSES: readonly CaptureSource[] = ['team_inbox', 'mailbox'];

/** The ledger cursor: `<pass>:<convex cursor>`, an empty cursor for a pass's first page. */
export function encodeCursor(pass: CaptureSource, cursor: string | null): string {
	return `${pass}:${cursor ?? ''}`;
}

export function decodeCursor(stored: string | null | undefined): {
	pass: CaptureSource;
	cursor: string | null;
} {
	if (!stored) return { pass: PASSES[0]!, cursor: null };
	const split = stored.indexOf(':');
	const pass = stored.slice(0, split) === 'mailbox' ? 'mailbox' : 'team_inbox';
	const cursor = split === -1 ? null : stored.slice(split + 1);
	return { pass, cursor: cursor || null };
}

async function page(ctx: MutationCtx, pass: CaptureSource, cursor: string | null) {
	const result = await ctx.db
		.query('semanticFiles')
		.withIndex('by_attachment_retention', (q) => q.eq('captureSource', pass))
		.paginate({ numItems: PAGE_SIZE, cursor });
	let changed = 0;
	for (const file of result.page) {
		const entries = await ctx.db
			.query('knowledgeEntries')
			.withIndex('by_source', (q) => q.eq('sourceType', 'file').eq('sourceId', file._id))
			.collect(); // bounded: entries extracted from one file
		for (const entry of entries) {
			if (entry.captureSource !== undefined) continue;
			// A visibility marker, not an edit: `updatedAt` stays as it was.
			await ctx.db.patch(entry._id, { captureSource: pass });
			changed++;
		}
	}
	return { ...result, scanned: result.page.length, changed };
}

/** Run one page of the current pass and schedule the next one of the same run. */
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
		const { pass, cursor } = decodeCursor(args.cursor);
		const result = await page(ctx, pass, cursor);
		const isLastPass = pass === PASSES[PASSES.length - 1];
		const next =
			result.isDone && !isLastPass
				? encodeCursor('mailbox', null)
				: encodeCursor(pass, result.continueCursor);
		const isDone = isLastPass && result.isDone;
		await recordMigrationPage(ctx, run, {
			cursor: next,
			isDone,
			scanned: result.scanned,
			changed: result.changed,
		});
		logInfo('migration.0069_restrict_captured_file_knowledge.page', {
			pass,
			scanned: result.scanned,
			changed: result.changed,
			isDone,
			generation: run.generation,
		});
		if (!isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.migrations['0069_restrict_captured_file_knowledge'].processPage,
				{ cursor: next, generation: run.generation }
			);
		}
		return { isDone };
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
		await ctx.scheduler.runAfter(
			0,
			internal.migrations['0069_restrict_captured_file_knowledge'].processPage,
			{ cursor: begun.cursor ?? null, generation: begun.generation }
		);
		logInfo('migration.0069_restrict_captured_file_knowledge.started', {
			cursor: begun.cursor ?? null,
			generation: begun.generation,
		});
		return { started: true, generation: begun.generation };
	},
});
