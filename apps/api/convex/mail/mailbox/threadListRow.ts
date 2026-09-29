/**
 * The row `queries.listThreads` returns for one conversation (plan C8).
 *
 * The list used to ship whole `mailThreads` documents, so every row carried the
 * pre-generated reply draft (`needsReply.draftSlot`), the cached AI summary and
 * the participant list: kilobytes per row that no list renders, re-sent on
 * every change. The projection keeps what the conversation row, the category
 * view and the Inboxes page read, and reduces the reply-queue flag to the two
 * presence markers `deriveThreadStatus` (`@owlat/shared/threadStatus`) needs to
 * tell "draft ready" from "needs you".
 *
 * Not a Convex function; a pure mapper.
 */

import type { Doc } from '../../_generated/dataModel';

export type ThreadListRow = Pick<
	Doc<'mailThreads'>,
	| '_id'
	| 'latestMessageId'
	| 'latestFromAddress'
	| 'latestSubject'
	| 'latestSnippet'
	| 'lastMessageAt'
	| 'messageCount'
	| 'unreadCount'
	| 'hasFlagged'
	| 'hasAttachments'
> & {
	category?: { label: NonNullable<Doc<'mailThreads'>['category']>['label'] };
	/**
	 * Present while the thread is in the Reply Queue. `draftSlot` / the
	 * clarification's `draft` are `true` markers, not the drafts: the drafts are
	 * read per thread (`mail.needsReply.getDraftSlot`) when a card opens.
	 */
	needsReply?: { draftSlot?: true; clarification?: { draft?: true } };
	followUp?: { dueAt?: number };
};

export function toThreadListRow(thread: Doc<'mailThreads'>): ThreadListRow {
	const row: ThreadListRow = {
		_id: thread._id,
		latestFromAddress: thread.latestFromAddress,
		latestSubject: thread.latestSubject,
		latestSnippet: thread.latestSnippet,
		lastMessageAt: thread.lastMessageAt,
		messageCount: thread.messageCount,
		unreadCount: thread.unreadCount,
		hasFlagged: thread.hasFlagged,
		hasAttachments: thread.hasAttachments,
	};
	// Optional keys ride only when set, so an absent field never travels as a
	// present `undefined`.
	if (thread.latestMessageId) row.latestMessageId = thread.latestMessageId;
	if (thread.category) row.category = { label: thread.category.label };
	const flag = thread.needsReply;
	if (flag) {
		row.needsReply = {};
		if (flag.draftSlot) row.needsReply.draftSlot = true;
		if (flag.clarification) {
			row.needsReply.clarification = flag.clarification.draft ? { draft: true } : {};
		}
	}
	if (thread.followUp) {
		row.followUp = thread.followUp.dueAt !== undefined ? { dueAt: thread.followUp.dueAt } : {};
	}
	return row;
}
