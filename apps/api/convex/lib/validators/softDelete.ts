import { v } from 'convex/values';

/**
 * The Recently deleted stamp on a soft-deletable marketing row (campaigns,
 * automations, email templates). Absent on a live row. `deletedAt` leads the
 * tables' `by_deleted_at*` indexes, so live reads pin it to `undefined` inside
 * the index range and the purge selects `[0, cutoff)` from the same index.
 * Helpers: `lib/softDelete.ts`.
 */
export const softDeleteFields = {
	/** When the row went to Recently deleted. */
	deletedAt: v.optional(v.number()),
	/** Who deleted it (BetterAuth user id). */
	deletedBy: v.optional(v.string()),
	/**
	 * Set when a purge stopped partway through removing what hangs off the row
	 * (the rest follows in the next transaction). From then on the row can no
	 * longer be restored: part of it is already gone.
	 */
	purgeStartedAt: v.optional(v.number()),
};
