/**
 * Reading a thread's earlier mail (ADR-0072, D5): the 30-day backfill walk
 * (`backfill.ts`) and the first open of an older thread (`lazy.ts`) both hand
 * a thread's history to interpretation through {@link enqueueHistoryPage}.
 *
 * The history is read newest first, one page of {@link HISTORY_PAGE} messages
 * per transaction, with a durable cursor on the thread's brief row
 * (`threadBriefs.historyCursor`: the position of the last message read, as
 * `<sort time>:<creation time>`; no `.paginate()`, so the walk's own page
 * query stays the transaction's only one). While pages remain, `historyState` is
 * `pending`, `brief.get` reads the brief as partial ("the rest is still being
 * read"), and `continueHistory` (`backfill.ts`) reads the next page once the
 * runs this page scheduled had their turn. A refused spend gate stops the
 * chain with the cursor kept; the next walk or first open resumes it.
 *
 * What a page admits:
 *   - a Postbox message: inbound mail through `interpretMessage`; our own
 *     sent mail only once its transport recorded it sent (`outbound.state`
 *     `sent` or `partial`, or a stored Sent copy) and through
 *     `outboundRun.interpretSent`, which reconciles failed recipients after
 *     the run, the same as a live send;
 *   - a Team Inbox message: the customer's email, and each reply or
 *     follow-up that durably went out, from its sent-text snapshot through
 *     `outboundRun.interpretSent`. A reply sent before snapshots existed
 *     cannot be read back as sent; the brief is marked
 *     `isHistoryIncomplete` and stays partial.
 *
 * Each admitted source gets its eligibility snapshot (`sources.ts`), taken
 * as `isLive: true`: the delivery path's `not_live` rule keeps a history
 * import from being read on arrival, and these were admitted on purpose.
 * Folder, mute and bulk rules still apply in the run. A source that already
 * has a snapshot (inbound) or an extraction (team replies) is left alone.
 *
 * What it never does: notify anyone, or put a thread back in the Reply Queue.
 * The runs write the brief and its list projection only.
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import {
	interpretationSourceKey,
	type InterpretationSource,
} from '../../lib/validators/threadBrief';
import type { ThreadRef } from '../../lib/validators/threadRef';
import { ensureBriefRow, markBriefPending } from './briefRow';
import { captureInterpretSource, loadInterpretSource } from './sources';

/** Messages of one thread read per page. */
export const HISTORY_PAGE = 4;
/** Spacing between scheduled runs. */
export const RUN_SPACING_MS = 1_500;
/** Pause after a page's runs before the next page is read. */
export const HISTORY_PAGE_INTERVAL_MS = 30_000;
/** A pending history that has not moved for this long has lost its chain. */
export const HISTORY_STALE_MS = 15 * 60_000;
/** Follow-ups of one Team Inbox thread read on its last page. */
const FOLLOW_UP_SCAN = 100;

/** Folder roles a thread can sit in and still be "active" (D5). */
const INACTIVE_ROLES: ReadonlySet<string> = new Set(['archive', 'trash', 'spam', 'junk']);
/** Folders whose messages are never picked. */
const SKIPPED_ROLES: ReadonlySet<string> = new Set(['trash', 'spam', 'junk', 'drafts']);
/** Team Send statuses that mean the reply went out. */
const SENT_STATUSES: ReadonlySet<string> = new Set([
	'sent',
	'delivered',
	'opened',
	'clicked',
	'complained',
]);

/**
 * An active thread (D5): not muted, not the Daily Brief's own mail, and not
 * archived or trashed (in the inbox, or in no archive/trash/spam folder at
 * all, which keeps threads that live only in Sent or a custom folder). Pure.
 */
export function isActiveThread(
	thread: Pick<Doc<'mailThreads'>, 'folderRoles' | 'mutedAt' | 'isSelfDeliveredBrief'>
): boolean {
	if (thread.mutedAt !== undefined || thread.isSelfDeliveredBrief) return false;
	if (thread.folderRoles.includes('inbox')) return true;
	return !thread.folderRoles.some((role) => INACTIVE_ROLES.has(role));
}

/**
 * How a stored Postbox message is admitted: our own sent mail is
 * `outboundMail` and only once it durably went out; everything else `mail`.
 * Null for a send still queued or one that failed for every recipient. Pure.
 */
export function mailSourceOf(
	message: Pick<Doc<'mailMessages'>, '_id' | 'outbound' | 'sentByUserId'>,
	folderRole: string | undefined
): InterpretationSource | null {
	if (message.outbound) {
		const state = message.outbound.state;
		return state === 'sent' || state === 'partial'
			? { kind: 'outboundMail', id: message._id }
			: null;
	}
	const isOurs = message.sentByUserId !== undefined || folderRole === 'sent';
	return { kind: isOurs ? 'outboundMail' : 'mail', id: message._id };
}

/** Whether a source was read already (it has an extraction). */
async function isExtracted(ctx: MutationCtx, source: InterpretationSource): Promise<boolean> {
	const row = await ctx.db
		.query('messageInterpretations')
		.withIndex('by_source_counted', (q) => q.eq('sourceKey', interpretationSourceKey(source)))
		.first();
	return row !== null;
}

/** Whether either source kind of a Postbox message already has a snapshot. */
async function isMailMessageTaken(ctx: MutationCtx, id: Id<'mailMessages'>): Promise<boolean> {
	const [asMail, asOutbound] = await Promise.all([
		loadInterpretSource(ctx, { kind: 'mail', id }),
		loadInterpretSource(ctx, { kind: 'outboundMail', id }),
	]);
	return asMail !== null || asOutbound !== null;
}

/** A position in a thread's newest-first order: `<sort time>:<creation time>`. */
export function encodeHistoryCursor(at: number, creationTime: number): string {
	return `${at}:${creationTime}`;
}

export function decodeHistoryCursor(
	cursor: string | null
): { at: number; creation: number } | null {
	if (!cursor) return null;
	const [at, creation] = cursor.split(':').map(Number);
	return Number.isFinite(at) && Number.isFinite(creation) ? { at: at!, creation: creation! } : null;
}

/** Strictly after the cursor in newest-first order (ties broken by creation time). Pure. */
export function isPastCursor(
	row: { at: number; creation: number },
	cursor: { at: number; creation: number } | null
): boolean {
	return !cursor || row.at < cursor.at || (row.at === cursor.at && row.creation < cursor.creation);
}

/** What one page found to read, oldest first, and whether some history is unreadable. */
interface PageSources {
	sources: InterpretationSource[];
	isUnreadable: boolean;
	continueCursor: string;
	isDone: boolean;
}

async function mailPage(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	cursor: string | null
): Promise<PageSources> {
	const from = decodeHistoryCursor(cursor);
	const page: Doc<'mailMessages'>[] = [];
	for await (const message of ctx.db
		.query('mailMessages')
		.withIndex('by_thread_and_received', (q) =>
			from ? q.eq('threadId', threadId).lte('receivedAt', from.at) : q.eq('threadId', threadId)
		)
		.order('desc')) {
		if (!isPastCursor({ at: message.receivedAt, creation: message._creationTime }, from)) continue;
		page.push(message);
		if (page.length > HISTORY_PAGE) break;
	}
	const isDone = page.length <= HISTORY_PAGE;
	const read = page.slice(0, HISTORY_PAGE);
	const sources: InterpretationSource[] = [];
	for (const message of read) {
		if (message.flagDraft) continue;
		const folder = await ctx.db.get(message.folderId);
		if (folder?.role && SKIPPED_ROLES.has(folder.role)) continue;
		if (await isMailMessageTaken(ctx, message._id)) continue;
		const source = mailSourceOf(message, folder?.role);
		if (source) sources.push(source);
	}
	const last = read[read.length - 1];
	return {
		sources: sources.reverse(),
		isUnreadable: false,
		continueCursor: last ? encodeHistoryCursor(last.receivedAt, last._creationTime) : '',
		isDone,
	};
}

/**
 * A team Send that went out: its snapshot source when it was not read yet,
 * `unreadable` when it has no snapshot to read, else null.
 */
async function teamReplySource(
	ctx: MutationCtx,
	send: Doc<'transactionalSends'>
): Promise<InterpretationSource | 'unreadable' | null> {
	if (!SENT_STATUSES.has(send.status)) return null;
	const source = { kind: 'teamReply' as const, id: send._id };
	const captured = await loadInterpretSource(ctx, source);
	if (!captured?.snapshot) return 'unreadable';
	return (await isExtracted(ctx, source)) ? null : source;
}

async function teamPage(
	ctx: MutationCtx,
	threadId: Id<'conversationThreads'>,
	cursor: string | null
): Promise<PageSources> {
	const from = decodeHistoryCursor(cursor);
	const fetched = await ctx.db
		.query('inboundMessages')
		.withIndex('by_thread', (q) =>
			from
				? q.eq('threadId', threadId).lt('_creationTime', from.creation)
				: q.eq('threadId', threadId)
		)
		.order('desc')
		.take(HISTORY_PAGE + 1);
	const isDone = fetched.length <= HISTORY_PAGE;
	const read = fetched.slice(0, HISTORY_PAGE);
	const newestFirst: InterpretationSource[] = [];
	let isUnreadable = false;
	for (const message of read) {
		const replies: InterpretationSource[] = [];
		let sendCount = 0;
		for await (const send of ctx.db
			.query('transactionalSends')
			.withIndex('by_inbound_message', (q) => q.eq('inboundMessageId', message._id))) {
			if (send.kind !== 'agent_reply' && send.kind !== 'team_reply') continue;
			sendCount++;
			const reply = await teamReplySource(ctx, send);
			if (reply === 'unreadable') isUnreadable = true;
			else if (reply) replies.push(reply);
		}
		// A reply from before Sends existed: approved and sent, nothing to read it from.
		if (sendCount === 0 && message.processingStatus === 'sent') isUnreadable = true;
		newestFirst.push(...replies);
		const inbound = { kind: 'inbound' as const, id: message._id };
		if (!(await loadInterpretSource(ctx, inbound))) newestFirst.push(inbound);
	}
	if (isDone) {
		// Human follow-ups hang off the thread, not off one message: read them last.
		const followUps = await ctx.db
			.query('inboxFollowUps')
			.withIndex('by_thread', (q) => q.eq('threadId', threadId))
			.take(FOLLOW_UP_SCAN + 1);
		if (followUps.length > FOLLOW_UP_SCAN) isUnreadable = true;
		for (const followUp of followUps.slice(0, FOLLOW_UP_SCAN)) {
			const send = followUp.sendId ? await ctx.db.get(followUp.sendId) : null;
			if (!send) continue;
			const reply = await teamReplySource(ctx, send);
			if (reply === 'unreadable') isUnreadable = true;
			else if (reply) newestFirst.unshift(reply);
		}
	}
	const last = read[read.length - 1];
	return {
		sources: newestFirst.reverse(),
		isUnreadable,
		continueCursor: last ? encodeHistoryCursor(last._creationTime, last._creationTime) : '',
		isDone,
	};
}

/** The run that reads a source: sends go through the outbound run (failure reconciliation). */
function runOf(source: InterpretationSource) {
	return source.kind === 'outboundMail' || source.kind === 'teamReply'
		? internal.mail.interpret.outboundRun.interpretSent
		: internal.mail.interpret.run.interpretMessage;
}

export interface HistoryPageOutcome {
	scheduled: number;
	/** No page left (now or before). */
	isDone: boolean;
}

/**
 * Read the next page of the thread's history: snapshot and schedule what it
 * admits (the first run `startDelayMs` from now, the rest
 * {@link RUN_SPACING_MS} apart), move the cursor, and schedule the next page
 * while pages remain. A history already read through does nothing.
 */
export async function enqueueHistoryPage(
	ctx: MutationCtx,
	ref: ThreadRef,
	opts: { startDelayMs?: number } = {}
): Promise<HistoryPageOutcome> {
	const brief = await ensureBriefRow(ctx, ref);
	if (!brief) return { scheduled: 0, isDone: true };
	if (brief.historyState === 'done') return { scheduled: 0, isDone: true };
	const cursor = brief.historyCursor ?? null;
	const found =
		ref.kind === 'mail' ? await mailPage(ctx, ref.id, cursor) : await teamPage(ctx, ref.id, cursor);
	const startDelayMs = opts.startDelayMs ?? 0;
	let scheduled = 0;
	for (const source of found.sources) {
		if (!(await captureInterpretSource(ctx, { source, isLive: true }))) continue;
		await ctx.scheduler.runAfter(startDelayMs + scheduled * RUN_SPACING_MS, runOf(source), {
			source,
		});
		scheduled++;
	}
	const now = Date.now();
	await ctx.db.patch(brief._id, {
		historyCursor: found.isDone ? undefined : found.continueCursor,
		historyState: found.isDone ? 'done' : 'pending',
		historyUpdatedAt: now,
		...(found.isUnreadable ? { isHistoryIncomplete: true } : {}),
		updatedAt: now,
	});
	if (scheduled > 0) await markBriefPending(ctx, ref);
	if (!found.isDone) {
		await ctx.scheduler.runAfter(
			startDelayMs + scheduled * RUN_SPACING_MS + (scheduled > 0 ? HISTORY_PAGE_INTERVAL_MS : 0),
			internal.mail.interpret.backfill.continueHistory,
			{ threadRef: ref, cursor: found.continueCursor }
		);
	}
	return { scheduled, isDone: found.isDone };
}

/** Whether a pending history's chain is still moving (else a walk or open resumes it). */
export function isHistoryRunning(
	brief: Pick<Doc<'threadBriefs'>, 'historyState' | 'historyUpdatedAt'> | null,
	now: number
): boolean {
	return (
		brief?.historyState === 'pending' &&
		brief.historyUpdatedAt !== undefined &&
		now - brief.historyUpdatedAt < HISTORY_STALE_MS
	);
}
