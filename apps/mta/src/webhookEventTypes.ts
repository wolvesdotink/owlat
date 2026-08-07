/**
 * The MTA -> Convex webhook EVENT payload types, AS THIS SERVICE PRODUCES THEM.
 *
 * The field set itself is not declared here any more: it lives once in
 * `@owlat/mta-protocol` (D7), which both ends of the wire import. What this
 * module still owns is the one thing that is genuinely local — the SHAPE of the
 * three nested blobs the MTA builds and Convex only re-parses (`inboundPayload`,
 * `mailboxPayload`, `routingReentry`). Binding them to this service's own parsed
 * types is what `MtaWebhookPayloads` is a parameter for.
 *
 * `types.ts` re-exports these so existing `from './types.js'` imports keep
 * working unchanged.
 */

import type {
	GooglePostmasterComplianceEvent as ProtocolGooglePostmasterComplianceEvent,
	GooglePostmasterDomainAuthorizationEvent as ProtocolGooglePostmasterDomainAuthorizationEvent,
	GooglePostmasterStatsEvent as ProtocolGooglePostmasterStatsEvent,
	GooglePostmasterWebhookEvent as ProtocolGooglePostmasterWebhookEvent,
	MtaRoutingReentry,
	MtaWebhookEventDraft,
	MtaWebhookPayloads,
} from '@owlat/mta-protocol';
import type { InboundEmailPayload, MailboxInboundPayload } from './types.js';

export type MtaWebhookEventType = import('@owlat/mta-protocol').MtaWebhookEventType;

/** This service's bindings for the wire's three producer-owned blobs. */
export interface MtaProducedPayloads extends MtaWebhookPayloads {
	inbound: InboundEmailPayload;
	mailbox: MailboxInboundPayload;
	routingReentry: MtaRoutingReentry;
}

/**
 * The producer's view of the wire event: every field optional, this service's
 * payload types. `isMtaWebhookEvent` (the same package) is what turns one of
 * these into a validated event at the Convex ingress — a draft is not proof.
 */
export type MtaWebhookEvent = MtaWebhookEventDraft<MtaProducedPayloads>;

export type GooglePostmasterStatsEvent = ProtocolGooglePostmasterStatsEvent<MtaProducedPayloads>;

export type GooglePostmasterComplianceEvent =
	ProtocolGooglePostmasterComplianceEvent<MtaProducedPayloads>;

export type GooglePostmasterDomainAuthorizationEvent =
	ProtocolGooglePostmasterDomainAuthorizationEvent<MtaProducedPayloads>;

export type GooglePostmasterWebhookEvent =
	ProtocolGooglePostmasterWebhookEvent<MtaProducedPayloads>;
