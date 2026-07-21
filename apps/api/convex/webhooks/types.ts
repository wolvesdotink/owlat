/**
 * Shared types for the inbound webhook pipeline and the outbound webhook
 * event modules. See ADR-0003 + ADR-0005 for the design and CONTEXT.md for
 * the vocabulary (Inbound event, Webhook event module).
 */

import type { Validator } from 'convex/values';
import type { InboundEmailMessage } from '@owlat/channels';

// ─── Inbound side ──────────────────────────────────────────────────────────

/** Normalized inbound mail shape — canonical type from @owlat/channels. */
export type NormalizedInboundMail = InboundEmailMessage;

/** Provider-agnostic discriminator for non-email customer channels. */
export type ChannelKind = 'sms' | 'whatsapp' | 'generic';

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
			destinationProvider?: 'gmail' | 'microsoft' | 'yahoo' | 'apple' | 'other';
			primarySendingDomain?: string;
	  }
	| {
			kind: 'email.delivered';
			providerMessageId: string;
			at: number;
			destinationProvider?: 'gmail' | 'microsoft' | 'yahoo' | 'apple' | 'other';
			primarySendingDomain?: string;
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
	  }
	| {
			kind: 'email.bounced';
			providerMessageId: string;
			at: number;
			bounceType: 'hard' | 'soft';
			bounceMessage?: string;
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
			message: string;
			campaignId?: string;
			complaintRate?: number;
	  }
	| {
			kind: 'internal.ip_event';
			subkind: 'blocklisted' | 'delisted' | 'warming_complete' | 'all_blocked';
			ip?: string;
			blocklists?: string[];
			severity?: 'info' | 'warning' | 'critical';
			message?: string;
	  }
	| {
			kind: 'internal.postmaster_stats';
			domain: string;
			date: string;
			userReportedSpamRatio: number;
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
