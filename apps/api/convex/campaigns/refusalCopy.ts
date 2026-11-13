/**
 * The catalog keys for every reason the campaign send pre-flight can refuse
 * with. `preflight.ts` attaches one to each refusal (as `messageKey`, with its
 * `messageParams`) next to the English `message`, so a client renders the
 * reason in the reader's language and an API consumer still gets a sentence.
 *
 * Pure data with no Convex imports: the web app imports this module
 * (`@owlat/api/campaignRefusal`) to check that both locale catalogs carry every
 * key, and to pick the page a refusal is fixed on.
 *
 * A reason with more than one wording has one key per variant, because the
 * catalog has no select syntax and two translated halves glued together are
 * not a sentence a translator can reorder.
 */

/** Every reason a pre-flight refusal can carry, as a runtime list. */
export const PREFLIGHT_FAILURE_REASONS = [
	'not_found',
	'no_template',
	'no_audience',
	'no_from_email',
	'no_delivery_provider',
	'domain_not_verified',
	'sender_not_allowed',
	'sending_not_allowed',
	'scheduled_in_past',
	'exceeds_sending_capacity',
	'mail_server_not_ready',
	'delivery_on_hold',
] as const;

export type PreflightFailureReason = (typeof PREFLIGHT_FAILURE_REASONS)[number];

/**
 * Reason → variant → catalog key. The keys live under `shared.` so the web
 * app's boot catalog carries them on every route, including the command
 * palette and the desktop shell.
 */
export const PREFLIGHT_MESSAGE_KEYS = {
	not_found: { default: 'shared.campaignRefusal.notFound' },
	no_template: {
		missing: 'shared.campaignRefusal.noTemplate',
		deleted: 'shared.campaignRefusal.templateDeleted',
	},
	no_audience: { default: 'shared.campaignRefusal.noAudience' },
	no_from_email: { default: 'shared.campaignRefusal.noFromEmail' },
	no_delivery_provider: { default: 'shared.campaignRefusal.noDeliveryProvider' },
	domain_not_verified: {
		invalidAddress: 'shared.campaignRefusal.domainInvalidAddress',
		missing: 'shared.campaignRefusal.domainMissing',
		unverified: 'shared.campaignRefusal.domainUnverified',
	},
	sender_not_allowed: { default: 'shared.campaignRefusal.senderNotAllowed' },
	sending_not_allowed: {
		suspended: 'shared.campaignRefusal.accountSuspended',
		banned: 'shared.campaignRefusal.accountBanned',
	},
	scheduled_in_past: { default: 'shared.campaignRefusal.scheduledInPast' },
	exceeds_sending_capacity: {
		truncated: 'shared.campaignRefusal.capacityTruncated',
		atLeast: 'shared.campaignRefusal.capacityAtLeast',
		about: 'shared.campaignRefusal.capacityAbout',
	},
	mail_server_not_ready: {
		unreachable: 'shared.campaignRefusal.mailServerUnreachable',
		port25Blocked: 'shared.campaignRefusal.mailServerPort25Blocked',
		allIpsHeld: 'shared.campaignRefusal.mailServerAllIpsHeld',
	},
	// Only a scheduled start records this one: delivery stayed on hold for the
	// whole wait at fire time (`campaigns/startGate.ts`).
	delivery_on_hold: { default: 'shared.campaignRefusal.deliveryOnHold' },
} as const satisfies Record<PreflightFailureReason, Readonly<Record<string, string>>>;

/** The variants one reason is worded in. */
export type PreflightMessageVariant<R extends PreflightFailureReason> =
	keyof (typeof PREFLIGHT_MESSAGE_KEYS)[R];

/** Any catalog key a refusal can carry. */
export type PreflightMessageKey = {
	[R in PreflightFailureReason]: (typeof PREFLIGHT_MESSAGE_KEYS)[R][PreflightMessageVariant<R>];
}[PreflightFailureReason];

/** Named interpolation values for a refusal's key. Strings and numbers only. */
export type PreflightMessageParams = Readonly<Record<string, string | number>>;

/** The key for one reason and variant. */
export function preflightMessageKey<R extends PreflightFailureReason>(
	reason: R,
	variant: PreflightMessageVariant<R>
): PreflightMessageKey {
	return PREFLIGHT_MESSAGE_KEYS[reason][variant] as PreflightMessageKey;
}

/** Every key the catalog names, for the locale coverage check. */
export function allPreflightMessageKeys(): PreflightMessageKey[] {
	return PREFLIGHT_FAILURE_REASONS.flatMap(
		(reason) => Object.values(PREFLIGHT_MESSAGE_KEYS[reason]) as PreflightMessageKey[]
	);
}

/** Whether a value read off an error payload is a pre-flight reason. */
export function isPreflightFailureReason(value: unknown): value is PreflightFailureReason {
	return (
		typeof value === 'string' && (PREFLIGHT_FAILURE_REASONS as readonly string[]).includes(value)
	);
}
