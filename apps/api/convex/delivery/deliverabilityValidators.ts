import { v } from 'convex/values';

/** Convex validators for the shared, fixed deliverability taxonomy. */
export const destinationProviderValidator = v.union(
	v.literal('gmail'),
	v.literal('microsoft'),
	v.literal('yahoo'),
	v.literal('apple'),
	v.literal('other')
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
	v.literal('persistent_defers'),
	// Outcome-derived sources (see OUTCOME_DELIVERABILITY_SIGNAL_SOURCES): what
	// happened to mail that was ACCEPTED. They move the ramp controller's share;
	// they are never a shipped relay-fallback trigger on their own.
	v.literal('bounce_rate'),
	v.literal('complaint_rate'),
	v.literal('engagement_ratio'),
	v.literal('seed_placement')
);

/**
 * Sending stream — mirrors DELIVERABILITY_STREAM_KEYS in @owlat/shared, which
 * is itself an alias of the shipped GOVERNED_MESSAGE_TYPES. Parity with that
 * union is asserted in delivery/__tests__/routeStateMigration.test.ts.
 */
export const deliverabilityStreamValidator = v.union(
	v.literal('campaign'),
	v.literal('automation'),
	v.literal('transactional')
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

/**
 * Dual-transport alignment pre-flight (P3-5). Mirrors ALIGNMENT_CHECK_IDS /
 * AlignmentCheckStatus / AlignmentVerdict in
 * @owlat/shared/deliverabilityAlignment; parity is asserted in
 * delivery/__tests__/alignmentBlocking.test.ts.
 */
export const alignmentCheckIdValidator = v.union(
	v.literal('from_domain'),
	v.literal('spf'),
	v.literal('dkim'),
	v.literal('dmarc')
);

/** `unknown` is "DNS could not answer" — a hold, never a pass and never a fail. */
export const alignmentCheckStatusValidator = v.union(
	v.literal('pass'),
	v.literal('fail'),
	v.literal('unknown')
);

export const alignmentVerdictValidator = v.union(
	v.literal('aligned'),
	v.literal('single_arm'),
	v.literal('blocked'),
	v.literal('unknown')
);

export const alignmentCheckValidator = v.object({
	id: alignmentCheckIdValidator,
	status: alignmentCheckStatusValidator,
	detail: v.string(),
	remedy: v.string(),
});
