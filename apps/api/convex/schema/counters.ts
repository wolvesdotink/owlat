import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Maintained counts (plan 3.1): numbers the UI shows that used to be computed
 * by scanning whole documents on every read (label and section unread badges,
 * the Workbench "new mail" figure, the campaign/template/automation facet
 * counts, the 30-day subscriber growth series).
 *
 * A SCOPE is one family of buckets (`mailLabelUnread:<mailboxId>`,
 * `campaignStatus`, ...). The writes that change the underlying rows move the
 * buckets in the same transaction (`lib/counters.ts`); `counterScopes` records
 * whether a scope has been backfilled, and while a backfill is walking the
 * source rows, how far it got. A reader treats a scope that is not ready as
 * absent and falls back to its old bounded scan.
 */

/** What a scope counts; each kind has its own source walk (`maintenance/counterBackfill.ts`). */
export const counterKindValidator = v.union(
	v.literal('mailLabelUnread'),
	v.literal('mailSectionUnread'),
	v.literal('mailFolderArrivals'),
	v.literal('campaignStatus'),
	v.literal('templateType'),
	v.literal('automationStatus'),
	v.literal('contactCreatedDay')
);

export const counterTables = {
	counterBuckets: defineTable({
		/** `<kind>` or `<kind>:<ownerId>` — see `counterScopeKey`. */
		scope: v.string(),
		/** The value counted: a label id, a section name, a status, a day key. */
		bucket: v.string(),
		count: v.number(),
		updatedAt: v.number(),
	}).index('by_scope_and_bucket', ['scope', 'bucket']),

	counterScopes: defineTable({
		scope: v.string(),
		kind: counterKindValidator,
		/** The mailbox or folder a per-owner scope belongs to. */
		ownerId: v.optional(v.string()),
		/** Buckets are exact and readers may use them. */
		isReady: v.boolean(),
		/** Backfill page cursor over the scope's source index; null before page 1. */
		cursor: v.union(v.string(), v.null()),
		/**
		 * Source position of the last row the backfill counted. A write to a row at
		 * or before it moves the buckets; a write past it is left to the walk.
		 */
		watermark: v.optional(v.object({ key: v.number(), creationTime: v.number() })),
		startedAt: v.number(),
		completedAt: v.optional(v.number()),
		updatedAt: v.number(),
	}).index('by_scope', ['scope']),
};
