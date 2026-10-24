import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Where the derived-field drift sampler (`maintenance/derivedFields/sampler.ts`)
 * left off, one row per registered field (`fieldId` is the registry id).
 *
 * Each tick samples the next few parent rows after `pageCursor` in creation
 * order and moves the cursor past them; when a tick reaches the end of the
 * table the cursor clears and the next tick starts from the oldest row again,
 * so every parent is visited in turn however large the table grows. The cursor
 * is a `.paginate()` position (creation time, then id), so rows that share a
 * creation time are not skipped. Operational state only: a cursor and two
 * counts, no row content.
 */
export const derivedFieldTables = {
	derivedFieldCursors: defineTable({
		fieldId: v.string(),
		// Pagination cursor over the table's `by_creation_time` index after the
		// last parent visited. Absent: start from the oldest.
		pageCursor: v.optional(v.string()),
		// Completed passes over the whole table.
		rotations: v.number(),
		// Parents scheduled for a check since the row was created.
		sampledCount: v.number(),
		updatedAt: v.number(),
	}).index('by_field_id', ['fieldId']),
};
