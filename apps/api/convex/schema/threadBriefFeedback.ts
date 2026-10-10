import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { threadRefFields } from '../lib/validators/threadRef';
import {
	itemCorrectionKindValidator,
	itemFacetValidator,
	itemIntentValidator,
	itemResponsibilityValidator,
	itemVerifyValidator,
	noteSourceValidator,
} from '../lib/validators/threadBrief';

/**
 * What people say back to the thread brief, split out of schema/threadBrief.ts
 * (file-size cap): the correction log the interpretation eval reads, and emoji
 * reactions on internal notes. Both are thread brief tables (listed in
 * `THREAD_BRIEF_TABLES`), spread into `threadBriefTables`.
 */
export const threadBriefFeedbackTables = {
	// A person's correction of the model about an item ("Not a request"), kept
	// for the interpretation eval: which kind of item the model got wrong, and
	// under which extractor. Structure only, never the item's text: the text
	// stays on the item (sealed) and goes with it.
	threadItemCorrections: defineTable({
		...threadRefFields,
		itemId: v.id('threadItems'),
		// The item revision the correction was made against.
		itemRevision: v.number(),
		kind: itemCorrectionKindValidator,
		// BetterAuth user id of who corrected it.
		userId: v.string(),
		// The item as the model had it.
		intent: itemIntentValidator,
		facets: v.array(itemFacetValidator),
		responsibility: itemResponsibilityValidator,
		verify: itemVerifyValidator,
		// The extractions its evidence came from (interpretationSourceKey + revision).
		evidenceSources: v.array(v.object({ sourceKey: v.string(), contentRevision: v.string() })),
		createdAt: v.number(),
	})
		.index('by_mail_thread', ['mailThreadId'])
		.index('by_conversation_thread', ['conversationThreadId'])
		.index('by_item', ['itemId'])
		.index('by_user', ['userId']),

	// Emoji reactions on internal notes: Team Inbox `threadNotes` and Postbox
	// thread discussion `chatMessages`. One row per (note, person, emoji);
	// toggled through `mail/interpret/noteReactions.ts`, bounded per note.
	noteReactions: defineTable({
		...threadRefFields,
		noteSource: noteSourceValidator,
		// Set when noteSource === 'threadNote'.
		threadNoteId: v.optional(v.id('threadNotes')),
		// Set when noteSource === 'chatMessage'.
		chatMessageId: v.optional(v.id('chatMessages')),
		// BetterAuth user id of who reacted.
		userId: v.string(),
		emoji: v.string(),
		createdAt: v.number(),
	})
		.index('by_thread_note', ['threadNoteId', 'userId', 'emoji'])
		.index('by_chat_message', ['chatMessageId', 'userId', 'emoji'])
		.index('by_mail_thread', ['mailThreadId'])
		.index('by_conversation_thread', ['conversationThreadId'])
		.index('by_user', ['userId']), // member erasure
};
