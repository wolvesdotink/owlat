/**
 * Run one approved MCP action through the Postbox mutation the web app uses
 * for the same thing. Called only by `approve` in `mcp/actions.ts`, inside the
 * owner's session: each mutation below applies its own mailbox gate to that
 * session, so a team inbox member can do here exactly what they can do in the
 * reader, and no more.
 *
 * One transaction: a step that throws undoes the steps before it, so an
 * approved draft is never left half written.
 */

import { v } from 'convex/values';
import { api } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { replyBodyToHtml } from '@owlat/shared/html';
import { throwInvalidState, throwNotFound } from '../_utils/errors';
import { isMessageSnoozed } from '../lib/mailSnooze';

/** Messages one conversation action reaches; a longer conversation gets its newest. */
const THREAD_MESSAGES_MAX = 200;
/** Folders a conversation move leaves alone: what was sent and what is still a draft. */
const STAYS_PUT = new Set(['sent', 'drafts']);

export const run = internalMutation({
	args: { actionId: v.id('mcpPendingActions') },
	handler: async (ctx, args): Promise<{ draftId?: Id<'mailDrafts'> }> => {
		const row = await ctx.db.get(args.actionId);
		if (!row) throwNotFound('Action');
		const { action } = row;
		switch (action.tool) {
			case 'create_draft': {
				const created = await ctx.runMutation(api.mail.drafts.create, {
					mailboxId: row.mailboxId,
					...(action.inReplyToMessageId ? { inReplyToMessageId: action.inReplyToMessageId } : {}),
				});
				await ctx.runMutation(api.mail.drafts.update, {
					draftId: created.draftId,
					toAddresses: action.to,
					ccAddresses: action.cc,
					// A reply without a subject of its own keeps the "Re:" one.
					...(action.subject ? { subject: action.subject } : {}),
					bodyText: action.body,
					bodyHtml: replyBodyToHtml(action.body),
				});
				return { draftId: created.draftId };
			}
			case 'send_draft': {
				const draft = await ctx.db.get(action.draftId);
				if (!draft || draft.mailboxId !== row.mailboxId) throwNotFound('Draft');
				if (draft.state !== 'draft') throwInvalidState('That draft is already being sent');
				await ctx.runMutation(api.mail.drafts.send, { draftId: draft._id });
				return {};
			}
			case 'archive_thread': {
				await assertThreadInMailbox(ctx, action.threadId, row.mailboxId);
				// The inbox copies a person sees, as the reader's Archive takes them.
				const now = Date.now();
				const messageIds = await threadMessageIds(
					ctx,
					action.threadId,
					row.mailboxId,
					(message, role) => role === 'inbox' && !isMessageSnoozed(message, now)
				);
				if (messageIds.length > 0) {
					await ctx.runMutation(api.mail.messageActions.archive, { messageIds });
				}
				return {};
			}
			case 'move_thread': {
				await assertThreadInMailbox(ctx, action.threadId, row.mailboxId);
				const messageIds = await threadMessageIds(
					ctx,
					action.threadId,
					row.mailboxId,
					(message, role) => message.folderId !== action.folderId && !(role && STAYS_PUT.has(role))
				);
				if (messageIds.length > 0) {
					await ctx.runMutation(api.mail.messageActions.move, {
						messageIds,
						targetFolderId: action.folderId,
					});
				}
				return {};
			}
			case 'label_thread': {
				await assertThreadInMailbox(ctx, action.threadId, row.mailboxId);
				await ctx.runMutation(api.mail.labels.toggleOnThread, {
					threadId: action.threadId,
					labelId: action.labelId,
					add: action.add,
				});
				return {};
			}
		}
	},
});

/** The newest messages of a thread in one mailbox that `keep` accepts, by their folder's role. */
async function threadMessageIds(
	ctx: QueryCtx,
	threadId: Id<'mailThreads'>,
	mailboxId: Id<'mailboxes'>,
	keep: (message: Doc<'mailMessages'>, role: string | undefined) => boolean
): Promise<Id<'mailMessages'>[]> {
	const messages = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread_and_received', (q) => q.eq('threadId', threadId))
		.order('desc')
		.take(THREAD_MESSAGES_MAX);
	const roles = new Map<Id<'mailFolders'>, string | undefined>();
	const kept: Id<'mailMessages'>[] = [];
	for (const message of messages) {
		if (message.mailboxId !== mailboxId) continue;
		if (!roles.has(message.folderId)) {
			roles.set(message.folderId, (await ctx.db.get(message.folderId))?.role);
		}
		if (keep(message, roles.get(message.folderId))) kept.push(message._id);
	}
	return kept;
}

async function assertThreadInMailbox(
	ctx: QueryCtx,
	threadId: Id<'mailThreads'>,
	mailboxId: Id<'mailboxes'>
): Promise<void> {
	const thread = await ctx.db.get(threadId);
	if (!thread || thread.mailboxId !== mailboxId) throwNotFound('Conversation');
}
