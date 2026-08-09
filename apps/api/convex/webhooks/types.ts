/**
 * Shared types for the inbound webhook pipeline and the outbound webhook
 * event modules. See ADR-0003 + ADR-0005 for the design and CONTEXT.md for
 * the vocabulary (Inbound event, Webhook event module).
 */

import type { Validator } from 'convex/values';
import type { InboundEmailMessage } from '@owlat/channels';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import type { DeliveryDomain } from '@owlat/shared';
import type {
	PostmasterComplianceCheck,
	PostmasterDeliveryError,
} from '@owlat/mta-protocol/webhookEvent';
import type { SmtpFailureCategory } from '@owlat/shared/smtpBlockCategories';
import type { WorkerEnvelopeInput, WorkerRetryState } from '../delivery/workerEnvelope';

// ─── Inbound side ──────────────────────────────────────────────────────────

/** Normalized inbound mail shape — canonical type from @owlat/channels. */
export type NormalizedInboundMail = InboundEmailMessage;

/** Provider-agnostic discriminator for non-email customer channels. */
export type ChannelKind = 'sms' | 'whatsapp' | 'generic';

/**
 * THE CLOSED VOCABULARY A PROVIDER'S OWN SUPPRESSION POLICY SPEAKS.
 *
 * Every send provider that keeps a suppression list has its own words for why
 * an address is on it — Mandrill reports ten `reject_reason`s, Emailit a free
 * text `status`, a plugin whatever its provider publishes. Those words are
 * VENDOR SPELLINGS, and they are translated exactly once, in the adapter that
 * knows the vendor. What crosses into the host is one of these members, and the
 * host decides the CONSEQUENCE from it (`webhooks/providerSuppression.ts`).
 *
 * That split is the whole point: an adapter says what its provider observed, the
 * host says what Owlat does about it. A provider cannot invent a consequence,
 * and adding the next provider's suppression policy is a table in ITS adapter
 * plus (at most) a member here — never a branch in the dispatch table.
 *
 * A member is added only when it means something DIFFERENT to the recipient, not
 * merely something different to the provider: two vendor reasons that both mean
 * "this mailbox is permanently gone" share `hard_bounce` rather than earning a
 * spelling each. Members that describe OUR account, OUR sending domain or OUR
 * message have no place here at all — an adapter drops them, because
 * suppressing on them would let one misconfiguration blocklist a whole audience
 * one send at a time.
 *
 * The array is the single declaration: the union is derived from it, and the
 * host-side revalidation of a plugin batch (`webhooks/pluginFeedbackEvents.ts`)
 * reads the same array, so a member cannot exist for core adapters and be
 * unspeakable by a plugin.
 */
export const PROVIDER_SUPPRESSION_REASONS = [
	/** The provider refused this specific address for this send. */
	'recipient_rejected',
	/** The address sits on the provider's own blacklist. */
	'recipient_blacklisted',
	/** The mailbox does not exist. */
	'invalid_recipient',
	/** The address failed permanently, repeatedly enough for the provider to stop. */
	'hard_bounce',
	/** The address failed transiently, but for long enough for the provider to stop. */
	'soft_bounce',
	/** This person reported the mail as spam. */
	'spam_complaint',
	/** An operator (or an account rule) curated this address onto the list by hand. */
	'operator_suppressed',
	/** This person unsubscribed through the provider's own surface. */
	'unsubscribed',
] as const;

export type ProviderSuppressionReason = (typeof PROVIDER_SUPPRESSION_REASONS)[number];

/**
 * One provider's suppression fact about one recipient.
 *
 * `evidence` is the provider's OWN reason code, carried verbatim into the
 * blocklist provenance so an operator reading the suppression screen sees what
 * the provider actually said (`MANDRILL_REJECT_SOFT_BOUNCE`) rather than the
 * host's translation of it. Optional: a provider that publishes no code gets the
 * host's derived one. It is provider free text on a persisted field, so an
 * adapter normalizes it before it is minted, and the plugin lane does not accept
 * one at all.
 */
export interface ProviderSuppression {
	readonly reason: ProviderSuppressionReason;
	readonly evidence?: string;
}

/**
 * Channel content payload — the customer-message shape inside a
 * `channel.received` event. JSON-serialized into `unifiedMessages.content`
 * by the dispatcher.
 */
export interface ChannelContent {
	text?: string;
	html?: string;
	subject?: string;
	mediaUrl?: string;
}

/**
 * Provider-agnostic event arriving from any inbound source. Produced by
 * per-provider Inbound adapters (email + channel) plus the MTA SMTP bounce
 * server, consumed by the Webhook dispatcher. See CONTEXT.md "Inbound
 * event".
 *
 * The `email.*` kinds match Webhook event wire literals exactly so
 * dispatcher and outbound fanout share one vocabulary. `channel.received`
 * carries a `channel` discriminator field — one kind covers all non-email
 * customer channels. The `internal.*` kinds are never customer-fanned out.
 */
export type InboundEvent =
	| {
			kind: 'email.sent';
			providerMessageId: string;
			at: number;
			providerType?: string;
			destinationProvider?: DestinationProviderKey;
			primarySendingDomain?: string;
			deliveryDomain?: DeliveryDomain;
	  }
	| {
			kind: 'email.delivered';
			providerMessageId: string;
			at: number;
			providerType?: string;
			/** Untrusted telemetry only; cache binding derives tenant/recipient from Send. */
			organizationId?: string;
			recipient?: string;
			destinationProvider?: DestinationProviderKey;
			primarySendingDomain?: string;
			deliveryDomain?: DeliveryDomain;
	  }
	| {
			// Terminal, NON-bounce delivery failure. Emitted by the MTA for the
			// post-DATA ambiguous drop (AMBIGUOUS_TIMEOUT, W8): the receiver MAY have
			// accepted the message, so it is terminal but carries NO bounce semantics
			// — the dispatcher transitions the send row to `failed` WITHOUT recipient
			// suppression or any reputation penalty.
			kind: 'email.failed';
			providerMessageId: string;
			at: number;
			errorMessage: string;
			errorCode: string;
			providerType?: string;
			deliveryDomain?: DeliveryDomain;
			/**
			 * The address the terminal failure names, when the provider reports one.
			 *
			 * Set by an adapter whose provider names the address it refused (the
			 * Mandrill `reject`, plan D9/D10): mirroring that hit into
			 * `blockedEmails` needs the address. Untrusted telemetry, exactly like
			 * the `recipient` on `email.delivered` — it is acted on because the
			 * SIGNED callback said so and the adapter minted a {@link suppression}
			 * from it, never because the field was present.
			 */
			recipient?: string;
			/**
			 * The recipient consequence the PROVIDER'S OWN policy attached to this
			 * terminal failure, when it attached one.
			 *
			 * A relay refusing an address off its own suppression list reports one
			 * fact that carries two: the send is over (the lifecycle half, which
			 * every provider's failure shares) and the address is refused (the
			 * policy half, which only some providers have). The ADAPTER that knows
			 * the vendor mints this field out of the vendor's own reason code; the
			 * generic handler applies it, suppression first and bookkeeping second.
			 *
			 * Absent means "this failure says nothing about the recipient", which is
			 * the reading every failure gets unless its adapter says otherwise — so
			 * a new provider's suppression policy is data on this field, not a
			 * branch in the dispatch table. A failure naming no `recipient`
			 * suppresses nobody either.
			 */
			suppression?: ProviderSuppression;
	  }
	| {
			// Transient RELAY-side deferral (Mandrill `deferral`, plan D10). The
			// receiver 4xx'd AFTER the relay accepted the message for delivery, so
			// the Send's own status is not in question — the relay keeps retrying —
			// and the only thing this event moves is the (cell, arm) `deferred`
			// transport-outcome counter that ramp gate 2 divides.
			kind: 'email.deferred';
			providerMessageId: string;
			at: number;
			providerType?: string;
			/** Provider free text (Mandrill `msg.diag`), for operator logs only. */
			reason?: string;
	  }
	| {
			// The recipient left through the RELAY's own unsubscribe surface
			// (Mandrill `unsub`, plan D10). It carries an ADDRESS and not a Send:
			// the dispatcher joins it to a Contact and replays the ordinary public
			// one-click unsubscribe, so relay-side and first-party departures reach
			// the same membership delete, the same campaign counter and the same
			// `unsubscribed` transport outcome.
			kind: 'email.unsubscribed';
			recipient: string;
			at: number;
			providerMessageId?: string;
			providerType?: string;
	  }
	| {
			// A signed provider callback reported a recipient-specific suppression.
			// The reason is a closed host vocabulary; account/sender failures cannot
			// reach this event and therefore cannot suppress an address.
			kind: 'email.provider_suppressed';
			recipient: string;
			at: number;
			reason: ProviderSuppressionReason;
			/** The provider's own reason code; the host derives one when absent. */
			evidence?: string;
			providerMessageId?: string;
			providerType: string;
	  }
	| {
			kind: 'email.bounced';
			providerMessageId: string;
			at: number;
			bounceType: 'hard' | 'soft';
			bounceMessage?: string;
			providerType?: string;
			deliveryDomain?: DeliveryDomain;
	  }
	| {
			kind: 'email.complained';
			at: number;
			/** Set when the complaint attributes to a known send by Message-ID. */
			providerMessageId?: string;
			/**
			 * Set when the complaint carries only a recipient address (RFC 5965
			 * §3.2) and no recoverable Message-ID — e.g. Gmail FBL redaction.
			 * The dispatcher suppresses this email by address so a redacted
			 * complaint still lands the recipient on the blocklist.
			 */
			recipient?: string;
			providerType?: string;
			deliveryDomain?: DeliveryDomain;
			/**
			 * RFC 5965 `Reported-Domain` — OUR sending/DKIM domain the complaint was
			 * filed against — and the feedback-loop source ISP the MTA's ARF
			 * processor resolved. Both optional; most ISPs omit at least one.
			 * Together they keep a DKIM-domain-based FBL enrollment marked live.
			 *
			 * `sourceIsp` is the shipped destination-provider union, not a free
			 * string, so the dispatcher's yahoo branch compares against a checked
			 * constant instead of a magic literal.
			 */
			reportedDomain?: string;
			sourceIsp?: DestinationProviderKey;
	  }
	| {
			kind: 'email.opened';
			providerMessageId: string;
			at: number;
			ip?: string;
			userAgent?: string;
	  }
	| {
			kind: 'email.clicked';
			providerMessageId: string;
			at: number;
			url: string;
			ip?: string;
			userAgent?: string;
	  }
	| { kind: 'inbound.received'; mail: NormalizedInboundMail }
	| {
			kind: 'channel.received';
			channel: ChannelKind;
			from: string;
			content: ChannelContent;
			externalMessageId?: string;
			metadata?: Record<string, string | undefined>;
	  }
	| {
			kind: 'internal.circuit_breaker_tripped';
			message: string;
			bounceRate?: number;
	  }
	| {
			kind: 'internal.campaign_complaint_rate';
			eventId: string;
			message: string;
			campaignId: string;
			complaintRate: number;
			at: number;
	  }
	| {
			kind: 'internal.ip_event';
			subkind: 'blocklisted' | 'delisted' | 'warming_complete' | 'all_blocked';
			ip?: string;
			blocklists?: string[];
			severity?: 'info' | 'warning' | 'critical';
			message?: string;
	  }
	/**
	 * ONE classified 4xx/5xx response, for MEASUREMENT ONLY. It moves no send
	 * status, suppresses nobody and penalises no reputation — the dispatcher routes
	 * it to a counter and stops there (issue #501). The cell and the arm are NOT on
	 * the wire: the MTA knows neither, so they are resolved from the send's
	 * `sendAssignments` row by the same join every other transport outcome uses.
	 */
	| {
			kind: 'internal.smtp_classified';
			providerMessageId: string;
			category: SmtpFailureCategory;
			observedAt: number;
	  }
	| {
			kind: 'internal.ip_readiness_regressed';
			eventId: string;
			ip: string;
			readinessCheck: 'fcrdns' | 'spf';
			readinessReason: string;
			eligibilityGeneration: number;
			observedAt: number;
			message: string;
	  }
	| {
			kind: 'internal.deliverability_probe_observed';
			token: string;
			spf: 'pass' | 'fail' | 'unknown';
			dkim: 'pass' | 'fail' | 'unknown';
			dmarc: 'pass' | 'fail' | 'unknown';
			dkimSelector?: string;
			tlsVersion: string;
			sendingIp: string;
			ptr: string;
	  }
	| {
			kind: 'internal.routing_reentry';
			providerMessageId: string;
			token: string;
			workAttemptId: string;
			envelopeInput: WorkerEnvelopeInput;
			retryState: WorkerRetryState;
			reason: 'routing_lease_stale' | 'circuit_breaker_changed' | 'warming_capacity_changed';
	  }
	| {
			kind: 'internal.postmaster_authorize_domain';
			domain: string;
	  }
	| {
			kind: 'internal.postmaster_stats';
			domain: string;
			date: string;
			userReportedSpamRatio: number;
			// Google withholds a metric on days a domain had too little traffic,
			// so every widened v2 field is optional by design.
			spfSuccessRatio?: number;
			dkimSuccessRatio?: number;
			dmarcSuccessRatio?: number;
			deliveryErrorRatio?: number;
			deliveryErrors?: PostmasterDeliveryError[];
			fetchedAt: number;
	  }
	| {
			// The v2 Compliance Status verdict for one domain/day. Additive-only:
			// an operator with no Google account simply never produces one.
			kind: 'internal.postmaster_compliance';
			domain: string;
			date: string;
			checks: PostmasterComplianceCheck[];
			fetchedAt: number;
	  }
	| {
			// MTA→Convex DKIM rotation callback (RFC 6376 §3.6.1). `phase` mirrors
			// the publish-then-switch overlap workflow: `'pending'` adds the new
			// selector's record alongside the active one, `'activated'` retires the
			// old one. Lands via `domains.lifecycle.recordDkimRotation`.
			kind: 'internal.dkim_rotated';
			domain: string;
			selector: string;
			dnsRecord: string;
			phase: 'pending' | 'activated';
	  }
	| {
			// Amazon SNS one-time subscription handshake for the SES feedback
			// topic. SNS POSTs a `SubscriptionConfirmation` whose `SubscribeURL`
			// must be GET-ed to activate the HTTPS subscription. The adapter has
			// no network/ctx, so it emits this event and the dispatcher performs
			// the (host-pinned) confirm fetch. `subscribeUrl` is already pinned to
			// an SNS host by the adapter before this event is produced.
			kind: 'internal.sns_subscription_confirm';
			subscribeUrl: string;
	  };

export type InboundEventKind = InboundEvent['kind'];

/** The five optional Postmaster metrics that always travel together. */
export interface PostmasterStatsMetrics {
	spfSuccessRatio?: number;
	dkimSuccessRatio?: number;
	dmarcSuccessRatio?: number;
	deliveryErrorRatio?: number;
	deliveryErrors?: PostmasterDeliveryError[];
}

/**
 * Carry only the widened Postmaster metrics Google actually reported.
 *
 * Google withholds a metric on a day a domain had too little traffic, and an
 * absent metric must stay absent rather than become an explicit `undefined`
 * that a Convex validator would reject. One definition, used by the adapter
 * that reads the wire event and by the dispatcher that calls the ingest.
 */
export function postmasterStatsMetrics(source: PostmasterStatsMetrics): PostmasterStatsMetrics {
	return {
		...(source.spfSuccessRatio !== undefined ? { spfSuccessRatio: source.spfSuccessRatio } : {}),
		...(source.dkimSuccessRatio !== undefined ? { dkimSuccessRatio: source.dkimSuccessRatio } : {}),
		...(source.dmarcSuccessRatio !== undefined
			? { dmarcSuccessRatio: source.dmarcSuccessRatio }
			: {}),
		...(source.deliveryErrorRatio !== undefined
			? { deliveryErrorRatio: source.deliveryErrorRatio }
			: {}),
		...(source.deliveryErrors !== undefined ? { deliveryErrors: source.deliveryErrors } : {}),
	};
}

export type InboundEventOf<K extends InboundEventKind> = Extract<InboundEvent, { kind: K }>;

// ─── Outbound side ─────────────────────────────────────────────────────────

/**
 * Per-event module owning the customer-facing payload contract for one
 * Webhook event. See CONTEXT.md "Webhook event module".
 *
 * `build` is pure — no ctx, no await. Callers (sendLifecycle, contacts,
 * topics) pre-resolve domain data and pass it in.
 */
export interface WebhookEventModule<L extends string, TInput, TData> {
	readonly literal: L;
	readonly description: string;
	readonly isSubscribable: boolean;
	readonly schema: Validator<TData, 'required', string>;
	build(input: TInput): TData;
}
