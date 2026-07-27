import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	deliverabilitySignalProviderValidator,
	deliverabilitySignalSeverityValidator,
	deliverabilitySignalSourceValidator,
	deliverabilityStreamValidator,
	destinationProviderValidator,
} from '../delivery/deliverabilityValidators';

/**
 * Deliverability ROUTING tables — the ramp cell's durable state, the MX-learned
 * destination-provider classifier, and the ramp controller's audit trail.
 *
 * Split out of `schema/delivery.ts` (which sits exactly at the 500-LOC ratchet)
 * so the ramp's own tables have somewhere to grow. Pure move for the two
 * existing tables: same fields, same indexes, same names.
 *
 * Spread into `deliveryTables` from schema/delivery.ts.
 */
export const deliverabilityRoutingTables = {
	// MTA snapshot. One row per tenant + destination provider (plus `all`).
	deliverabilityRouteStates: defineTable({
		organizationId: v.string(),
		destinationProvider: deliverabilitySignalProviderValidator,
		// Ramp cell = (stream, destinationProvider). An ABSENT stream is a legacy,
		// stream-less row serving every stream — what the MTA snapshot writes.
		stream: v.optional(deliverabilityStreamValidator),
		// Kept as a derived view of `ownShare`: every reader resolves
		// `ownShare ?? (isFallbackActive ? 0 : 1)` through `resolveOwnShare` in
		// @owlat/shared/deliverabilityRouting.
		isFallbackActive: v.boolean(),
		// Share in [0,1] of the cell carried by the own MTA, absent on every
		// pre-migration row; the ramp phase ceiling (0.25/0.5/0.8/1); the
		// consecutive all-gates-green window count; and the mix generation that
		// salts per-recipient assignment. Written by the ramp controller only.
		ownShare: v.optional(v.number()),
		phaseCeiling: v.optional(v.number()),
		cleanStreak: v.optional(v.number()),
		mixVersion: v.optional(v.number()),
		signals: v.array(
			v.object({
				source: deliverabilitySignalSourceValidator,
				severity: deliverabilitySignalSeverityValidator,
				observedAt: v.number(),
			})
		),
		// Also the AIMD freeze clock / clean-streak clock: no parallel fields.
		fallbackActiveSince: v.optional(v.number()),
		healthySince: v.optional(v.number()),
		snapshotGeneratedAt: v.number(),
		expiresAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_org_provider', ['organizationId', 'destinationProvider'])
		.index('by_org_provider_stream', ['organizationId', 'destinationProvider', 'stream'])
		.index('by_expires_at', ['expiresAt']),

	// Recipient-domain provider classifications learned from successful MTA
	// deliveries. This lets pre-send routing reuse the MTA's authoritative MX
	// resolution for custom Workspace / Microsoft 365 domains.
	destinationProviderDomains: defineTable({
		organizationId: v.string(),
		domain: v.string(),
		destinationProvider: destinationProviderValidator,
		observedAt: v.number(),
		expiresAt: v.number(),
	})
		.index('by_org_domain', ['organizationId', 'domain'])
		.index('by_expires_at', ['expiresAt']),

};
