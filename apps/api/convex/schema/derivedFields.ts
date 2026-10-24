import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Where the derived-field drift sampler (`maintenance/derivedFields/sampler.ts`)
 * left off, one row per registered field (`fieldId` is the registry id).
 *
 * Each tick samples the next few parent rows after `afterCreationTime` in
 * creation order and moves the mark past them; when a tick reaches the end of
 * the table the mark clears and the next tick starts from the oldest row again,
 * so every parent is visited in turn however large the table grows.
 * Operational state only: a timestamp and two counts, no row content.
 */
export const derivedFieldTables = {
	derivedFieldCursors: defineTable({
		fieldId: v.string(),
		// Creation time of the last parent visited. Absent: start from the oldest.
		afterCreationTime: v.optional(v.number()),
		// Completed passes over the whole table.
		rotations: v.number(),
		// Parents scheduled for a check since the row was created.
		sampledCount: v.number(),
		updatedAt: v.number(),
	}).index('by_field_id', ['fieldId']),
};
