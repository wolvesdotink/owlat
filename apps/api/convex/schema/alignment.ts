import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	alignmentCheckValidator,
	alignmentVerdictValidator,
} from '../delivery/deliverabilityValidators';

/**
 * Dual-transport alignment pre-flight state (P3-5), kept in its own schema
 * sibling: `schema/delivery.ts` sits at the repo's 500-LOC cap, and this table is
 * one self-contained feature with one reader (`delivery/alignmentPreflight.ts`).
 */
export const alignmentTables = {
	// Dual-transport alignment pre-flight results (P3-5). One row per sending
	// domain: the last live-DNS verdict on whether the own-MTA arm and the
	// reference-transport arm are indistinguishable to the receiver (same From
	// domain, one SPF record inside the 10-lookup limit, same DKIM d= with
	// distinct selectors, DMARC alignment on both). A cell may not be ramped
	// above s=0 while its domain's verdict is anything other than `aligned` or
	// `single_arm`. `single_arm` — no reference transport configured — is a
	// SUPPORTED CONFIGURATION, never an error state (D2).
	deliverabilityAlignmentStates: defineTable({
		organizationId: v.string(),
		domain: v.string(),
		verdict: alignmentVerdictValidator,
		checks: v.array(alignmentCheckValidator),
		// True when the reference transport cannot carry our custom return path:
		// measurement confidence is lowered, the ramp is NOT blocked (P2-3).
		isMeasurementDegraded: v.boolean(),
		measurementDegradedReason: v.optional(v.string()),
		checkedAt: v.number(),
		// Daily re-check, or ~1h when a lookup could not be resolved. Read per
		// domain by the sweep (which paginates `domains`, the table that decides
		// what must be checked at all), so no separate due-at index is declared.
		nextCheckDueAt: v.number(),
		updatedAt: v.number(),
	}).index('by_org_domain', ['organizationId', 'domain']),
};
