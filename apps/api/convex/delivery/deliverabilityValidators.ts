import { v } from "convex/values";

/** Convex validators for the shared, fixed deliverability taxonomy. */
export const destinationProviderValidator = v.union(
	v.literal("gmail"),
	v.literal("microsoft"),
	v.literal("yahoo"),
	v.literal("apple"),
	v.literal("other"),
);

export const deliverabilitySignalProviderValidator = v.union(
	v.literal("all"),
	destinationProviderValidator,
);

export const deliverabilitySignalSourceValidator = v.union(
	v.literal("ip_quarantined"),
	v.literal("dnsbl_listed"),
	v.literal("breaker_open"),
	v.literal("persistent_defers"),
);

export const deliverabilitySignalSeverityValidator = v.union(
	v.literal("warning"),
	v.literal("critical"),
);

export const deliverabilitySignalValidator = v.object({
	provider: deliverabilitySignalProviderValidator,
	source: deliverabilitySignalSourceValidator,
	severity: deliverabilitySignalSeverityValidator,
	observedAt: v.number(),
});
