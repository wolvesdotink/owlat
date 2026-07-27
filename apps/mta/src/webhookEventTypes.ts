/**
 * The MTA -> Convex webhook EVENT payload types.
 *
 * Split out of `types.ts` (CONVENTIONS.md — split a file rather than growing it
 * past ~500 LOC): this is one cohesive contract, the widest single type in the
 * service, and the surface every webhook consumer reads. `types.ts` re-exports
 * it so existing `from './types.js'` imports keep working unchanged.
 */

import type {
	PostmasterComplianceCheck,
	PostmasterDeliveryError,
} from '@owlat/shared/mtaWebhookEvent';
import type {
	DestinationProviderKey,
	InboundEmailPayload,
	MailboxInboundPayload,
} from './types.js';

export type MtaWebhookEventType = import('@owlat/shared/mtaWebhookEvent').MtaWebhookEventType;

export interface MtaWebhookEvent {
	/** Event type */
	event: MtaWebhookEventType;
	/** Stable producer identity for end-to-end idempotent event consumers. */
	eventId?: string;
	/** Owlat message ID for correlation */
	messageId?: string;
	/**
	 * Complained/bounced recipient address. Carried on `complained` events
	 * extracted from an ARF feedback-report part (RFC 5965 §3.2) when no
	 * original Message-ID is recoverable, so Convex can suppress the
	 * complainer by email instead of dropping the complaint.
	 */
	recipient?: string;
	/** Organization ID (for org-level events) */
	organizationId?: string;
	deliveryDomain?: import('@owlat/shared').DeliveryDomain;
	/** Phase-2 MX-derived receiver identity for accepted-delivery telemetry. */
	destinationProvider?: DestinationProviderKey;
	/** PSL-correct primary sending domain used by Gmail's bulk classification. */
	primarySendingDomain?: string;
	/** Bounce type (for bounce events) */
	bounceType?: 'hard' | 'soft';
	/** Human-readable message */
	message?: string;
	/** Closed lifecycle failure code for terminal non-delivery events. */
	errorCode?: string;
	/** Affected IP (for IP events) */
	ip?: string;
	/** Blocklists the IP is listed on */
	blocklists?: string[];
	/** Remote message ID assigned by the receiving server */
	remoteMessageId?: string;
	/** Severity level */
	severity?: 'info' | 'warning' | 'critical';
	/** Bounce rate (for circuit breaker events) */
	bounceRate?: number;
	/** Sending domain (for dkim.rotated events) */
	domain?: string;
	/**
	 * ARF `Reported-Domain` (for `complained` events) — OUR sending/DKIM domain
	 * the report was filed against, bounded to a strict FQDN at the emission site
	 * in `bounce/outcome.ts`. Convex uses it to keep a DKIM-domain-based
	 * feedback-loop enrollment (Yahoo's CFL) marked live.
	 */
	reportedDomain?: string;
	/**
	 * The feedback-loop source ISP (for `complained` events), mapped from the ARF
	 * processor's own token enum onto the shipped destination-provider CELL key so
	 * a consumer comparing it to `'yahoo'` compares against a checked constant.
	 */
	sourceIsp?: DestinationProviderKey;
	/** New DKIM selector (for dkim.rotated events) */
	selector?: string;
	/** New DKIM public-key DNS TXT record value (for dkim.rotated events) */
	dnsRecord?: string;
	/**
	 * DKIM rotation phase (for dkim.rotated events): `'pending'` when the new
	 * selector is published alongside the active one during the overlap,
	 * `'activated'` once signing switches and the old selector retires.
	 */
	phase?: 'pending' | 'activated';
	/** Campaign ID (for campaign.complaint_rate events) */
	campaignId?: string;
	/** Complaint rate as a fraction 0..1 (for campaign.complaint_rate events) */
	complaintRate?: number;
	/** Google Postmaster daily observation fields (`postmaster.stats`). */
	date?: string;
	userReportedSpamRatio?: number;
	/** Inbound email payload (for inbound.received events) */
	inboundPayload?: InboundEmailPayload;
	/** Personal-mailbox payload (for inbound.mailbox.received events) */
	mailboxPayload?: MailboxInboundPayload;
	/** Opaque Convex state handle for a pre-network routing re-entry. */
	routingReentryToken?: string;
	workAttemptId?: string;
	routingReentry?: {
		envelopeInput: unknown;
		retryState: {
			attempt: number;
			startedAt: number;
			idempotencyKey: string;
			workAttemptId?: string;
			acceptanceReconciliation?: boolean;
		};
	};
	routingReentryReason?:
		| 'routing_lease_stale'
		| 'circuit_breaker_changed'
		| 'warming_capacity_changed';
	/** Confirmed IPv6 identity/SPF regression fields. */
	readinessCheck?: 'fcrdns' | 'spf';
	readinessReason?: string;
	eligibilityGeneration?: number;
	/** End-to-end Deliverability Center probe observation. */
	probeToken?: string;
	spfResult?: string;
	dkimResult?: string;
	dmarcResult?: string;
	tlsVersion?: string;
	ptr?: string;
	/** Timestamp */
	timestamp: number;
}

export interface GooglePostmasterStatsEvent extends MtaWebhookEvent {
	event: 'postmaster.stats';
	domain: string;
	date: string;
	userReportedSpamRatio: number;
	// Every field below is optional on purpose: Google returns a metric only
	// when the domain had enough traffic that day, so a partial response is
	// normal operation and must never be treated as an error.
	spfSuccessRatio?: number;
	dkimSuccessRatio?: number;
	dmarcSuccessRatio?: number;
	deliveryErrorRatio?: number;
	deliveryErrors?: PostmasterDeliveryError[];
}

/**
 * Compliance Status is a point-in-time verdict rather than a daily metric, so
 * it travels as its own event keyed by the UTC day it was observed.
 */
export interface GooglePostmasterComplianceEvent extends MtaWebhookEvent {
	event: 'postmaster.compliance';
	domain: string;
	date: string;
	checks: PostmasterComplianceCheck[];
}

export interface GooglePostmasterDomainAuthorizationEvent extends MtaWebhookEvent {
	event: 'postmaster.authorize_domain';
	domain: string;
}

export type GooglePostmasterWebhookEvent =
	| GooglePostmasterDomainAuthorizationEvent
	| GooglePostmasterStatsEvent
	| GooglePostmasterComplianceEvent;
