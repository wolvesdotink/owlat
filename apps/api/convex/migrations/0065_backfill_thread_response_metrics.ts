/**
 * Back-fill the Team Inbox response history (migration 0065), so the response
 * analytics page has numbers for conversations from before response targets
 * shipped.
 *
 *   npx convex run migrations/0065_backfill_thread_response_metrics:run
 *
 * The analytics page also starts it the first time an admin opens it.
 *
 * TWO PASSES, one ledger row:
 *   1. `threads`: every conversation thread gets `firstResponseAt`, the time
 *      the earliest reply was sent: the first answered message's `processedAt`
 *      (stamped by its `→ sent` edge) or the first sent follow-up's `sentAt`,
 *      whichever came first. An earlier value replaces a later one, so a reply
 *      recorded live after the deploy never hides an older one.
 *   2. `resolutions`: every `thread.status_changed` audit row that resolved or
 *      closed a thread which is still resolved or closed sets `resolvedAt` to
 *      the latest such change.
 * Response-target hit rates have no history: no target existed to judge
 * against, so the back-fill leaves them alone.
 *
 * DURABLE AND RESUMABLE: progress and completion live in the migration ledger
 * (`migrationRuns` row `0065_backfill_thread_response_metrics`,
 * lib/migrationLedger.ts); the cursor carries its pass as a prefix. Running
 * `run` again on an unfinished pass resumes it; on a finished one it does
 * nothing (`'{"restart":true}'` starts over). Pages are idempotent: both
 * passes only ever move a value to the one the data implies.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { logInfo } from '../lib/runtimeLog';
import {
	beginMigrationRun,
	isCurrentMigrationPage,
	readMigrationRun,
	recordMigrationPage,
} from '../lib/migrationLedger';

export const MIGRATION = '0065_backfill_thread_response_metrics';
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.8';

/** Threads per page; each reads its messages until the first answered one. */
const THREAD_PAGE_SIZE = 25;
/** How many of a thread's messages pass 1 reads looking for the first reply. */
const MESSAGE_SCAN_LIMIT = 100;
/** Audit rows per page in pass 2; each loads at most one thread. */
const AUDIT_PAGE_SIZE = 200;

type Pass = 'threads' | 'resolutions';

/** The ledger cursor: `<pass>:<convex cursor>`, an empty cursor for a pass's first page. */
export function encodeCursor(pass: Pass, cursor: string | null): string {
	return `${pass}:${cursor ?? ''}`;
}

export function decodeCursor(stored: string | null | undefined): {
	pass: Pass;
	cursor: string | null;
} {
	if (!stored) return { pass: 'threads', cursor: null };
	const split = stored.indexOf(':');
	const pass = stored.slice(0, split) === 'resolutions' ? 'resolutions' : 'threads';
	const cursor = split === -1 ? null : stored.slice(split + 1);
	return { pass, cursor: cursor || null };
}

/** When the team first replied on this thread, from what the data recorded. */
async function earliestReplyAt(
	ctx: MutationCtx,
	thread: Doc<'conversationThreads'>
): Promise<number | undefined> {
	let earliest: number | undefined;
	let scanned = 0;
	for await (const message of ctx.db
		.query('inboundMessages')
		.withIndex('by_thread', (q) => q.eq('threadId', thread._id))) {
		if (++scanned > MESSAGE_SCAN_LIMIT) break;
		if (message.processingStatus === 'sent' && message.processedAt !== undefined) {
			earliest = message.processedAt;
			break;
		}
	}
	const followUps = await ctx.db
		.query('inboxFollowUps')
		.withIndex('by_thread', (q) => q.eq('threadId', thread._id))
		.take(MESSAGE_SCAN_LIMIT);
	for (const followUp of followUps) {
		if (followUp.status !== 'sent' || followUp.sentAt === undefined) continue;
		if (earliest === undefined || followUp.sentAt < earliest) earliest = followUp.sentAt;
	}
	return earliest;
}

async function threadsPage(ctx: MutationCtx, cursor: string | null) {
	const { page, continueCursor, isDone } = await ctx.db
		.query('conversationThreads')
		.paginate({ numItems: THREAD_PAGE_SIZE, cursor });
	let changed = 0;
	for (const thread of page) {
		const earliest = await earliestReplyAt(ctx, thread);
		if (earliest === undefined) continue;
		if (thread.firstResponseAt !== undefined && thread.firstResponseAt <= earliest) continue;
		await ctx.db.patch(thread._id, { firstResponseAt: earliest });
		changed++;
	}
	return { continueCursor, isDone, scanned: page.length, changed };
}

async function resolutionsPage(ctx: MutationCtx, cursor: string | null) {
	const { page, continueCursor, isDone } = await ctx.db
		.query('auditLogs')
		.withIndex('by_action_and_created_at', (q) => q.eq('action', 'thread.status_changed'))
		.paginate({ numItems: AUDIT_PAGE_SIZE, cursor });
	let changed = 0;
	for (const row of page) {
		const to = row.details?.['to'];
		if (to !== 'resolved' && to !== 'closed') continue;
		const threadId = row.resourceId
			? ctx.db.normalizeId('conversationThreads', row.resourceId)
			: null;
		const thread = threadId ? await ctx.db.get(threadId) : null;
		if (!thread || (thread.status !== 'resolved' && thread.status !== 'closed')) continue;
		if (thread.resolvedAt !== undefined && thread.resolvedAt >= row.createdAt) continue;
		await ctx.db.patch(thread._id, { resolvedAt: row.createdAt });
		changed++;
	}
	return { continueCursor, isDone, scanned: page.length, changed };
}

/** Run one page of the current pass and schedule the next one of the same run. */
export const processPage = internalMutation({
	args: { cursor: v.union(v.string(), v.null()), generation: v.number() },
	handler: async (ctx, args): Promise<{ isDone: boolean; isSuperseded?: boolean }> => {
		const run = await readMigrationRun(ctx, MIGRATION);
		if (!isCurrentMigrationPage(run, args.generation)) {
			logInfo('migration.0065_backfill_thread_response_metrics.superseded', {
				generation: args.generation,
			});
			return { isDone: false, isSuperseded: true };
		}
		const { pass, cursor } = decodeCursor(args.cursor);
		const result =
			pass === 'threads' ? await threadsPage(ctx, cursor) : await resolutionsPage(ctx, cursor);
		const next =
			pass === 'threads' && result.isDone
				? encodeCursor('resolutions', null)
				: encodeCursor(pass, result.continueCursor);
		const isDone = pass === 'resolutions' && result.isDone;
		await recordMigrationPage(ctx, run, {
			cursor: next,
			isDone,
			scanned: result.scanned,
			changed: result.changed,
		});
		logInfo('migration.0065_backfill_thread_response_metrics.page', {
			pass,
			scanned: result.scanned,
			changed: result.changed,
			isDone,
			generation: run.generation,
		});
		if (!isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.migrations['0065_backfill_thread_response_metrics'].processPage,
				{ cursor: next, generation: run.generation }
			);
		}
		return { isDone };
	},
});

/**
 * Begin (or resume, or with `restart` redo) the walk and schedule its first
 * page. Returns null when the migration has already completed.
 */
export async function beginResponseHistoryBackfill(
	ctx: MutationCtx,
	options: { cursor?: string | null; restart?: boolean } = {}
): Promise<{ generation: number } | null> {
	const begun = await beginMigrationRun(ctx, {
		migration: MIGRATION,
		introducedIn: INTRODUCED_IN,
		cursor: options.cursor,
		restart: options.restart,
	});
	if (!begun) return null;
	await ctx.scheduler.runAfter(
		0,
		internal.migrations['0065_backfill_thread_response_metrics'].processPage,
		{ cursor: begun.cursor ?? null, generation: begun.generation }
	);
	logInfo('migration.0065_backfill_thread_response_metrics.started', {
		cursor: begun.cursor ?? null,
		generation: begun.generation,
	});
	return { generation: begun.generation };
}

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
		const begun = await beginResponseHistoryBackfill(ctx, args);
		if (!begun) {
			return { started: false, reason: 'Already completed; pass restart to run it again' };
		}
		return { started: true, generation: begun.generation };
	},
});
