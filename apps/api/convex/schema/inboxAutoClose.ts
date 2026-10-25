import { defineTable } from 'convex/server';
import { inboxAutoClosePolicyFields } from '../lib/validators/inboxAutoClose';

/**
 * Team Inbox auto-close.
 *
 * One policy row per workspace: the Team Inbox is the one shared inbox of a
 * deployment (see `schema/inboxSla.ts`), so it carries one rule. Off by
 * default: an absent row reads as disabled. Written only by
 * `inbox/autoClose.ts`, which audits every save. The per-thread columns live
 * on `conversationThreads` (`schema/conversationThreads.ts`).
 *
 * Spread into `defineSchema()` from schema.ts via `...inboxAutoCloseTables`.
 */
export const inboxAutoCloseTables = {
	inboxAutoClosePolicies: defineTable(inboxAutoClosePolicyFields),
};
