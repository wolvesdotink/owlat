import { v } from 'convex/values';

/** Convex validators for the shared, fixed deliverability taxonomy. */
export const destinationProviderValidator = v.union(
	v.literal('gmail'),
	v.literal('microsoft'),
	v.literal('yahoo'),
	v.literal('apple'),
	v.literal('other')
);

/**
 * The routing cell's STREAM axis (D6). One source of truth: the schema, the
 * probe ledger and every mutation argument share this validator.
 */
export const mailStreamValidator = v.union(
	v.literal('campaign'),
	v.literal('automation'),
	v.literal('transactional')
);

/** Where a seed probe was found. Mirrors `SEED_PLACEMENTS` in @owlat/shared. */
export const seedPlacementValidator = v.union(
	v.literal('inbox'),
	v.literal('category'),
	v.literal('spam'),
	v.literal('deleted'),
	v.literal('missing')
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
