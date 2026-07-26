import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * The experiment record — one row per recipient per send.
 *
 * Its own schema sibling rather than another entry in `schema/delivery.ts`:
 * that file is already at the ~500 LOC split threshold CONVENTIONS.md sets,
 * and this table belongs to the transport-mix experiment rather than to the
 * delivery infrastructure the rest of that file describes.
 *
 * Spread into `defineSchema()` from schema.ts via `...sendAssignmentTables`.
 */
export const sendAssignmentTables = {
	// Written INSIDE the enqueue transaction BEFORE dispatch, recording which
	// transport the recipient was ASSIGNED to (and in which cell, under which
	// mix version). `sends.providerType` is written post-hoc from the dispatch
	// result and cannot answer "what did we decide, and for whom" — every
	// downstream comparison had to be reconstructed from it. This table is the
	// durable, tenant-scoped truth those comparisons read.
	//
	// `organizationId` is not in the plan's sketch and is deliberately added:
	// a cell-keyed table readable across tenants is a security defect, so the
	// cell/time index is org-leading and no query can cross tenants.
	//
	// Retention is 90 days, swept by the `cleanup send assignments` cron
	// through `by_assigned_at`.
	sendAssignments: defineTable({
		organizationId: v.string(),
		// `emailSends` (campaign) or `transactionalSends` id, as a string so one
		// table can reference either kind.
		sendId: v.string(),
		sendKind: v.union(v.literal('campaign'), v.literal('transactional')),
		// `${stream}:${destinationProvider}` — see @owlat/shared/deliverabilityCell.
		cell: v.string(),
		// Plugin/core transport key from the shipped send-transport catalog.
		transport: v.string(),
		arm: v.union(v.literal('own'), v.literal('reference')),
		// `is*` prefix per CONVENTIONS.md boolean naming (the plan sketch called
		// this `calibration`); true for the randomized calibration slice.
		isCalibration: v.boolean(),
		mixVersion: v.number(),
		engagementRank: v.optional(v.number()),
		assignedAt: v.number(),
	})
		.index('by_org_send', ['organizationId', 'sendId'])
		.index('by_org_cell_time', ['organizationId', 'cell', 'assignedAt'])
		.index('by_assigned_at', ['assignedAt']),
};
