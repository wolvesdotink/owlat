/**
 * Turning Google Postmaster Tools v2 telemetry into operator actions.
 *
 * Pure: takes the stored signals for one domain and returns the cards the
 * delivery screens render. No clock, no database, no environment — the whole
 * translation from "a raw API field went red" to "here is what to do about it"
 * lives here and is unit-tested exhaustively.
 *
 * Absence is not a finding. A domain with no Postmaster data produces NO cards
 * at all: the operator who never connected a Google account sees a calm
 * "not connected" affordance, never a warning and never a nag.
 */

import type {
	PostmasterComplianceCheck,
	PostmasterDeliveryError,
} from '@owlat/shared/mtaWebhookEvent';

export type { PostmasterComplianceCheck, PostmasterDeliveryError };

export type PostmasterCardSeverity = 'critical' | 'warning' | 'info';

export interface PostmasterCard {
	/** Stable identity for keyed rendering and de-duplication. */
	id: string;
	severity: PostmasterCardSeverity;
	/** The failing check, in operator words rather than the raw API token. */
	title: string;
	/** What Google is reporting. */
	detail: string;
	/** What to do about it. */
	remedy: string;
	/** The raw Postmaster check name, for support conversations. */
	check: string;
}

/** Everything stored for one domain's most recent Postmaster observation. */
export interface PostmasterDomainSignals {
	domain: string;
	userReportedSpamRatio: number | null;
	spfSuccessRatio: number | null;
	dkimSuccessRatio: number | null;
	dmarcSuccessRatio: number | null;
	deliveryErrorRatio: number | null;
	deliveryErrors: PostmasterDeliveryError[];
	checks: PostmasterComplianceCheck[];
}

/** Google's published spam-rate line; above it Gmail filtering changes. */
export const POSTMASTER_SPAM_RATE_LIMIT = 0.003;
/** Below this share of authenticated traffic a bulk sender is out of policy. */
export const POSTMASTER_AUTH_SUCCESS_FLOOR = 0.95;

interface CheckCopy {
	title: string;
	remedy: string;
	severity: PostmasterCardSeverity;
}

/**
 * Copy for the Compliance Status checks Google documents today. A check we do
 * not have copy for still renders — see `genericCheckCopy` — so a new check
 * name shipped by Google becomes visible instead of silently disappearing.
 */
const SPAM_RATE_COPY: CheckCopy = {
	title: 'Gmail user-reported spam rate is over the line',
	remedy:
		'Pause or slow the affected campaigns, tighten who you send to (drop unengaged contacts), and make the unsubscribe link obvious. The rate has to stay under 0.3% measured over a rolling window.',
	severity: 'critical',
};

const CHECK_COPY: Readonly<Record<string, CheckCopy>> = {
	SPAM_RATE: SPAM_RATE_COPY,
	DOMAIN_REPUTATION: {
		title: 'Gmail rates this domain badly',
		remedy:
			'Send only to recent, engaged contacts for a while. Domain reputation recovers with consistent low-complaint volume, not with more volume.',
		severity: 'critical',
	},
	IP_REPUTATION: {
		title: 'Gmail rates the sending IP badly',
		remedy:
			'Check the IP against the blocklists on the delivery page, slow the warm-up, and keep sending steady rather than bursty.',
		severity: 'critical',
	},
	AUTHENTICATION: {
		title: 'Authentication is failing for some mail',
		remedy:
			'Re-check SPF, DKIM and DMARC for this domain on the domain setup page. Every message from a bulk sender has to pass SPF or DKIM, and DMARC has to be aligned.',
		severity: 'critical',
	},
	SPF: {
		title: 'SPF is failing for some mail',
		remedy:
			'Republish the SPF record shown on the domain setup page and remove any competing SPF record on the same host.',
		severity: 'warning',
	},
	DKIM: {
		title: 'DKIM is failing for some mail',
		remedy:
			'Republish the DKIM record for every active selector on the domain setup page and wait for it to propagate before resuming.',
		severity: 'warning',
	},
	DMARC: {
		title: 'DMARC is failing or missing',
		remedy:
			'Publish the DMARC record shown on the domain setup page. Bulk senders need a policy of at least p=none, aligned with the From domain.',
		severity: 'warning',
	},
	ENCRYPTION: {
		title: 'Mail is being sent without TLS',
		remedy:
			'Outbound TLS is required. Check the TLS report card on the delivery page for the routes that fell back to plaintext.',
		severity: 'warning',
	},
	UNSUBSCRIBE: {
		title: 'One-click unsubscribe is not being honoured',
		remedy:
			'Every bulk message needs a List-Unsubscribe header and must action the request within two days. Check the unsubscribe card on the delivery page.',
		severity: 'warning',
	},
};

function genericCheckCopy(check: string): CheckCopy {
	return {
		title: `Google reports a failing check: ${check}`,
		remedy:
			'Open Google Postmaster Tools for this domain to see the detail. Owlat has no specific guidance for this check yet.',
		severity: 'warning',
	};
}

function percent(ratio: number): string {
	return `${(ratio * 100).toFixed(ratio < 0.01 ? 2 : 1)}%`;
}

/**
 * Which namespace a card's `check` lives in. Compliance check names and
 * delivery-error categories are different vocabularies that happen to share a
 * shape, so they must never collide when cards are de-duplicated: a future
 * Google check named after a category would otherwise suppress a card.
 */
type CardNamespace = 'complianceCheck' | 'deliveryErrorCategory';

interface KeyedCard {
	namespace: CardNamespace;
	card: PostmasterCard;
}

function complianceCards(signals: PostmasterDomainSignals): KeyedCard[] {
	const cards: KeyedCard[] = [];
	for (const check of signals.checks) {
		if (check.state !== 'failing') continue;
		const copy = CHECK_COPY[check.name] ?? genericCheckCopy(check.name);
		cards.push({
			namespace: 'complianceCheck',
			card: {
				id: `check:${check.name}`,
				severity: copy.severity,
				title: copy.title,
				detail: `Google Postmaster reports the ${check.name} compliance check as failing for ${signals.domain}.`,
				remedy: copy.remedy,
				check: check.name,
			},
		});
	}
	return cards;
}

const AUTH_METRICS = [
	{ key: 'spfSuccessRatio', check: 'SPF' },
	{ key: 'dkimSuccessRatio', check: 'DKIM' },
	{ key: 'dmarcSuccessRatio', check: 'DMARC' },
] as const;

function metricCards(signals: PostmasterDomainSignals): KeyedCard[] {
	const cards: KeyedCard[] = [];
	const spam = signals.userReportedSpamRatio;
	if (spam !== null && spam >= POSTMASTER_SPAM_RATE_LIMIT) {
		cards.push({
			namespace: 'complianceCheck',
			card: {
				id: 'metric:SPAM_RATE',
				severity: SPAM_RATE_COPY.severity,
				title: SPAM_RATE_COPY.title,
				detail: `Gmail users marked ${percent(spam)} of ${signals.domain}'s mail as spam; Google's line is ${percent(POSTMASTER_SPAM_RATE_LIMIT)}.`,
				remedy: SPAM_RATE_COPY.remedy,
				check: 'SPAM_RATE',
			},
		});
	}
	for (const metric of AUTH_METRICS) {
		const ratio = signals[metric.key];
		if (ratio === null || ratio >= POSTMASTER_AUTH_SUCCESS_FLOOR) continue;
		const copy = CHECK_COPY[metric.check] ?? genericCheckCopy(metric.check);
		cards.push({
			namespace: 'complianceCheck',
			card: {
				id: `metric:${metric.check}`,
				severity: copy.severity,
				title: copy.title,
				detail: `Only ${percent(ratio)} of ${signals.domain}'s mail to Gmail passed ${metric.check}.`,
				remedy: copy.remedy,
				check: metric.check,
			},
		});
	}
	const worstDeliveryError = [...signals.deliveryErrors].sort((a, b) => b.ratio - a.ratio)[0];
	if (worstDeliveryError !== undefined && worstDeliveryError.ratio > 0) {
		cards.push({
			namespace: 'deliveryErrorCategory',
			card: {
				id: `deliveryError:${worstDeliveryError.category}`,
				severity: 'warning',
				title: 'Gmail is rejecting some mail',
				detail: `Google's most common rejection reason for ${signals.domain} is ${worstDeliveryError.category}, affecting ${percent(worstDeliveryError.ratio)} of traffic.`,
				remedy:
					'Rejection reasons are Gmail-specific. Rate limiting resolves itself if you slow down; reputation and content reasons need the same fix as a failing compliance check.',
				check: worstDeliveryError.category,
			},
		});
	}
	return cards;
}

const SEVERITY_ORDER: Readonly<Record<PostmasterCardSeverity, number>> = {
	critical: 0,
	warning: 1,
	info: 2,
};

/**
 * The actionable cards for one domain, most severe first, de-duplicated so a
 * failing compliance check and the metric behind it never both appear.
 */
export function derivePostmasterCards(signals: PostmasterDomainSignals): PostmasterCard[] {
	const byKey = new Map<string, PostmasterCard>();
	// Compliance Status first: it is Google's own verdict, so it wins over our
	// threshold on the same underlying check.
	for (const keyed of [...complianceCards(signals), ...metricCards(signals)]) {
		const key = `${keyed.namespace}:${keyed.card.check}`;
		if (!byKey.has(key)) byKey.set(key, keyed.card);
	}
	return [...byKey.values()].sort(
		(a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
	);
}
