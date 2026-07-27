import { v } from 'convex/values';
import { SEED_PLACEMENTS } from '@owlat/shared/seedPlacement';

/** Convex validators for the shared, fixed deliverability taxonomy. */
export const destinationProviderValidator = v.union(
	v.literal('gmail'),
	v.literal('microsoft'),
	v.literal('yahoo'),
	v.literal('apple'),
	v.literal('other')
);

/**
 * Where a seed probe was found. DERIVED from `SEED_PLACEMENTS` rather than
 * restated: the pure core owns the taxonomy, and a placement added there
 * becomes storable here without a second edit that could be forgotten.
 */
export const seedPlacementValidator = v.union(
	...SEED_PLACEMENTS.map((placement) => v.literal(placement))
);

export const deliverabilitySignalProviderValidator = v.union(
	v.literal('all'),
	destinationProviderValidator
);

export const deliverabilitySignalSourceValidator = v.union(
	v.literal('ip_quarantined'),
	v.literal('dnsbl_listed'),
	// Advisory measurement sources (see ADVISORY_DELIVERABILITY_SIGNAL_SOURCES):
	// recorded and readable, never a fallback trigger on their own.
	v.literal('dnsbl_partial'),
	v.literal('dnsbl_unknown'),
	v.literal('breaker_open'),
	v.literal('persistent_defers')
);

export const deliverabilitySignalSeverityValidator = v.union(
	v.literal('warning'),
	v.literal('critical')
);

export const deliverabilitySignalValidator = v.object({
	provider: deliverabilitySignalProviderValidator,
	source: deliverabilitySignalSourceValidator,
	severity: deliverabilitySignalSeverityValidator,
	observedAt: v.number(),
});
