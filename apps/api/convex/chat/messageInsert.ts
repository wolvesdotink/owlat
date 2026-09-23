/**
 * The one chat message insert path.
 *
 * `messages.sendMessage` (channels + DMs) and `mailDiscussion.post` (the
 * per-thread "Team discussion") both land here, so mentions, the room
 * aggregates and the @assistant hand-off behave the same wherever a message is
 * written. Callers do their own authorization first; this module only decides
 * WHO a mention may notify, because that depends on the kind of room.
 *
 * Not a Convex function module (no exports are registered), only imported by
 * sibling chat/*.ts.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { isFeatureEnabled } from '../lib/featureFlags';
import { rateLimiter } from '../rateLimiter';
import { canUserReadMailbox } from '../mail/permissions';
import {
	ASSISTANT_AUTHOR_ID,
	getMembership,
	isAssistantInvoked,
	isMailThreadDiscussion,
	parseMentionHandles,
} from './_helpers';
import { resolveMentionsToMemberIds } from './mentions';

/**
 * Keep only the mentioned people who can read the room. Without this an
 * @mention in a private channel, a DM or a mail-thread discussion would write
 * a chatMentions row for an outsider, leaking a preview of the message (and the
 * room name) through `mentions.listMyUnreadMentions`.
 *
 * Ordinary rooms: chat membership. Mail-thread discussions: read access to the
 * thread's mailbox, the same rule that lets someone open the discussion.
 */
async function filterMentionableMembers(
	ctx: MutationCtx,
	room: Doc<'chatRooms'>,
	candidateIds: string[]
): Promise<string[]> {
	if (candidateIds.length === 0) return [];
	if (isMailThreadDiscussion(room)) {
		const thread = room.linkedMailThreadId ? await ctx.db.get(room.linkedMailThreadId) : null;
		const mailbox = thread ? await ctx.db.get(thread.mailboxId) : null;
		if (!mailbox) return [];
		const allowed: string[] = [];
		for (const memberId of candidateIds) {
			if (await canUserReadMailbox(ctx, mailbox, memberId)) allowed.push(memberId);
		}
		return allowed;
	}
	const allowed: string[] = [];
	for (const memberId of candidateIds) {
		if (await getMembership(ctx, room._id, memberId)) allowed.push(memberId);
	}
	return allowed;
}

/**
 * Insert a human message into `room` and run its side effects:
 *  - a chatMentions row per resolved, room-readable @-mention (never the author)
 *  - bumps chatRooms.lastMessageAt / messageCount
 *  - moves the author's chatRoomMembers.lastReadAt, when they have a row
 *    (mail-thread discussions have none)
 *  - the @assistant reply, in ordinary rooms only
 *
 * `text` must already be validated (`requireMessageText`).
 */
export async function insertRoomMessage(
	ctx: MutationCtx,
	args: {
		room: Doc<'chatRooms'>;
		authorId: string;
		text: string;
		attachmentIds?: Array<Id<'mediaAssets'>>;
		authorMembership: Doc<'chatRoomMembers'> | null;
	}
): Promise<Id<'chatMessages'>> {
	const { room, authorId, text } = args;

	// Unknown handles are dropped silently: they stay in the text but write no
	// chatMentions row (and so notify nobody).
	const resolved = await resolveMentionsToMemberIds(ctx, parseMentionHandles(text));
	const mentions = await filterMentionableMembers(ctx, room, resolved);

	const now = Date.now();
	const messageId = await ctx.db.insert('chatMessages', {
		roomId: room._id,
		authorId,
		text,
		mentions: mentions.length > 0 ? mentions : undefined,
		attachmentIds:
			args.attachmentIds && args.attachmentIds.length > 0 ? args.attachmentIds : undefined,
		createdAt: now,
	});

	for (const mentionedMemberId of mentions) {
		if (mentionedMemberId === authorId) continue; // never notify self
		await ctx.db.insert('chatMentions', {
			messageId,
			roomId: room._id,
			mentionedMemberId,
			mentioningMemberId: authorId,
			createdAt: now,
		});
	}

	// AGGREGATED: this module is the only writer of these fields.
	await ctx.db.patch(room._id, {
		lastMessageAt: now,
		messageCount: (room.messageCount ?? 0) + 1,
		updatedAt: now,
	});

	// The author just read their own message.
	if (args.authorMembership) {
		await ctx.db.patch(args.authorMembership._id, { lastReadAt: now });
	}

	// @assistant — when the reserved handle is used and the AI assistant feature
	// is on, post a streaming AI reply visible to the whole room and let the
	// runner fill it in. Soft-checked (no throw): if the feature is off the
	// human message still posts normally, the @assistant just goes unanswered.
	//
	// Each turn is a capable-tier streaming LLM call plus up to 8 tool steps
	// (some of which fire more capable-tier calls), so a scripted @assistant
	// loop could drain the self-hoster's LLM budget. Rate-limit per user the
	// same way the personal-assistant path does — but soft-skip on limit: the
	// human message still posts, only the assistant reply is withheld.
	//
	// Not in mail-thread discussions: the runner's context and tools are built
	// for chat rooms, and a reply there would be the assistant speaking into a
	// mailbox it was never scoped to.
	if (
		!isMailThreadDiscussion(room) &&
		isAssistantInvoked(text) &&
		(await isFeatureEnabled(ctx, 'ai.assistant'))
	) {
		const rl = await rateLimiter.limit(ctx, 'assistantChatPerUser', { key: authorId });
		if (rl.ok) {
			const assistantMessageId = await ctx.db.insert('chatMessages', {
				roomId: room._id,
				authorId: ASSISTANT_AUTHOR_ID,
				text: '',
				aiStatus: 'streaming',
				aiPromptMessageId: messageId,
				createdAt: now + 1,
			});
			await ctx.db.patch(room._id, {
				lastMessageAt: now + 1,
				messageCount: (room.messageCount ?? 0) + 2,
				updatedAt: now + 1,
			});
			await ctx.scheduler.runAfter(0, internal.assistant.runner.runForChat, {
				roomId: room._id,
				assistantMessageId,
				promptMessageId: messageId,
			});
		}
	}

	return messageId;
}
