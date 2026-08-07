/**
 * The Convex -> MTA send-intake wire (D7).
 *
 * One body shape serves all three intake routes — `/send` (governed tenant
 * mail), `/send/postbox` (personal mailbox) and `/send/system` (auth mail).
 * They differ in WHICH fields they require and refuse, not in the shape, and
 * the handler's `mode` parameter is what enforces that; so this is one
 * declaration with the per-mode rules stated on the fields.
 *
 * Until now it was declared twice and typed on neither side of the wire: a
 * private `interface SendRequest` in `apps/mta/src/routes/send.ts`, and an
 * inline object literal in `apps/api/convex/lib/sendProviders/mta/index.ts`
 * whose only contract with it was that both had been edited by the same hand.
 */

import type { DeliveryDomain, GovernedIpPool, GovernedMessageType } from '@owlat/shared';

/**
 * The callback material a bounded routing attempt carries, whose canonical
 * digest is authenticated by `routingReentryToken`.
 *
 * Carried, never re-derived: `retryState` must stay byte-identical to the
 * snapshot Convex issued or the callback digest stops matching. That is also
 * why it travels back out unchanged on the `routing.reentry` webhook event.
 */
export interface MtaRoutingReentry {
	envelopeInput: unknown;
	retryState: {
		attempt: number;
		startedAt: number;
		idempotencyKey: string;
		workAttemptId?: string;
		acceptanceReconciliation?: boolean;
	};
}

/** The POST body of `/send`, `/send/postbox` and `/send/system`. */
export interface MtaSendRequest {
	messageId: string;
	workAttemptId?: string;
	routingReentryToken?: string;
	routingReentry?: MtaRoutingReentry;
	to: string;
	from: string;
	subject: string;
	html: string;
	text?: string;
	/** Postbox-only complete PGP/MIME bytes, base64-encoded. */
	sealedMimeBase64?: string;
	/** AMP4Email body — delivered as a `text/x-amp-html` alternative part. */
	amp?: string;
	replyTo?: string;
	headers?: Record<string, string>;
	ipPool: GovernedIpPool;
	organizationId: string;
	messageType?: GovernedMessageType;
	deliveryDomain?: DeliveryDomain;
	/**
	 * Unvalidated JSON — the MTA reads it through `readEngagementScore`, never
	 * raw. Typed `unknown` ON THE WIRE on purpose: a producer that sends garbage
	 * must be rejected by the reader, not trusted by the type.
	 */
	engagementScore?: unknown;
	dkimDomain: string;
	/**
	 * Postbox-only: the allowed-from set for the originating mailbox.
	 * Convex computes this at dispatch time (`resolveAllowedFromAddresses`)
	 * and passes it in so the MTA can refuse forged-From requests without
	 * a Convex round-trip. Lowercase canonical addresses.
	 *
	 * Shared-inbox send-as (a teammate replying under their own personal
	 * identity) is covered automatically: Convex keys this set on the SENDING
	 * mailbox, so the sanctioned cross-mailbox identity is already present here
	 * and every other address stays blocked. No MTA-side special-casing needed.
	 */
	allowedFromAddresses?: string[];
	/** Opaque lease token returned by POST /send/decision. */
	routingLease?: string;
	allowWarmupOverflow?: boolean;
}

/**
 * The body as a PRODUCER holds it, before the intake has judged it.
 *
 * Exactly one field differs. `organizationId` is required ON THE WIRE — the
 * intake refuses a request without it and scopes the presented credential by it
 * — but Convex's dispatch adapter carries it in per-send extras, which are
 * optional on the module contract. Minting a placeholder to satisfy the type
 * would put a byte on the wire the MTA has never seen; admitting the gap here
 * leaves the intake's own check the thing that decides, which is where that
 * decision has always lived.
 */
export type MtaSendRequestDraft = Omit<MtaSendRequest, 'organizationId'> & {
	organizationId?: string;
};

/**
 * Every machine-readable code the intake attaches to a refusal.
 *
 * The MTA answers these beside a human-readable `error`; Convex's adapter reads
 * `INTAKE_PENDING` off the 409 body to decide the attempt's acceptance is
 * UNKNOWN rather than failed, and classifies the routing codes as a deferral
 * that must resolve a fresh decision.
 */
export const MTA_SEND_ERROR_CODES = [
	'ROUTING_LEASE_REQUIRED',
	'ROUTING_DECISION_EXPIRED',
	'ROUTING_DECISION_CHANGED',
	'GLOBAL_SAFETY_DEFER',
	'INTAKE_PENDING',
] as const;

export type MtaSendErrorCode = (typeof MTA_SEND_ERROR_CODES)[number];

/**
 * The accepted answer. `id` is the caller's own `messageId` echoed back — the
 * stable provider/VERP correlation id — never the queue identity, which is
 * attempt-scoped and returned separately as `workAttemptId`. `deduplicated`
 * marks an attempt whose durable intake receipt was already accepted.
 */
export interface MtaSendAccepted {
	success: true;
	id: string;
	workAttemptId?: string;
	deduplicated?: boolean;
}

/** The refused answer, on every non-2xx status the intake returns. */
export interface MtaSendRefused {
	error: string;
	code?: MtaSendErrorCode;
	retryAfterMs?: number;
}

export type MtaSendResponse = MtaSendAccepted | MtaSendRefused;
