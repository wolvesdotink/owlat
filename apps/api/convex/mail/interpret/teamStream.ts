/**
 * A shared-mailbox thread as one team stream (SPEC §7 "Team"): the emails
 * (customer mail as written, the team's sent mail with its delivery state),
 * the thread's internal discussion (`chat.mailDiscussion` messages) and the
 * activity system lines, in one order and paged together
 * (`teamStreamMerge.ts`). The Postbox reader renders the emails themselves;
 * the email entries tell it where the notes and system lines go.
 *
 * The discussion is internal, so this read is for the reader only. Nothing
 * that builds mail, an interpretation or an agent prompt may call it
 * (`inbox/__tests__/teamStream.test.ts`). With the `chat` feature off the
 * stream carries no notes: email, actions and activity stay.
 *
 * Reader rule: mailbox access (`loadReadableMailbox`), the same as the reader
 * and `chat.mailDiscussion.getForThread`. Soft: null for anyone else.
 */

import { v } from 'convex/values';
import type { Doc } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import { normalizeEmail } from '@owlat/shared';
import { publicQuery } from '../../lib/authedFunctions';
import { isFeatureEnabled } from '../../lib/featureFlags';
import { getBetterAuthSessionWithRole } from '../../lib/sessionOrganization';
import { loadProfileSummary, type ProfileSummary } from '../../lib/userProfiles';
import type { MailThreadRef } from '../../lib/validators/threadRef';
import { MAIL_THREAD_DISCUSSION } from '../../chat/_helpers';
import { loadReadableMailbox } from '../permissions';
import { mailboxOwnAddresses } from '../identities';
import { teamStreamPageValidator, type TeamStreamEntry, type TeamStreamPage } from './briefShape';
import { readNoteReactions } from './noteReactions';
import {
	decodeStreamCursor,
	mergeStreamPage,
	outboundStatusOf,
	rangesBefore,
	readSourceBatch,
	streamPreview,
	type SourceBatch,
	type StreamPosition,
} from './teamStreamMerge';
import {
	itemTextReader,
	readActivityBatch,
	readSeenPosition,
	STREAM_PAGE_SIZE,
	STREAM_SCAN_BUDGET,
	streamLocale,
} from './teamStreamRead';

type Entry = TeamStreamEntry;

/** The thread's emails before the cursor, newest first. */
async function mailBatch(
	ctx: QueryCtx,
	ref: MailThreadRef,
	before: StreamPosition | null,
	ownAddresses: ReadonlySet<string>
): Promise<SourceBatch<Entry>> {
	const messages = ctx.db.query('mailMessages');
	const rows = rangesBefore(before, {
		all: () =>
			messages.withIndex('by_thread_and_received', (q) => q.eq('threadId', ref.id)).order('desc'),
		tied: (at, tie) =>
			messages
				.withIndex('by_thread_and_received', (q) =>
					q.eq('threadId', ref.id).eq('receivedAt', at).lte('_creationTime', tie)
				)
				.order('desc'),
		older: (at) =>
			messages
				.withIndex('by_thread_and_received', (q) => q.eq('threadId', ref.id).lt('receivedAt', at))
				.order('desc'),
	});
	const positionOf = (m: Doc<'mailMessages'>) => ({
		at: m.receivedAt,
		tie: m._creationTime,
		key: `email:${m._id}`,
	});
	return readSourceBatch(rows, {
		before,
		limit: STREAM_PAGE_SIZE,
		budget: STREAM_SCAN_BUDGET,
		positionOf,
		toEntries: (m): Entry[] => [toMailEntry(m)],
	});

	function toMailEntry(m: Doc<'mailMessages'>): Entry {
		const isOurs =
			m.outbound !== undefined ||
			m.sentByUserId !== undefined ||
			ownAddresses.has(normalizeEmail(m.fromAddress));
		if (!isOurs) {
			return {
				kind: 'customerEmail',
				...positionOf(m),
				source: { kind: 'mail', id: m._id },
				...(m.fromName ? { fromName: m.fromName } : {}),
				fromEmail: m.fromAddress,
				subject: m.subject,
				preview: streamPreview(m.snippet),
			};
		}
		return {
			kind: 'teamReply',
			...positionOf(m),
			source: { kind: 'outboundMail', id: m._id },
			...(m.sentByUserId ? { authorUserId: m.sentByUserId } : {}),
			isAgent: false,
			status: m.outbound ? outboundStatusOf(m.outbound.recipients) : 'sent',
			...(m.toAddresses[0] ? { toName: m.toAddresses[0] } : {}),
			preview: streamPreview(m.snippet),
		};
	}
}

/** The thread's discussion messages before the cursor, newest first. */
async function discussionBatch(
	ctx: QueryCtx,
	ref: MailThreadRef,
	before: StreamPosition | null,
	viewerId: string,
	itemText: ReturnType<typeof itemTextReader>
): Promise<SourceBatch<Entry>> {
	const room = await ctx.db
		.query('chatRooms')
		.withIndex('by_linked_mail_thread', (q) => q.eq('linkedMailThreadId', ref.id))
		.first();
	if (room?.purpose !== MAIL_THREAD_DISCUSSION) return { entries: [], floor: null };
	const authors = new Map<string, ProfileSummary>();
	const messages = ctx.db.query('chatMessages');
	const rows = rangesBefore(before, {
		all: () =>
			messages.withIndex('by_room_and_created', (q) => q.eq('roomId', room._id)).order('desc'),
		tied: (at, tie) =>
			messages
				.withIndex('by_room_and_created', (q) =>
					q.eq('roomId', room._id).eq('createdAt', at).lte('_creationTime', tie)
				)
				.order('desc'),
		older: (at) =>
			messages
				.withIndex('by_room_and_created', (q) => q.eq('roomId', room._id).lt('createdAt', at))
				.order('desc'),
	});
	const positionOf = (m: Doc<'chatMessages'>) => ({
		at: m.createdAt,
		tie: m._creationTime,
		key: `note:${m._id}`,
	});
	return readSourceBatch(rows, {
		before,
		limit: STREAM_PAGE_SIZE,
		budget: STREAM_SCAN_BUDGET,
		positionOf,
		toEntries: async (m: Doc<'chatMessages'>): Promise<Entry[]> => {
			// A deleted discussion message leaves nothing behind (as in the panel).
			if (m.deletedAt !== undefined) return [];
			let author = authors.get(m.authorId);
			if (!author) {
				author = await loadProfileSummary(ctx, m.authorId);
				authors.set(m.authorId, author);
			}
			const linkText = await itemText(m.threadItemId);
			const entry: Entry = {
				kind: 'note',
				...positionOf(m),
				noteSource: 'chatMessage',
				noteId: m._id,
				authorId: m.authorId,
				...(author.name ? { authorName: author.name } : {}),
				...(author.email ? { authorEmail: author.email } : {}),
				...(author.image ? { authorImage: author.image } : {}),
				body: m.text,
				mentionedUserIds: m.mentions ?? [],
				...(m.threadItemId ? { threadItemId: m.threadItemId } : {}),
				...(linkText !== undefined ? { threadItemText: linkText } : {}),
				...(m.editedAt !== undefined ? { editedAt: m.editedAt } : {}),
				isDeleted: false,
				reactions: await readNoteReactions(ctx, { source: 'chatMessage', id: m._id }, viewerId),
			};
			return [entry];
		},
	});
}

/**
 * One page of a mail thread's team stream, newest page first (`cursor` from
 * the previous page walks back). Null for a caller without access to the
 * thread's mailbox or a missing thread.
 */
// public: soft-auth — returns null for anonymous; mailbox access is enforced in-handler
export const page = publicQuery({
	args: {
		threadId: v.id('mailThreads'),
		locale: v.string(),
		cursor: v.optional(v.union(v.string(), v.null())),
	},
	returns: v.union(teamStreamPageValidator, v.null()),
	handler: async (ctx, args): Promise<TeamStreamPage | null> => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session) return null;
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return null;
		const mailbox = await loadReadableMailbox(ctx, thread.mailboxId);
		if (!mailbox) return null;
		const ref: MailThreadRef = { kind: 'mail', id: thread._id };
		const before = decodeStreamCursor(args.cursor);
		const itemText = itemTextReader(ctx, ref, streamLocale(args.locale));
		const ownAddresses = new Set(
			[...(await mailboxOwnAddresses(ctx, mailbox))].map((a) => normalizeEmail(a))
		);
		const isChatOn = await isFeatureEnabled(ctx, 'chat');

		const [mail, notes, activity] = await Promise.all([
			mailBatch(ctx, ref, before, ownAddresses),
			isChatOn
				? discussionBatch(ctx, ref, before, session.userId, itemText)
				: Promise.resolve<SourceBatch<Entry>>({ entries: [], floor: null }),
			readActivityBatch(ctx, ref, before, itemText),
		]);
		const merged = mergeStreamPage<Entry>([mail, notes, activity], STREAM_PAGE_SIZE);
		const seenPosition = await readSeenPosition(ctx, ref, session.userId);
		return { ...merged, ...(seenPosition ? { seenPosition } : {}) };
	},
});
