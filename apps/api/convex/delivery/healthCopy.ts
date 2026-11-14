/**
 * The catalog keys for every reason the delivery-health roll-up can name.
 * `health.ts` returns one code per verdict (with the few values its sentence
 * interpolates), and the client words it in the reader's language: the roll-up
 * is printed on translated surfaces (the delivery hub header, the dashboard,
 * the marketing navigation, the audience panel), so an English sentence here
 * would reach a German reader as is.
 *
 * Pure data with no Convex imports: the web app imports this module
 * (`@owlat/api/deliveryHealthCopy`) to check that both locale catalogs carry
 * every key. One key per sentence, because the catalog has no select syntax.
 */

/** Every reason the roll-up can return, as a runtime list. */
export const DELIVERY_HEALTH_REASONS = [
	'healthy',
	'no_provider',
	'no_provider_transactional',
	'no_provider_campaign',
	'feedback_missing_campaign',
	'feedback_missing_transactional',
	'mta_signing_held',
	'mta_signing_held_unnamed',
	'mta_degraded',
	'mta_unreachable',
	'mta_stale',
	'mta_unchecked',
	'ips_all_held',
	'ips_some_held',
	'domain_failed',
	'no_domain',
	'no_verified_domain',
	'domain_pending',
	'sender_missing',
	'sender_unverified',
	'warmup_halted',
	'reputation_critical',
	'reputation_high',
	'reputation_medium',
] as const;

export type DeliveryHealthReason = (typeof DELIVERY_HEALTH_REASONS)[number];

/**
 * Reason → catalog key. Under `shared.` so the boot catalog carries them on
 * every route: the sidebar reads the roll-up on every page.
 */
export const DELIVERY_HEALTH_REASON_KEYS = {
	healthy: 'shared.deliveryHealth.reasons.healthy',
	no_provider: 'shared.deliveryHealth.reasons.noProvider',
	no_provider_transactional: 'shared.deliveryHealth.reasons.noProviderTransactional',
	no_provider_campaign: 'shared.deliveryHealth.reasons.noProviderCampaign',
	feedback_missing_campaign: 'shared.deliveryHealth.reasons.feedbackMissingCampaign',
	feedback_missing_transactional: 'shared.deliveryHealth.reasons.feedbackMissingTransactional',
	mta_signing_held: 'shared.deliveryHealth.reasons.mtaSigningHeld',
	mta_signing_held_unnamed: 'shared.deliveryHealth.reasons.mtaSigningHeldUnnamed',
	mta_degraded: 'shared.deliveryHealth.reasons.mtaDegraded',
	mta_unreachable: 'shared.deliveryHealth.reasons.mtaUnreachable',
	mta_stale: 'shared.deliveryHealth.reasons.mtaStale',
	mta_unchecked: 'shared.deliveryHealth.reasons.mtaUnchecked',
	ips_all_held: 'shared.deliveryHealth.reasons.ipsAllHeld',
	ips_some_held: 'shared.deliveryHealth.reasons.ipsSomeHeld',
	domain_failed: 'shared.deliveryHealth.reasons.domainFailed',
	no_domain: 'shared.deliveryHealth.reasons.noDomain',
	no_verified_domain: 'shared.deliveryHealth.reasons.noVerifiedDomain',
	domain_pending: 'shared.deliveryHealth.reasons.domainPending',
	sender_missing: 'shared.deliveryHealth.reasons.senderMissing',
	sender_unverified: 'shared.deliveryHealth.reasons.senderUnverified',
	warmup_halted: 'shared.deliveryHealth.reasons.warmupHalted',
	reputation_critical: 'shared.deliveryHealth.reasons.reputationCritical',
	reputation_high: 'shared.deliveryHealth.reasons.reputationHigh',
	reputation_medium: 'shared.deliveryHealth.reasons.reputationMedium',
} as const satisfies Record<DeliveryHealthReason, string>;

/** Named interpolation values for a reason's sentence. Strings only. */
export type DeliveryHealthReasonParams = Readonly<Record<string, string>>;

/** Whether a value read off the roll-up is a reason this build can word. */
export function isDeliveryHealthReason(value: unknown): value is DeliveryHealthReason {
	return (
		typeof value === 'string' && (DELIVERY_HEALTH_REASONS as readonly string[]).includes(value)
	);
}
