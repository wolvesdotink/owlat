/**
 * The MTA -> Convex webhook event SHAPE (D7) — ONE declaration of the field
 * set, read from both ends.
 *
 * It used to be two. `packages/shared/src/mtaWebhookEvent.ts` held the
 * discriminated union Convex validates arriving events against, and
 * `apps/mta/src/webhookEventTypes.ts` held a wide flat interface the MTA's
 * producers built events into — overlapping but not equal field sets, each
 * free to gain a field the other never heard of. Both are now views of
 * {@link MtaWebhookEventFields}: {@link MtaWebhookEventDraft} is the producer's
 * (every field optional, the payload types its own), and
 * {@link ValidatedMtaWebhookEvent} is the wire union `isMtaWebhookEvent` proves.
 *
 * ON THE TWO NAMES. The validated union is deliberately NOT called
 * `MtaWebhookEvent`: `apps/mta` already owns that name for its producer draft
 * (`src/webhookEventTypes.ts`), and one identifier meaning two different types
 * either side of one wire is exactly the confusion this package exists to
 * remove. A draft is not proof, and the names now say so.
 */

import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import type { DeliveryDomain } from '@owlat/shared/routingDispatch';
import type { SmtpFailureCategory } from '@owlat/shared/smtpBlockCategories';

export const MTA_WEBHOOK_EVENT_TYPES = [
	'sent',
	'bounced',
	'failed',
	'complained',
	'smtp.classified',
	'org.circuit_breaker',
	'campaign.complaint_rate',
	'ip.blocklisted',
	'ip.delisted',
	'ip.warming_complete',
	'all_ips_blocked',
	'postmaster.authorize_domain',
	'postmaster.stats',
	'postmaster.compliance',
	'dkim.rotated',
	'inbound.received',
	'routing.reentry',
	'inbound.mailbox.received',
	'ip.readiness_regressed',
	'deliverability.probe_observed',
] as const;

export type MtaWebhookEventType = (typeof MTA_WEBHOOK_EVENT_TYPES)[number];

// ─── Google Postmaster Tools contract ──────────────────────────────────────
// One definition of the shapes and of the sanitization bounds, imported by the
// MTA collector and by the Convex ingest. Each end still re-VALIDATES at its
// own trust boundary; what must never drift is the numbers it validates
// against — a collector that kept more checks than this guard accepts would
// have the whole event rejected and the day's verdict silently lost.

/** One Compliance Status check as Google reports it, normalized. */
export interface PostmasterComplianceCheck {
	name: string;
	state: 'passing' | 'failing' | 'unknown';
}

/** One delivery-error category's share of a domain's traffic for a day. */
export interface PostmasterDeliveryError {
	category: string;
	ratio: number;
}

/**
 * The only shape a Postmaster check name or delivery-error category may take.
 * Both are stored and rendered verbatim, so anything else is DROPPED rather
 * than escaped.
 */
export const POSTMASTER_TOKEN = /^[A-Z0-9_]{1,64}$/;
/** Upper bound on the Compliance Status checks carried for one domain/day. */
export const POSTMASTER_MAX_COMPLIANCE_CHECKS = 32;
/** Upper bound on the delivery-error categories carried for one domain/day. */
export const POSTMASTER_MAX_DELIVERY_ERROR_CATEGORIES = 24;

/**
 * The three nested blobs whose SHAPE is the producer's business, not the wire's.
 *
 * Convex re-parses each of them at its own trust boundary and so accepts them
 * as `object` — which is exactly what {@link isMtaWebhookEvent} proves and
 * therefore all the validated union may claim. The MTA builds them from its own
 * parsed types and wants those types back. One field declaration serves both by
 * taking them as a parameter; the alternative (two field lists, one per end) is
 * the duplication this module exists to delete.
 */
export interface MtaWebhookPayloads {
	inbound: object;
	mailbox: object;
	routingReentry: object;
}

/**
 * EVERY field any MTA webhook event may carry, all optional.
 *
 * Declared once here; narrowed per event kind by
 * {@link ValidatedMtaWebhookEvent}'s variants, and left wide by
 * {@link MtaWebhookEventDraft} for the producers.
 */
export interface MtaWebhookEventFields<P extends MtaWebhookPayloads = MtaWebhookPayloads> {
	eventId?: string;
	messageId?: string;
	/**
	 * Complained/bounced recipient address. Carried on `complained` events
	 * extracted from an ARF feedback-report part (RFC 5965 §3.2) when no
	 * original Message-ID is recoverable, so Convex can suppress the
	 * complainer by email instead of dropping the complaint.
	 */
	recipient?: string;
	organizationId?: string;
	deliveryDomain?: DeliveryDomain;
	destinationProvider?: DestinationProviderKey;
	primarySendingDomain?: string;
	remoteMessageId?: string;
	severity?: 'info' | 'warning' | 'critical';
	message?: string;
	errorCode?: string;
	ip?: string;
	blocklists?: string[];
	bounceRate?: number;
	/** Bounce classification (for `bounced` events). */
	bounceType?: 'hard' | 'soft';
	/**
	 * RFC 5965 `Reported-Domain` from the ARF report (for `complained` events) —
	 * OUR sending/DKIM domain the complaint was filed against, bounded to a
	 * strict FQDN at the emission site. Optional: many ISPs omit it. Convex uses
	 * it to keep a DKIM-domain-based feedback-loop enrollment (Yahoo's CFL)
	 * marked live.
	 */
	reportedDomain?: string;
	/**
	 * The feedback-loop source ISP the MTA's ARF processor resolved (for
	 * `complained` events). Typed as the shipped destination-provider union
	 * rather than a free string, so a consumer comparing it to `'yahoo'` is
	 * comparing against a checked constant. An ISP outside the union is simply
	 * not forwarded.
	 */
	sourceIsp?: DestinationProviderKey;
	domain?: string;
	selector?: string;
	dnsRecord?: string;
	phase?: 'pending' | 'activated';
	campaignId?: string;
	complaintRate?: number;
	date?: string;
	userReportedSpamRatio?: number;
	spfSuccessRatio?: number;
	dkimSuccessRatio?: number;
	dmarcSuccessRatio?: number;
	deliveryErrorRatio?: number;
	deliveryErrors?: PostmasterDeliveryError[];
	checks?: PostmasterComplianceCheck[];
	/** Parsed inbound email content (for `inbound.received` events). */
	inboundPayload?: P['inbound'];
	/** Personal-mailbox payload (for `inbound.mailbox.received` events). */
	mailboxPayload?: P['mailbox'];
	/** Opaque Convex state handle for a pre-network routing re-entry. */
	routingReentryToken?: string;
	workAttemptId?: string;
	/** Callback material whose canonical digest is authenticated by the token. */
	routingReentry?: P['routingReentry'];
	routingReentryReason?:
		| 'routing_lease_stale'
		| 'circuit_breaker_changed'
		| 'warming_capacity_changed';
	/** Classifier verdict for one `smtp.classified` receiver response. */
	smtpCategory?: SmtpFailureCategory;
	readinessCheck?: 'fcrdns' | 'spf';
	readinessReason?: string;
	eligibilityGeneration?: number;
	probeToken?: string;
	spfResult?: string;
	dkimResult?: string;
	dmarcResult?: string;
	tlsVersion?: string;
	ptr?: string;
}

/**
 * The PRODUCER's view: the whole field set, every field optional, over the
 * producer's own payload types.
 *
 * This is what the MTA's emitters build and what its durable outbox carries.
 * `isMtaWebhookEvent` is what turns one of these into a
 * {@link ValidatedMtaWebhookEvent} at the ingress boundary — a draft is not
 * proof.
 */
export type MtaWebhookEventDraft<P extends MtaWebhookPayloads = MtaWebhookPayloads> =
	MtaWebhookEventFields<P> & {
		event: MtaWebhookEventType;
		timestamp: number;
	};

/**
 * The fields the VALIDATED union carries on every variant.
 *
 * Three fields are subtracted, and the subtraction is the point: `bounceType`,
 * `reportedDomain` and `sourceIsp` belong to `bounced`/`complained` alone, and
 * the pre-D7 Convex union forbade reading them anywhere else. Sharing one field
 * declaration with the producer draft must not quietly hand every variant a
 * `sourceIsp` that is always `undefined` — the variants below re-add each one
 * where it genuinely travels.
 */
interface EventBase<K extends MtaWebhookEventType> extends Omit<
	MtaWebhookEventFields,
	'bounceType' | 'reportedDomain' | 'sourceIsp'
> {
	event: K;
	timestamp: number;
}

/** The VALIDATED wire union — what `isMtaWebhookEvent` proves. */
export type ValidatedMtaWebhookEvent =
	| (EventBase<'sent'> & { messageId: string })
	| (EventBase<'bounced'> & {
			messageId?: string;
			recipient?: string;
			bounceType?: 'hard' | 'soft';
	  })
	| (EventBase<'failed'> & { messageId: string; message?: string; errorCode?: string })
	| (EventBase<'smtp.classified'> & {
			messageId: string;
			smtpCategory: SmtpFailureCategory;
	  })
	| (EventBase<'complained'> & {
			messageId?: string;
			recipient?: string;
			message?: string;
			/** FBL-only; see {@link MtaWebhookEventFields.reportedDomain}. */
			reportedDomain?: string;
			/** FBL-only; see {@link MtaWebhookEventFields.sourceIsp}. */
			sourceIsp?: DestinationProviderKey;
	  })
	| (EventBase<'org.circuit_breaker'> & {
			organizationId: string;
			bounceRate: number;
			message: string;
	  })
	| (EventBase<'campaign.complaint_rate'> & {
			eventId: string;
			campaignId: string;
			complaintRate: number;
			message: string;
	  })
	| (EventBase<'ip.blocklisted'> & { ip: string; message: string; blocklists?: string[] })
	| (EventBase<'ip.delisted'> & { ip: string; message: string })
	| (EventBase<'ip.warming_complete'> & { ip: string; message: string })
	| (EventBase<'all_ips_blocked'> & { message: string })
	| (EventBase<'postmaster.authorize_domain'> & { domain: string })
	| (EventBase<'postmaster.stats'> & {
			domain: string;
			date: string;
			userReportedSpamRatio: number;
			spfSuccessRatio?: number;
			dkimSuccessRatio?: number;
			dmarcSuccessRatio?: number;
			deliveryErrorRatio?: number;
			deliveryErrors?: PostmasterDeliveryError[];
	  })
	| (EventBase<'postmaster.compliance'> & {
			domain: string;
			date: string;
			checks: PostmasterComplianceCheck[];
	  })
	| (EventBase<'dkim.rotated'> & {
			domain: string;
			selector: string;
			dnsRecord: string;
			phase: 'pending' | 'activated';
	  })
	| (EventBase<'inbound.received'> & { organizationId: string; inboundPayload: object })
	| (EventBase<'routing.reentry'> & {
			messageId: string;
			routingReentryToken: string;
			workAttemptId: string;
			routingReentry: object;
			routingReentryReason:
				| 'routing_lease_stale'
				| 'circuit_breaker_changed'
				| 'warming_capacity_changed';
	  })
	| (EventBase<'inbound.mailbox.received'> & {
			organizationId: string;
			mailboxPayload: object;
	  })
	| (EventBase<'ip.readiness_regressed'> & {
			eventId: string;
			ip: string;
			readinessCheck: 'fcrdns' | 'spf';
			readinessReason: string;
			eligibilityGeneration: number;
			message: string;
	  })
	| (EventBase<'deliverability.probe_observed'> & {
			eventId: string;
			probeToken: string;
			spfResult: string;
			dkimResult: string;
			dmarcResult: string;
			ip: string;
			tlsVersion: string;
			ptr: string;
			selector?: string;
	  });

// ─── Google Postmaster producer refinements ────────────────────────────────
// The collector builds these three DRAFTS, so they narrow the draft rather
// than the validated union: an emitter must still pass the ingress guard like
// any other producer. The required-field lists match the corresponding union
// variants above by construction — the ingress rejects anything looser.

export type GooglePostmasterDomainAuthorizationEvent<
	P extends MtaWebhookPayloads = MtaWebhookPayloads,
> = MtaWebhookEventDraft<P> & {
	event: 'postmaster.authorize_domain';
	domain: string;
};

export type GooglePostmasterStatsEvent<P extends MtaWebhookPayloads = MtaWebhookPayloads> =
	MtaWebhookEventDraft<P> & {
		event: 'postmaster.stats';
		domain: string;
		date: string;
		userReportedSpamRatio: number;
		// Every field below stays optional on purpose: Google returns a metric
		// only when the domain had enough traffic that day, so a partial response
		// is normal operation and must never be treated as an error.
	};

/**
 * Compliance Status is a point-in-time verdict rather than a daily metric, so
 * it travels as its own event keyed by the UTC day it was observed.
 */
export type GooglePostmasterComplianceEvent<P extends MtaWebhookPayloads = MtaWebhookPayloads> =
	MtaWebhookEventDraft<P> & {
		event: 'postmaster.compliance';
		domain: string;
		date: string;
		checks: PostmasterComplianceCheck[];
	};

export type GooglePostmasterWebhookEvent<P extends MtaWebhookPayloads = MtaWebhookPayloads> =
	| GooglePostmasterDomainAuthorizationEvent<P>
	| GooglePostmasterStatsEvent<P>
	| GooglePostmasterComplianceEvent<P>;

/**
 * The ingress bound on every human-readable `message` field. Convex rejects the
 * WHOLE event when it is exceeded, so producers that must not be dropped (the
 * DNSBL halt alert) build their message to fit against this exact number rather
 * than a duplicated literal.
 */
export const MTA_WEBHOOK_MESSAGE_MAX_LENGTH = 512;
