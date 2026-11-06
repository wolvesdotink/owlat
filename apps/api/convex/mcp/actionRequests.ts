/**
 * The checks a write request passes before it may wait for approval: every
 * target lies in one of the client's mailboxes, and every address is valid.
 * Wire ids arrive as plain strings and are turned into row ids here, so a
 * malformed or foreign id is a refusal, not a throw.
 *
 * Not a Convex function module; `mcp/actions.ts` calls it.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { isValidEmail, normalizeEmail } from '../lib/inputGuards';
import type { McpAction } from '../lib/validators/mcp';

const UNKNOWN_MAILBOX = 'No mailbox with that id is available to this connection.';
const UNKNOWN_THREAD = 'No conversation with that id is available to this connection.';

/** A write as it arrives from the wire: ids are still plain strings. */
export const writeRequestValidator = v.union(
	v.object({
		tool: v.literal('create_draft'),
		mailboxId: v.string(),
		to: v.array(v.string()),
		cc: v.array(v.string()),
		subject: v.string(),
		body: v.string(),
		inReplyToMessageId: v.optional(v.string()),
	}),
	v.object({ tool: v.literal('send_draft'), draftId: v.string() }),
	v.object({ tool: v.literal('archive_thread'), threadId: v.string() }),
	v.object({ tool: v.literal('move_thread'), threadId: v.string(), folderId: v.string() }),
	v.object({
		tool: v.literal('label_thread'),
		threadId: v.string(),
		labelId: v.string(),
		add: v.boolean(),
	})
);

type Checked =
	| { ok: true; mailboxId: Id<'mailboxes'>; threadId?: Id<'mailThreads'>; action: McpAction }
	| { ok: false; status: 'denied' | 'invalid'; message: string };

function refuse(status: 'denied' | 'invalid', message: string): Checked {
	return { ok: false, status, message };
}

/** The thread with this wire id, when it lives in one of the client's mailboxes. */
async function reachableThread(
	ctx: QueryCtx,
	mailboxIds: ReadonlySet<Id<'mailboxes'>>,
	rawThreadId: string
): Promise<Doc<'mailThreads'> | null> {
	const threadId = ctx.db.normalizeId('mailThreads', rawThreadId);
	const thread = threadId ? await ctx.db.get(threadId) : null;
	return thread && mailboxIds.has(thread.mailboxId) ? thread : null;
}

function addresses(raw: string[]): string[] | null {
	const normalized = raw.map(normalizeEmail);
	return normalized.every(isValidEmail) ? [...new Set(normalized)] : null;
}

/**
 * Check a write against what the client reaches now and turn its wire ids
 * into row ids. A target outside the client's mailboxes reads like a missing
 * one, so the answer never confirms an id that exists elsewhere.
 */
export async function checkRequest(
	ctx: QueryCtx,
	mailboxIds: ReadonlySet<Id<'mailboxes'>>,
	request: typeof writeRequestValidator.type
): Promise<Checked> {
	switch (request.tool) {
		case 'create_draft': {
			const mailboxId = ctx.db.normalizeId('mailboxes', request.mailboxId);
			if (!mailboxId || !mailboxIds.has(mailboxId)) return refuse('denied', UNKNOWN_MAILBOX);
			const to = addresses(request.to);
			const cc = addresses(request.cc);
			if (!to || !cc) return refuse('invalid', 'to and cc must hold valid email addresses.');
			let inReplyToMessageId: Id<'mailMessages'> | undefined;
			let threadId: Id<'mailThreads'> | undefined;
			if (request.inReplyToMessageId !== undefined) {
				const messageId = ctx.db.normalizeId('mailMessages', request.inReplyToMessageId);
				const message = messageId ? await ctx.db.get(messageId) : null;
				if (!message || message.mailboxId !== mailboxId) {
					return refuse('denied', 'No message with that id is in this mailbox.');
				}
				inReplyToMessageId = message._id;
				threadId = message.threadId;
			}
			return {
				ok: true,
				mailboxId,
				...(threadId ? { threadId } : {}),
				action: {
					tool: 'create_draft',
					to,
					cc,
					subject: request.subject,
					body: request.body,
					...(inReplyToMessageId ? { inReplyToMessageId } : {}),
				},
			};
		}
		case 'send_draft': {
			const draftId = ctx.db.normalizeId('mailDrafts', request.draftId);
			const draft = draftId ? await ctx.db.get(draftId) : null;
			if (!draft || !mailboxIds.has(draft.mailboxId)) {
				return refuse('denied', 'No draft with that id is available to this connection.');
			}
			if (draft.state !== 'draft') return refuse('invalid', 'That draft is already being sent.');
			if (draft.toAddresses.length + draft.ccAddresses.length + draft.bccAddresses.length === 0) {
				return refuse('invalid', 'That draft has no recipients.');
			}
			return {
				ok: true,
				mailboxId: draft.mailboxId,
				...(draft.threadId ? { threadId: draft.threadId } : {}),
				action: { tool: 'send_draft', draftId: draft._id },
			};
		}
		case 'archive_thread': {
			const thread = await reachableThread(ctx, mailboxIds, request.threadId);
			if (!thread) return refuse('denied', UNKNOWN_THREAD);
			return {
				ok: true,
				mailboxId: thread.mailboxId,
				threadId: thread._id,
				action: { tool: 'archive_thread', threadId: thread._id },
			};
		}
		case 'move_thread': {
			const thread = await reachableThread(ctx, mailboxIds, request.threadId);
			if (!thread) return refuse('denied', UNKNOWN_THREAD);
			const folderId = ctx.db.normalizeId('mailFolders', request.folderId);
			const folder = folderId ? await ctx.db.get(folderId) : null;
			if (!folder || folder.mailboxId !== thread.mailboxId) {
				return refuse('denied', 'No folder with that id is in this conversation’s mailbox.');
			}
			return {
				ok: true,
				mailboxId: thread.mailboxId,
				threadId: thread._id,
				action: { tool: 'move_thread', threadId: thread._id, folderId: folder._id },
			};
		}
		case 'label_thread': {
			const thread = await reachableThread(ctx, mailboxIds, request.threadId);
			if (!thread) return refuse('denied', UNKNOWN_THREAD);
			const labelId = ctx.db.normalizeId('mailLabels', request.labelId);
			const label = labelId ? await ctx.db.get(labelId) : null;
			if (!label || label.mailboxId !== thread.mailboxId) {
				return refuse('denied', 'No label with that id is in this conversation’s mailbox.');
			}
			return {
				ok: true,
				mailboxId: thread.mailboxId,
				threadId: thread._id,
				action: {
					tool: 'label_thread',
					threadId: thread._id,
					labelId: label._id,
					add: request.add,
				},
			};
		}
	}
}
