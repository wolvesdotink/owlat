/**
 * Contact erasure policy for everything that hangs off a conversation thread
 * the erasure deletes (and off the thread's notes, which go with it), spread
 * into `DESCENDANT_RELATIONS` (relations.ts) at the position the
 * `conversationThreads` block held. The coverage test seeds the descendants in
 * registry order, so the order below is part of the contract.
 * The thread's own brief tables are declared in `threadBriefRelations.ts`.
 */

import type { DescendantRelation } from './relations';

export const CONVERSATION_THREAD_DESCENDANTS: readonly DescendantRelation[] = [
	{
		parent: 'conversationThreads',
		table: 'unifiedMessages',
		field: 'threadId',
		action: 'delete',
		why: 'Every message in the thread goes, including organization replies that quote the person.',
	},
	{
		parent: 'conversationThreads',
		table: 'inboundMessages',
		field: 'threadId',
		action: 'retain',
		why: 'Governed by the message’s own contactId: the erased person’s mail is deleted through that relation, another sender’s mail in the same thread is theirs.',
	},
	{
		parent: 'conversationThreads',
		table: 'answerAskSessions',
		field: 'target.threadId',
		action: 'retain',
		why: 'Governed by the session’s own contactId (deleted above), which is the thread’s contact when one is linked; a session without a contact carries no contact data beyond the thread it names.',
	},
	{
		parent: 'conversationThreads',
		table: 'coalesceBatches',
		field: 'threadId',
		action: 'retain',
		why: 'Transient debounce row, consumed and deleted by its own scheduled job within the coalescing window.',
	},
	{
		parent: 'conversationThreads',
		table: 'threadPresence',
		field: 'threadId',
		action: 'retain',
		why: 'Ephemeral viewer heartbeat (user id and a timestamp), expired by the presence sweep.',
	},
	{
		parent: 'conversationThreads',
		table: 'threadReads',
		field: 'threadId',
		action: 'retain',
		why: 'A team member’s read marker: ids and a timestamp, no content.',
	},
	{
		parent: 'conversationThreads',
		table: 'inboxAssignmentNotices',
		field: 'threadId',
		action: 'retain',
		why: 'Known gap: the notice copies the thread subject, but the table has no index by thread to find it from here.',
	},
	{
		parent: 'conversationThreads',
		table: 'inboxFollowUps',
		field: 'threadId',
		action: 'delete',
		why: 'A follow-up is the team writing to the person on their thread; it goes with the thread like the replies in it. A pending one has its dispatch cancelled.',
	},
	{
		parent: 'conversationThreads',
		table: 'threadCatchUps',
		field: 'conversationThreadId',
		action: 'delete',
		why: 'Answer mode’s catch-up card retells the thread and lists what the person asked for; it goes with the thread it summarises.',
	},
	{
		parent: 'conversationThreads',
		table: 'threadNotes',
		field: 'threadId',
		action: 'delete',
		why: 'The team’s internal notes discuss the person on their thread; they go with the thread.',
	},
	{
		parent: 'conversationThreads',
		table: 'threadNoteMentions',
		field: 'threadId',
		action: 'retain',
		why: 'Governed by the row’s noteId (below): a mention goes with its note, which goes with the thread. The thread id is only the Mentions filter’s key.',
	},
	{
		parent: 'threadNotes',
		table: 'threadNoteMentions',
		field: 'noteId',
		action: 'delete',
		why: 'A mention row is meaningless without its note.',
	},
	{
		parent: 'threadNotes',
		table: 'noteReactions',
		field: 'threadNoteId',
		action: 'delete',
		why: 'An emoji reaction is meaningless without its note.',
	},
	{
		parent: 'threadNotes',
		table: 'inboxAssignmentNotices',
		field: 'noteId',
		action: 'retain',
		why: 'Known gap, as for the thread pointer above: the notice copies the thread subject, but the table has no index by note to find it from here.',
	},
	{
		parent: 'conversationThreads',
		table: 'knowledgeEntries',
		field: 'threadId',
		action: 'retain',
		why: 'Governed by the entry’s contact links (contactIds[] above).',
	},
	{
		parent: 'conversationThreads',
		table: 'semanticFiles',
		field: 'threadId',
		action: 'retain',
		why: 'Governed by the file’s contact links (contactIds[] above).',
	},
	{
		parent: 'conversationThreads',
		table: 'visualizations',
		field: 'threadId',
		action: 'retain',
		why: 'An organization dashboard artifact that optionally names the thread it was asked from.',
	},
	{
		parent: 'conversationThreads',
		table: 'chatRooms',
		field: 'linkedInboxThreadId',
		action: 'retain',
		why: 'An internal team chat room; the optional link to the inbox thread is not the person’s data.',
	},
];
