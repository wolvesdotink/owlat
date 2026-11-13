/**
 * Why a campaign cannot go out, and where that is fixed.
 *
 * Two sources feed the same note: a send or schedule the pre-flight refused
 * (`campaigns/preflight.ts`, which names a catalog key for each reason), and
 * what the campaign editor and the wizard's review step can already see before
 * the click (no delivery provider, an unregistered or unverified domain). Both
 * use the same catalog keys, so the warning before the click and the refusal
 * after it read the same.
 *
 * Module scope, so no `useI18n` here: the note component resolves the keys.
 */
import type { OperationError } from '@owlat/shared/operationError';
import {
	PREFLIGHT_MESSAGE_KEYS,
	isPreflightFailureReason,
	type PreflightFailureReason,
} from '@owlat/api/campaignRefusal';
import type { LocalizedText } from '~/utils/localizedText';

export type MessageParams = Record<string, string | number>;

/** A pre-flight refusal read off a failed send or schedule. */
export interface CampaignRefusal {
	reason: PreflightFailureReason;
	/** `null` when the backend named no key; the note then shows `message`. */
	messageKey: string | null;
	params: MessageParams;
	/** The backend's English sentence. */
	message: string;
}

function plainParams(value: unknown): MessageParams {
	if (!value || typeof value !== 'object') return {};
	const params: MessageParams = {};
	for (const [name, param] of Object.entries(value as Record<string, unknown>)) {
		if (typeof param === 'string' || typeof param === 'number') params[name] = param;
	}
	return params;
}

/**
 * The pre-flight refusal an operation failed with, or `null` for any other
 * failure (which stays on the default toast path).
 */
export function campaignRefusalOf(error: OperationError): CampaignRefusal | null {
	if (error.category !== 'invalid_state') return null;
	const reason = error.data?.['reason'];
	if (!isPreflightFailureReason(reason)) return null;
	const messageKey = error.data?.['messageKey'];
	return {
		reason,
		messageKey: typeof messageKey === 'string' ? messageKey : null,
		params: plainParams(error.data?.['messageParams']),
		message: error.message,
	};
}

/** The page a reason is fixed on, and the link's label key. */
export interface RefusalFixLink {
	to: string;
	labelKey: string;
}

/**
 * Every target is an admin page (`middleware/admin.ts`), so the note shows the
 * link to admins only. A reason fixed inside the campaign itself (template,
 * audience, sender field, a past time) or not fixable here has no link.
 */
const FIX_LINKS: Readonly<Record<PreflightFailureReason, RefusalFixLink | null>> = {
	not_found: null,
	no_template: null,
	no_audience: null,
	no_from_email: null,
	no_delivery_provider: {
		to: '/dashboard/admin/delivery/transport',
		labelKey: 'shared.campaignRefusal.fix.transport',
	},
	domain_not_verified: {
		to: '/dashboard/admin/delivery/domains',
		labelKey: 'shared.campaignRefusal.fix.domains',
	},
	sender_not_allowed: {
		to: '/dashboard/admin/team/senders',
		labelKey: 'shared.campaignRefusal.fix.senders',
	},
	// The delivery hub carries the account-status banner.
	sending_not_allowed: {
		to: '/dashboard/admin/delivery',
		labelKey: 'shared.campaignRefusal.fix.deliveryHub',
	},
	scheduled_in_past: null,
	exceeds_sending_capacity: {
		to: '/dashboard/admin/delivery',
		labelKey: 'shared.campaignRefusal.fix.deliveryHub',
	},
	// The hub's readiness panel names the mail-server, port 25 and sending-IP
	// gates this refusal is judged on.
	mail_server_not_ready: {
		to: '/dashboard/admin/delivery',
		labelKey: 'shared.campaignRefusal.fix.deliveryHub',
	},
	delivery_on_hold: {
		to: '/dashboard/admin/delivery',
		labelKey: 'shared.campaignRefusal.fix.deliveryHub',
	},
};

export function refusalFixLink(reason: PreflightFailureReason): RefusalFixLink | null {
	return FIX_LINKS[reason];
}

/** A refusal as the campaign row stores it after a scheduled start gave up. */
export interface StoredStartRefusal {
	reason: string;
	messageKey: string;
	messageParams?: Record<string, string | number>;
	message: string;
	scheduledAt: number;
}

/**
 * The note for a stored start refusal. A reason this build does not know (a
 * newer backend) still shows its sentence, without a fix link.
 */
export function blockerFromStartRefusal(
	refusal: StoredStartRefusal,
	hasMessage: (key: string) => boolean
): SendBlocker {
	return {
		message: hasMessage(refusal.messageKey)
			? { key: refusal.messageKey, params: plainParams(refusal.messageParams) }
			: refusal.message,
		fix: isPreflightFailureReason(refusal.reason) ? refusalFixLink(refusal.reason) : null,
	};
}

export interface SendBlocker {
	/** A catalog key with its params, or the backend's sentence as is. */
	message: LocalizedText;
	fix: RefusalFixLink | null;
}

/**
 * The note for a refusal. A key the catalog does not carry (an older or newer
 * backend) falls back to the backend's sentence rather than to a bare key.
 */
export function blockerFromRefusal(
	refusal: CampaignRefusal,
	hasMessage: (key: string) => boolean
): SendBlocker {
	return {
		message:
			refusal.messageKey && hasMessage(refusal.messageKey)
				? { key: refusal.messageKey, params: refusal.params }
				: refusal.message,
		fix: refusalFixLink(refusal.reason),
	};
}

/** The domain verification answer, in the shape the domain query returns it. */
export interface DomainVerification {
	domain: string;
	exists: boolean;
	verified: boolean;
}

/**
 * What blocks the send before the click, in the pre-flight's own order
 * (delivery provider before domain). `deliveryConfigured` and `domain` are
 * `undefined` while their queries load; unknown never blocks.
 */
export function presendBlocker(input: {
	deliveryConfigured: boolean | undefined;
	domain: DomainVerification | null | undefined;
}): SendBlocker | null {
	if (input.deliveryConfigured === false) {
		return {
			message: { key: PREFLIGHT_MESSAGE_KEYS.no_delivery_provider.default },
			fix: refusalFixLink('no_delivery_provider'),
		};
	}
	const domain = input.domain;
	if (domain && domain.domain && !domain.verified) {
		return {
			message: {
				key: domain.exists
					? PREFLIGHT_MESSAGE_KEYS.domain_not_verified.unverified
					: PREFLIGHT_MESSAGE_KEYS.domain_not_verified.missing,
				params: { domain: domain.domain },
			},
			fix: refusalFixLink('domain_not_verified'),
		};
	}
	return null;
}
