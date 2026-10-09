/**
 * The Team Inbox stream's sources (`inbox/teamStream.ts`), each read newest
 * first from the page cursor along its own index, with nothing capped (the
 * paging rules are in `mail/interpret/teamStreamMerge.ts`):
 *
 *   - customer emails: `inboundMessages.by_thread` (`_creationTime` order);
 *   - the team's replies as they went out: the reply snapshots captured when
 *     each Send was queued, `interpretSources.by_conversation_thread`
 *     (`_creationTime` order), with the Send's status. A Send from before
 *     snapshots, or a reply sent before Sends existed, is shown with the email
 *     it answered (same row, so it pages with it);
 *   - follow-ups: `inboxFollowUps.by_thread` (`_creationTime` order);
 *   - internal notes: `threadNotes.by_thread_and_created`.
 *
 * Internal notes are read here, so these readers serve the stream only.
 * Isolate-safe helpers, no Convex functions; the caller has checked access.
 */

import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { loadProfileSummary, type ProfileSummary } from '../lib/userProfiles';
import { openMessageBody } from '../lib/messageBody';
import { openInboundMessageBody } from '../lib/messageBodyInbound';
import { interpretationSourceKey } from '../lib/validators/threadBrief';
import type { TeamThreadRef } from '../lib/validators/threadRef';
import { updatePreviewText } from './updates';
import { readNoteReactions } from '../mail/interpret/noteReactions';
import type { TeamStreamEntry } from '../mail/interpret/briefShape';
import {
	rangesBefore,
	readSourceBatch,
	streamPreview,
	teamReplyStatusOf,
	type SourceBatch,
	type StreamPosition,
} from '../mail/interpret/teamStreamMerge';
import {
	type itemTextReader,
	STREAM_PAGE_SIZE,
	STREAM_SCAN_BUDGET,
} from '../mail/interpret/teamStreamRead';

type Entry = TeamStreamEntry;
type ReplyEntry = Extract<Entry, { kind: 'teamReply' }>;

/** Who the stream names as the customer. */
export interface StreamContext {
	ctx: QueryCtx;
	ref: TeamThreadRef;
	before: StreamPosition | null;
	contactName: string | undefined;
}

const PAGE = { limit: STREAM_PAGE_SIZE, budget: STREAM_SCAN_BUDGET };

/** A table read by an index whose order is `_creationTime` (no time field of its own). */
function byCreation<R>(
	before: StreamPosition | null,
	query: (range?: { eq?: number; lt?: number }) => AsyncIterable<R>
) {
	return rangesBefore(before, {
		all: () => query(),
		tied: (at) => query({ eq: at }),
		older: (at) => query({ lt: at }),
	});
}

function creationPosition(row: { _id: string; _creationTime: number }, kind: string) {
	return { at: row._creationTime, tie: row._creationTime, key: `${kind}:${row._id}` };
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

/**
 * A customer email, and the reply it got when that reply has no snapshot (a
 * Send from before snapshots, or a reply from before Sends): shown right
 * after the email, from the approved text.
 */
async function emailEntries(s: StreamContext, message: Doc<'inboundMessages'>): Promise<Entry[]> {
	const { ctx, contactName } = s;
	const position = creationPosition(message, 'email');
	const body = await openInboundMessageBody(message, null);
	const out: Entry[] = [
		{
			kind: 'customerEmail',
			...position,
			source: { kind: 'inbound', id: message._id },
			...(contactName ? { fromName: contactName } : {}),
			fromEmail: message.from,
			subject: message.subject,
			preview: updatePreviewText(body),
		},
	];
	const approved = message.draftResponse ?? '';
	const legacy = (key: string, status: ReplyEntry['status'], source?: ReplyEntry['source']) =>
		replyEntry({
			...position,
			key: `${position.key}~${key}`,
			...(source ? { source } : {}),
			isAgent: message.approvalSource === 'auto',
			status,
			body: approved,
			inReplyToId: message._id,
			toName: contactName,
		});
	let sendCount = 0;
	for await (const send of ctx.db
		.query('transactionalSends')
		.withIndex('by_inbound_message_status', (q) => q.eq('inboundMessageId', message._id))) {
		if (send.kind !== 'agent_reply') continue;
		sendCount++;
		const source = { kind: 'teamReply' as const, id: send._id };
		const snapshot = await ctx.db
			.query('interpretSources')
			.withIndex('by_source_key', (q) => q.eq('sourceKey', interpretationSourceKey(source)))
			.first();
		if (!snapshot?.snapshot) {
			out.push(legacy(`reply:${send._id}`, teamReplyStatusOf(send.status), source));
		}
	}
	if (sendCount === 0 && message.processingStatus === 'sent' && approved) {
		out.push(legacy('reply', 'sent'));
	}
	return out;
}

export function readEmailBatch(s: StreamContext): Promise<SourceBatch<Entry>> {
	const { ctx, ref } = s;
	const rows = byCreation(s.before, (range) =>
		ctx.db
			.query('inboundMessages')
			.withIndex('by_thread', (q) => {
				const thread = q.eq('threadId', ref.id);
				if (range?.eq !== undefined) return thread.eq('_creationTime', range.eq);
				if (range?.lt !== undefined) return thread.lt('_creationTime', range.lt);
				return thread;
			})
			.order('desc')
	);
	return readSourceBatch(rows, {
		before: s.before,
		...PAGE,
		positionOf: (m) => creationPosition(m, 'email'),
		toEntries: (m) => emailEntries(s, m),
	});
}

/** The replies that went out, from their snapshots, with the Send's status. */
export function readReplyBatch(s: StreamContext): Promise<SourceBatch<Entry>> {
	const { ctx, ref, contactName } = s;
	const rows = byCreation(s.before, (range) =>
		ctx.db
			.query('interpretSources')
			.withIndex('by_conversation_thread', (q) => {
				const thread = q.eq('conversationThreadId', ref.id);
				if (range?.eq !== undefined) return thread.eq('_creationTime', range.eq);
				if (range?.lt !== undefined) return thread.lt('_creationTime', range.lt);
				return thread;
			})
			.order('desc')
	);
	return readSourceBatch(rows, {
		before: s.before,
		...PAGE,
		positionOf: (row) => creationPosition(row, 'reply'),
		toEntries: async (row): Promise<Entry[]> => {
			if (row.source.kind !== 'teamReply' || !row.snapshot) return [];
			const send = await ctx.db.get(row.source.id);
			if (!send) return [];
			const inbound = send.inboundMessageId ? await ctx.db.get(send.inboundMessageId) : null;
			return [
				replyEntry({
					...creationPosition(row, 'reply'),
					source: row.source,
					isAgent: inbound?.approvalSource === 'auto',
					status: teamReplyStatusOf(send.status),
					body: await openMessageBody(row.snapshot.text),
					...(send.inboundMessageId ? { inReplyToId: send.inboundMessageId } : {}),
					toName: contactName,
				}),
			];
		},
	});
}

/** Follow-ups the team wrote after the thread was answered (cancelled ones are gone). */
export function readFollowUpBatch(s: StreamContext): Promise<SourceBatch<Entry>> {
	const { ctx, ref, contactName } = s;
	const rows = byCreation(s.before, (range) =>
		ctx.db
			.query('inboxFollowUps')
			.withIndex('by_thread', (q) => {
				const thread = q.eq('threadId', ref.id);
				if (range?.eq !== undefined) return thread.eq('_creationTime', range.eq);
				if (range?.lt !== undefined) return thread.lt('_creationTime', range.lt);
				return thread;
			})
			.order('desc')
	);
	return readSourceBatch(rows, {
		before: s.before,
		...PAGE,
		positionOf: (row) => creationPosition(row, 'followUp'),
		toEntries: (row): Entry[] =>
			row.status === 'cancelled'
				? []
				: [
						replyEntry({
							...creationPosition(row, 'followUp'),
							...(row.sendId ? { source: { kind: 'teamReply' as const, id: row.sendId } } : {}),
							authorUserId: row.createdBy,
							isAgent: false,
							status:
								row.status === 'sent' ? 'sent' : row.status === 'failed' ? 'failed' : 'queued',
							body: row.body,
							inReplyToId: row.inReplyToMessageId,
							toName: contactName,
							followUpId: row._id,
							...(row.status === 'scheduled' ? { sendAt: row.sendAt } : {}),
							...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
						}),
					],
	});
}

/** The thread's internal notes, with authors, the `#` link and reactions. */
export function readNoteBatch(
	s: StreamContext,
	viewerId: string,
	itemText: ReturnType<typeof itemTextReader>
): Promise<SourceBatch<Entry>> {
	const { ctx, ref } = s;
	const authors = new Map<string, ProfileSummary>();
	const notes = ctx.db.query('threadNotes');
	const rows = rangesBefore(s.before, {
		all: () =>
			notes.withIndex('by_thread_and_created', (q) => q.eq('threadId', ref.id)).order('desc'),
		tied: (at, tie) =>
			notes
				.withIndex('by_thread_and_created', (q) =>
					q.eq('threadId', ref.id).eq('createdAt', at).lte('_creationTime', tie)
				)
				.order('desc'),
		older: (at) =>
			notes
				.withIndex('by_thread_and_created', (q) => q.eq('threadId', ref.id).lt('createdAt', at))
				.order('desc'),
	});
	const positionOf = (note: Doc<'threadNotes'>) => ({
		at: note.createdAt,
		tie: note._creationTime,
		key: `note:${note._id}`,
	});
	return readSourceBatch(rows, {
		before: s.before,
		...PAGE,
		positionOf,
		toEntries: async (note): Promise<Entry[]> => {
			let author = authors.get(note.authorId);
			if (!author) {
				author = await loadProfileSummary(ctx, note.authorId);
				authors.set(note.authorId, author);
			}
			const isDeleted = note.deletedAt !== undefined;
			const linkText = isDeleted ? undefined : await itemText(note.threadItemId);
			return [
				{
					kind: 'note',
					...positionOf(note),
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
				},
			];
		},
	});
}
