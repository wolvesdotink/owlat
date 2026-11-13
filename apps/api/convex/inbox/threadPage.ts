/**
 * A Team Inbox conversation read a page at a time, for the thread page, Answer
 * mode and the Today peek.
 *
 * `queries.getThread` hands back every message of the thread with its body
 * opened, so a long conversation costs its whole history on every open and on
 * every change to any of its messages. Here the newest messages come a page
 * at a time along `by_thread` (a `paginate` cursor walks back), and a body is
 * opened only for a page that asks for bodies or for the one message
 * `getMessage` names, the message a reader expands.
 *
 * What the composer needs regardless of where a message sits in the history
 * comes on the first page from the status index (`by_thread_and_processing_status`),
 * not from the history: the takeover facts (`received` and `security_check`
 * messages, the same facts `manualReply.takeOverReply` checks) and the
 * messages waiting on a person (`draft_ready`, `awaiting_clarification`).
 *
 * `getThread` keeps its shape for clients that still call it.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { publicQuery } from '../lib/authedFunctions';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { redactContactCapabilityFields } from '../contacts/listing';
import { openConversationThreadPreview } from '../lib/messageBody';
import { inboundMessageEnvelope, openInboundMessageRow } from '../lib/messageBodyInbound';
import { isSharedInboxReader } from './access';
import { takeOverViewFor } from './manualReply';

/** Messages per page unless the caller asks for fewer. */
export const THREAD_PAGE_SIZE = 20;
const MAX_THREAD_PAGE_SIZE = 50;
/**
 * A page also stops at this many bytes read: an inline body can be up to
 * 256 KiB (`bodyStorage.INBOUND_INLINE_BODY_BUDGET_BYTES`), so a count alone
 * could reach the 16 MiB a query may read. The cursor carries on from there.
 */
const THREAD_PAGE_BYTES = 4 * 1024 * 1024;
/**
 * Messages per status the first page reads from the status index. A thread
 * holds a handful of messages in these states at once; the cap keeps a
 * pathological thread from turning this into the history read it replaces.
 */
const STATUS_ROWS = 25;

const WAITING_STATUSES = ['draft_ready', 'awaiting_clarification'] as const;
const TAKEOVER_STATUSES = ['received', 'security_check'] as const;

type InboundStatus = Doc<'inboundMessages'>['processingStatus'];

function rowsInStatus(ctx: QueryCtx, threadId: Id<'conversationThreads'>, status: InboundStatus) {
	return ctx.db
		.query('inboundMessages')
		.withIndex('by_thread_and_processing_status', (q) =>
			q.eq('threadId', threadId).eq('processingStatus', status)
		)
		.take(STATUS_ROWS);
}

async function rowsInStatuses(
	ctx: QueryCtx,
	threadId: Id<'conversationThreads'>,
	statuses: readonly InboundStatus[]
) {
	const batches = await Promise.all(statuses.map((status) => rowsInStatus(ctx, threadId, status)));
	return batches.flat();
}

/** The thread, its contact and what the composer needs, for the first page. */
async function readHead(ctx: QueryCtx, thread: Doc<'conversationThreads'>, withBodies: boolean) {
	const [waiting, pending, linkedContact] = await Promise.all([
		rowsInStatuses(ctx, thread._id, WAITING_STATUSES),
		rowsInStatuses(ctx, thread._id, TAKEOVER_STATUSES),
		thread.contactId ? ctx.db.get(thread.contactId) : null,
	]);
	return {
		thread: await openConversationThreadPreview(thread),
		// Redacted like every other contact read: the thread view has no use
		// for the pending DOI token.
		contact: linkedContact ? redactContactCapabilityFields(linkedContact) : null,
		takeOver: await takeOverViewFor(ctx, pending),
		waiting: withBodies
			? await Promise.all(waiting.map((row) => openInboundMessageRow(row)))
			: waiting.map((row) => inboundMessageEnvelope(row)),
	};
}

/**
 * One page of a thread's messages, newest page first and oldest message first
 * within it. `cursor` from a page walks back to the one before it; the first
 * page (no cursor) also carries `head`. With `withBodies` the page's bodies
 * are opened, as `getThread` opens them; without, every message is an
 * envelope (`isBodyDeferred`) and `getMessage` opens one when it is expanded.
 * Null for a caller who may not read the Team Inbox or a missing thread.
 */
// public: soft-auth — admin-only shared inbox; returns null for non-admins
export const getThreadPage = publicQuery({
	args: {
		threadId: v.id('conversationThreads'),
		cursor: v.optional(v.union(v.string(), v.null())),
		limit: v.optional(v.number()),
		withBodies: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!isSharedInboxReader(session)) return null;
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return null;

		const withBodies = args.withBodies === true;
		const numItems = Math.max(
			1,
			Math.min(Math.floor(args.limit ?? THREAD_PAGE_SIZE), MAX_THREAD_PAGE_SIZE)
		);
		const page = await ctx.db
			.query('inboundMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', args.threadId))
			.order('desc')
			.paginate({
				numItems,
				cursor: args.cursor ?? null,
				maximumBytesRead: THREAD_PAGE_BYTES,
			});
		const rows = [...page.page].reverse();
		const messages = withBodies
			? await Promise.all(rows.map((row) => openInboundMessageRow(row)))
			: rows.map((row) => inboundMessageEnvelope(row));

		return {
			head: args.cursor ? null : await readHead(ctx, thread, withBodies),
			messages,
			cursor: page.continueCursor,
			isDone: page.isDone,
		};
	},
});

/**
 * One Team Inbox message with its body opened, as an element of
 * `getThread`'s `messages`: what a reader expands, and what the Today peek
 * shows. Null for a caller who may not read the Team Inbox or a missing row.
 */
// public: soft-auth — admin-only shared inbox; returns null for non-admins
export const getMessage = publicQuery({
	args: { messageId: v.id('inboundMessages') },
	handler: async (ctx, args) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!isSharedInboxReader(session)) return null;
		const row = await ctx.db.get(args.messageId);
		return row ? await openInboundMessageRow(row) : null;
	},
});
