import { defineTable } from 'convex/server';
import { inboxSlaPolicyFields } from '../lib/validators/inboxSla';

/**
 * Team Inbox response targets (SLA).
 *
 * One policy row per workspace: the Team Inbox is the one shared inbox of a
 * deployment, so it carries one set of targets. Off by default: an absent row
 * reads as disabled. Written only by `inbox/sla/policy.ts`, which audits every
 * save. The per-thread clock lives on `conversationThreads`
 * (`schema/conversationThreads.ts`).
 *
 * Spread into `defineSchema()` from schema.ts via `...inboxSlaTables`.
 */
export const inboxSlaTables = {
	inboxSlaPolicies: defineTable(inboxSlaPolicyFields),
};
