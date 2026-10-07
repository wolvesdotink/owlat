/**
 * The Team Inbox thread as one stream (SPEC §7 "Team"): the customer's emails
 * as written, the team's replies (from what actually went out, with their
 * queued or failed status), the team's internal notes and the thread's
 * activity as system lines, in one order and paged together
 * (`mail/interpret/teamStreamMerge.ts`).
 *
 * Internal notes are part of this read, so it is for the thread page and
 * Answer mode only. Nothing that builds mail, an interpretation or an agent
 * prompt may call it (`__tests__/teamStream.test.ts` guards that, beside
 * `notesStayInternal.test.ts`).
 *
 * Access follows the rest of the shared inbox (ADR-0040): a soft-auth read
 * that answers null for anyone who is not a Team Inbox reader or when the
 * `inbox` feature is off.
 */

import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { publicQuery } from '../lib/authedFunctions';
import { isFeatureEnabled } from '../lib/featureFlags';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { loadProfileSummary, type ProfileSummary } from '../lib/userProfiles';
import { openMessageBody } from '../lib/messageBody';
import { openInboundMessageBody } from '../lib/messageBodyInbound';
import { interpretationSourceKey } from '../lib/validators/threadBrief';
import type { TeamThreadRef } from '../lib/validators/threadRef';
import { isSharedInboxReader } from './access';
import { updatePreviewText } from './updates';
import { readNoteReactions } from '../mail/interpret/noteReactions';
import {
	teamStreamPageValidator,
	type TeamStreamEntry,
	type TeamStreamPage,
} from '../mail/interpret/briefShape';
import {
	decodeStreamCursor,
	isOnPage,
	mergeStreamPage,
	readSourceBatch,
	streamPreview,
	teamReplyStatusOf,
	type SourceBatch,
	type StreamPosition,
} from '../mail/interpret/teamStreamMerge';
import {
	itemTextReader,
	readActivityBatch,
	readSeenPosition,
	STREAM_PAGE_SIZE,
	STREAM_SCAN_BUDGET,
	streamLocale,
} from '../mail/interpret/teamStreamRead';

type Entry = TeamStreamEntry;
type ReplyEntry = Extract<Entry, { kind: 'teamReply' }>;

/** A thread's inbound messages, as `inbox.queries.getThread` reads them. */
const MAX_THREAD_MESSAGES = 500;
const MAX_FOLLOW_UPS = 200;

/** A customer email and the replies that answered it. */
async function emailEntries(
	ctx: QueryCtx,
	message: Doc<'inboundMessages'>,
	contactName: string | undefined
): Promise<Entry[]> {
	const body = await openInboundMessageBody(message, null);
	const out: Entry[] = [
		{
			kind: 'customerEmail',
			at: message._creationTime,
			key: `email:${message._id}`,
			source: { kind: 'inbound', id: message._id },
			...(contactName ? { fromName: contactName } : {}),
			fromEmail: message.from,
			subject: message.subject,
			preview: updatePreviewText(body),
		},
	];
	const sends = await ctx.db
		.query('transactionalSends')
		.withIndex('by_inbound_message_status', (q) => q.eq('inboundMessageId', message._id))
		.take(10);
	const isAgent = message.approvalSource === 'auto';
	const approved = message.draftResponse ?? '';
	for (const send of sends) {
		if (send.kind !== 'agent_reply') continue;
		const source = { kind: 'teamReply' as const, id: send._id };
		const snapshot = await ctx.db
			.query('interpretSources')
			.withIndex('by_source_key', (q) => q.eq('sourceKey', interpretationSourceKey(source)))
			.first();
		// The text that went out; a Send from before snapshots shows the approved draft.
		const text = snapshot?.snapshot ? await openMessageBody(snapshot.snapshot.text) : approved;
		out.push(
			replyEntry({
				key: `reply:${send._id}`,
				at: send.sentAt ?? send.queuedAt ?? send._creationTime,
				source,
				isAgent,
				status: teamReplyStatusOf(send.status),
				body: text,
				inReplyToId: message._id,
				toName: contactName,
			})
		);
	}
	if (out.length === 1 && message.processingStatus === 'sent' && approved) {
		out.push(
			replyEntry({
				key: `reply:${message._id}`,
				at: message.processedAt ?? message._creationTime,
				isAgent,
				status: 'sent',
				body: approved,
				inReplyToId: message._id,
				toName: contactName,
			})
		);
	}
	return out;
}

function replyEntry(
	fields: Omit<ReplyEntry, 'kind' | 'preview' | 'toName'> & { toName: string | undefined }
): ReplyEntry {
	const { toName, ...rest } = fields;
	return {
		kind: 'teamReply',
		...rest,
		...(toName ? { toName } : {}),
		preview: streamPreview(fields.body),
	};
}

/** A follow-up the team wrote after the thread was answered. */
function followUpEntry(row: Doc<'inboxFollowUps'>, toName: string | undefined): ReplyEntry | null {
	if (row.status === 'cancelled') return null;
	return replyEntry({
		key: `followUp:${row._id}`,
		at: row.sentAt ?? row.createdAt,
		...(row.sendId ? { source: { kind: 'teamReply' as const, id: row.sendId } } : {}),
		authorUserId: row.createdBy,
		isAgent: false,
		status: row.status === 'sent' ? 'sent' : row.status === 'failed' ? 'failed' : 'queued',
		body: row.body,
		inReplyToId: row.inReplyToMessageId,
		toName,
		followUpId: row._id,
		...(row.status === 'scheduled' ? { sendAt: row.sendAt } : {}),
		...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
	});
}

/** Everything a fully read source holds before the cursor. */
function allBefore<E extends StreamPosition>(
	entries: readonly E[],
	before: StreamPosition | null
): SourceBatch<E> {
	return { entries: entries.filter((e) => isOnPage(e, before)), floor: null };
}

/** The thread's notes before the cursor, newest first. */
async function noteBatch(
	ctx: QueryCtx,
	ref: TeamThreadRef,
	before: StreamPosition | null,
	viewerId: string,
	itemText: ReturnType<typeof itemTextReader>
): Promise<SourceBatch<Entry>> {
	const authors = new Map<string, ProfileSummary>();
	const rows = ctx.db
		.query('threadNotes')
		.withIndex('by_thread_and_created', (q) =>
			q.eq('threadId', ref.id).lte('createdAt', before?.at ?? Number.MAX_SAFE_INTEGER)
		)
		.order('desc');
	return readSourceBatch(rows, {
		before,
		limit: STREAM_PAGE_SIZE,
		budget: STREAM_SCAN_BUDGET,
		positionOf: (note) => ({ at: note.createdAt, key: `note:${note._id}` }),
		toEntry: async (note): Promise<Entry> => {
			let author = authors.get(note.authorId);
			if (!author) {
				author = await loadProfileSummary(ctx, note.authorId);
				authors.set(note.authorId, author);
			}
			const isDeleted = note.deletedAt !== undefined;
			const linkText = isDeleted ? undefined : await itemText(note.threadItemId);
			return {
				kind: 'note',
				at: note.createdAt,
				key: `note:${note._id}`,
				noteSource: 'threadNote',
				noteId: note._id,
				authorId: note.authorId,
				...(author.name ? { authorName: author.name } : {}),
				...(author.email ? { authorEmail: author.email } : {}),
				...(author.image ? { authorImage: author.image } : {}),
				body: isDeleted ? '' : note.body,
				mentionedUserIds: isDeleted ? [] : note.mentionedUserIds,
				...(!isDeleted && note.threadItemId ? { threadItemId: note.threadItemId } : {}),
				...(linkText !== undefined ? { threadItemText: linkText } : {}),
				...(note.editedAt !== undefined ? { editedAt: note.editedAt } : {}),
				isDeleted,
				reactions: isDeleted
					? []
					: await readNoteReactions(ctx, { source: 'threadNote', id: note._id }, viewerId),
			};
		},
	});
}

/** The contact's display name, for "Ana Costa" instead of the bare address. */
async function contactNameOf(ctx: QueryCtx, thread: Doc<'conversationThreads'>) {
	const contact = thread.contactId ? await ctx.db.get(thread.contactId) : null;
	const name = `${contact?.firstName ?? ''} ${contact?.lastName ?? ''}`.trim();
	return name || undefined;
}

/**
 * One page of a Team Inbox thread's stream, newest page first (`cursor` from
 * the previous page walks back). Null for a caller who may not read the
 * Team Inbox, a disabled feature or a missing thread.
 */
// public: soft-auth — admin-only shared inbox; returns null for non-admins
export const page = publicQuery({
	args: {
		threadId: v.id('conversationThreads'),
		locale: v.string(),
		cursor: v.optional(v.union(v.string(), v.null())),
	},
	returns: v.union(teamStreamPageValidator, v.null()),
	handler: async (ctx, args): Promise<TeamStreamPage | null> => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!isSharedInboxReader(session) || !(await isFeatureEnabled(ctx, 'inbox'))) return null;
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return null;
		const ref: TeamThreadRef = { kind: 'team', id: thread._id };
		const before = decodeStreamCursor(args.cursor);
		const itemText = itemTextReader(ctx, ref, streamLocale(args.locale));
		const contactName = await contactNameOf(ctx, thread);

		const [messages, followUps] = await Promise.all([
			ctx.db
				.query('inboundMessages')
				.withIndex('by_thread', (q) => q.eq('threadId', thread._id))
				.take(MAX_THREAD_MESSAGES),
			ctx.db
				.query('inboxFollowUps')
				.withIndex('by_thread', (q) => q.eq('threadId', thread._id))
				.take(MAX_FOLLOW_UPS),
		]);
		const mail = (await Promise.all(messages.map((m) => emailEntries(ctx, m, contactName)))).flat();
		const replies = followUps.flatMap((row) => followUpEntry(row, contactName) ?? []);

		const [notes, activity] = await Promise.all([
			noteBatch(ctx, ref, before, session.userId, itemText),
			readActivityBatch(ctx, ref, before, itemText),
		]);
		const merged = mergeStreamPage<Entry>(
			[allBefore(mail, before), allBefore(replies, before), notes, activity],
			STREAM_PAGE_SIZE
		);
		const seenPosition = await readSeenPosition(ctx, ref, session.userId);
		return { ...merged, ...(seenPosition ? { seenPosition } : {}) };
	},
});
