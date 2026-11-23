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
	'sending_suspended',
	'sending_banned',
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
	sending_suspended: 'shared.deliveryHealth.reasons.sendingSuspended',
	sending_banned: 'shared.deliveryHealth.reasons.sendingBanned',
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

/** Who can make a reason's fix on its page. */
export type DeliveryHealthFixAudience = 'workspace_admin' | 'platform_admin' | 'contact_manager';

/** One reason, explained: what it means and what to do, plus the page to do it on. */
export interface DeliveryHealthExplanation {
	readonly sentence: string;
	readonly fix: { readonly route: string; readonly who: DeliveryHealthFixAudience } | null;
}

const TRANSPORT = { route: '/dashboard/admin/delivery/transport', who: 'workspace_admin' } as const;
const DOMAINS = { route: '/dashboard/admin/delivery/domains', who: 'workspace_admin' } as const;
const DELIVERABILITY = {
	route: '/dashboard/admin/delivery/deliverability',
	who: 'workspace_admin',
} as const;
const OPERATOR_CONSOLE = { route: '/dashboard/admin/operator', who: 'platform_admin' } as const;
const TRANSACTIONAL_SENDER = {
	route: '/dashboard/send/transactional?sender=edit',
	who: 'workspace_admin',
} as const;
const DELIVERY_HUB = { route: '/dashboard/admin/delivery', who: 'workspace_admin' } as const;
const SUPPRESSIONS = { route: '/dashboard/audience/suppressions', who: 'contact_manager' } as const;

/**
 * Each reason in English, for the built-in assistant, which reads the roll-up
 * as data and answers in the asker's own language. The web app never prints
 * these: it words the reason through the catalog key above. `satisfies` makes
 * a new reason fail to compile until it is explained here.
 *
 * The routes are the pages the web app's own fix links open. Most are admin
 * pages, so `who` tells the assistant whom a member has to ask.
 */
export const DELIVERY_HEALTH_EXPLANATIONS = {
	healthy: { sentence: 'Sending is healthy and no check blocks or warns right now.', fix: null },
	sending_suspended: {
		sentence:
			'Sending is suspended on this instance, so new sends are refused and campaigns hold until a platform admin of this instance reviews the recorded reason and lifts the suspension in the operator console, while transactional mail already queued is still delivered and a campaign held past its delivery deadline stops without mailing the rest.',
		fix: OPERATOR_CONSOLE,
	},
	sending_banned: {
		sentence:
			'Sending is permanently disabled on this instance, so new sends are refused and campaigns hold until a platform admin of this instance lifts the ban in the operator console, while transactional mail already queued is still delivered and a campaign held past its delivery deadline stops without mailing the rest.',
		fix: OPERATOR_CONSOLE,
	},
	no_provider: {
		sentence:
			'No delivery provider is configured, so no mail can be sent until an admin sets one up on the delivery transport page.',
		fix: TRANSPORT,
	},
	no_provider_transactional: {
		sentence:
			'Transactional mail has no delivery provider on its route, so transactional sends are refused until an admin adds one on the delivery transport page.',
		fix: TRANSPORT,
	},
	no_provider_campaign: {
		sentence:
			'Campaigns have no delivery provider on their route, so campaigns are refused until an admin adds one on the delivery transport page.',
		fix: TRANSPORT,
	},
	feedback_missing_campaign: {
		sentence:
			"Bounce and complaint reports from the campaign provider cannot reach Owlat because its feedback settings are missing from the deployment's environment, so campaigns are refused until they are set, and the readiness panel on the delivery hub names the missing settings.",
		fix: DELIVERY_HUB,
	},
	feedback_missing_transactional: {
		sentence:
			"Bounce and complaint reports from the transactional provider cannot reach Owlat because its feedback settings are missing from the deployment's environment, so bad addresses are not suppressed until they are set, and the readiness panel on the delivery hub names the missing settings.",
		fix: DELIVERY_HUB,
	},
	mta_signing_held: {
		sentence:
			'Mail from {domains} is held because the mail server has no usable DKIM key to sign it, and an admin fixes the DKIM key and record on the sending domains page.',
		fix: DOMAINS,
	},
	mta_signing_held_unnamed: {
		sentence:
			'Mail from a sending domain is held because the mail server has no usable DKIM key to sign it, and an admin fixes the DKIM key and record on the sending domains page.',
		fix: DOMAINS,
	},
	mta_degraded: {
		sentence:
			'The built-in mail server reports a problem with its own services, so mail may be delayed until an admin checks it on the delivery transport page.',
		fix: TRANSPORT,
	},
	mta_unreachable: {
		sentence:
			'Owlat cannot reach the built-in mail server, so mail may not be going out until an admin checks the mail server on the delivery transport page.',
		fix: TRANSPORT,
	},
	mta_stale: {
		sentence:
			'The built-in mail server has not reported its health recently, so its state is unknown until an admin checks it on the delivery transport page.',
		fix: TRANSPORT,
	},
	mta_unchecked: {
		sentence:
			'The built-in mail server has not reported its health yet, and an admin can check it on the delivery transport page.',
		fix: TRANSPORT,
	},
	ips_all_held: {
		sentence:
			"Every sending IP in one of the built-in mail server's pools is held back, for example because it is on a blocklist, so the mail that pool carries stops until an admin reviews the addresses on the deliverability page.",
		fix: DELIVERABILITY,
	},
	ips_some_held: {
		sentence:
			'Some sending IPs are held back and the others carry the mail at lower volume, and an admin can review them on the deliverability page.',
		fix: DELIVERABILITY,
	},
	domain_failed: {
		sentence:
			'A sending domain failed setup or DNS verification, so its mail cannot be authenticated until an admin opens it on the sending domains page, fixes the error shown there and verifies it again.',
		fix: DOMAINS,
	},
	no_domain: {
		sentence:
			'No sending domain is set up, so nothing can be sent until an admin adds and verifies one on the sending domains page.',
		fix: DOMAINS,
	},
	no_verified_domain: {
		sentence:
			"No sending domain is verified yet, so nothing can be sent until an admin publishes a domain's DNS records and verifies it on the sending domains page.",
		fix: DOMAINS,
	},
	domain_pending: {
		sentence:
			'A sending domain is still waiting for DNS verification, and an admin can check its records on the sending domains page.',
		fix: DOMAINS,
	},
	sender_missing: {
		sentence:
			'No default sender address is set for transactional mail, so transactional templates without a sender of their own are refused until an admin sets one on the transactional page.',
		fix: TRANSACTIONAL_SENDER,
	},
	sender_unverified: {
		sentence:
			"The default transactional sender's domain is not verified, so transactional templates without a verified sender of their own are refused until an admin verifies that domain or picks a default sender on a verified one.",
		fix: TRANSACTIONAL_SENDER,
	},
	warmup_halted: {
		sentence:
			'IP warm-up is halted, so daily campaign volume stops growing until an admin reviews it on the deliverability page.',
		fix: DELIVERABILITY,
	},
	reputation_critical: {
		sentence:
			'The bounce or complaint rate is past the critical limit, at which sending is suspended automatically, so stop mailing addresses that bounce or never engage and send only to people who opted in.',
		fix: SUPPRESSIONS,
	},
	reputation_high: {
		sentence:
			'The bounce or complaint rate is high enough to put sending at risk, so remove addresses that bounce or never engage and send only to people who opted in.',
		fix: SUPPRESSIONS,
	},
	reputation_medium: {
		sentence:
			'The bounce or complaint rate is above its limit, so clean the list of addresses that bounce or never engage before the next send.',
		fix: SUPPRESSIONS,
	},
} as const satisfies Record<DeliveryHealthReason, DeliveryHealthExplanation>;

/** Named interpolation values for a reason's sentence. Strings only. */
export type DeliveryHealthReasonParams = Readonly<Record<string, string>>;

/** Whether a value read off the roll-up is a reason this build can word. */
export function isDeliveryHealthReason(value: unknown): value is DeliveryHealthReason {
	return (
		typeof value === 'string' && (DELIVERY_HEALTH_REASONS as readonly string[]).includes(value)
	);
}
