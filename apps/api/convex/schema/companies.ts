import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { companyThreadKindValidator } from '../lib/validators/tasks';

/**
 * The company index: which conversations involve which company.
 *
 * A company is the organisational domain of the people in a conversation
 * (`@owlat/shared/companyKey`); nobody has to create it. The index is derived
 * data. `companies/indexer.ts` keeps it, walking threads by `lastMessageAt`
 * from a cursor per mailbox (and one for the Team Inbox), so the same sweep
 * fills it on a new install and keeps it current afterwards. Nothing else
 * writes these rows.
 */
export const companyTables = {
	// One row per (conversation, company). `addresses` are the participants at
	// that company, at most a handful, to show who was involved. A personal
	// mailbox row carries its owner, so another member can be told that a
	// colleague is in touch with the company without reading that mailbox.
	companyThreads: defineTable({
		companyKey: v.string(),
		kind: companyThreadKindValidator,
		mailboxId: v.optional(v.id('mailboxes')),
		mailThreadId: v.optional(v.id('mailThreads')),
		conversationThreadId: v.optional(v.id('conversationThreads')),
		ownerUserId: v.optional(v.string()), // BetterAuth user id, personal mailboxes only
		addresses: v.array(v.string()),
		lastMessageAt: v.number(),
	})
		.index('by_company_last', ['companyKey', 'lastMessageAt'])
		.index('by_mailbox_last', ['mailboxId', 'lastMessageAt'])
		.index('by_kind_last', ['kind', 'lastMessageAt'])
		.index('by_mail_thread', ['mailThreadId'])
		.index('by_conversation_thread', ['conversationThreadId']),

	// How far the indexer got. `mailboxId` absent is the Team Inbox cursor.
	companyIndexCursors: defineTable({
		mailboxId: v.optional(v.id('mailboxes')),
		lastMessageAt: v.number(),
		updatedAt: v.number(),
	}).index('by_mailbox', ['mailboxId']),
};
