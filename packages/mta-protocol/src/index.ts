/**
 * `@owlat/mta-protocol` — the Convex <-> MTA wire contract (D7).
 *
 * Four conversations, each declared exactly once here and imported by BOTH
 * ends: the send intake (`send.ts`), the last-mile routing decision
 * (`routingDecision.ts`), the IP-reputation snapshot (`ipReputation.ts`) and
 * the webhook events the MTA reports outcomes with (`webhookEvent.ts`).
 *
 * Types and pure validators only — no I/O, no third-party dependencies, and no
 * app imports in either direction. This package does NOT merge the two routing
 * brains (Convex governance vs. the MTA's breakers/pools/leases); it makes
 * their conversation impossible to drift.
 *
 * ON THE ONE DEPENDENCY. D7 asks for a zero-dependency leaf, and this is a leaf
 * — nothing in `packages/` imports it, only the two apps do — but it does
 * depend on `@owlat/shared`. That is deliberate: the wire is STATED IN TERMS OF
 * the shared vocabularies (`DeliveryDomain`, `GovernedRoutingContext`, the
 * destination-provider taxonomy D8 gives exactly one declaration, the IP
 * readiness verdicts), and a package that re-declared any of them to buy
 * literal zero-dependency status would trade one duplication for a worse one.
 * The dependency runs one way and one way only: `@owlat/shared` must never
 * import this package.
 */

export type {
	MtaRoutingReentry,
	MtaSendAccepted,
	MtaSendErrorCode,
	MtaSendRefused,
	MtaSendRequest,
	MtaSendRequestDraft,
	MtaSendResponse,
} from './send';
export { MTA_SEND_ERROR_CODES } from './send';

export type {
	MtaDeferOrigin,
	MtaDeferReason,
	MtaRelayDecisionReason,
	MtaRoutingDecision,
	MtaRoutingDecisionRequest,
	MtaRoutingDecisionResponse,
	MtaRoutingLeaseGrant,
} from './routingDecision';
export {
	MTA_DEFER_REASON_ORIGIN,
	MTA_RELAY_ALLOWED_REASON,
	MTA_RELAY_DECISION_REASONS,
	mtaDeferReasonOrigin,
} from './routingDecision';

export type {
	GooglePostmasterComplianceEvent,
	GooglePostmasterDomainAuthorizationEvent,
	GooglePostmasterStatsEvent,
	GooglePostmasterWebhookEvent,
	MtaWebhookEvent,
	MtaWebhookEventDraft,
	MtaWebhookEventFields,
	MtaWebhookEventType,
	MtaWebhookPayloads,
	PostmasterComplianceCheck,
	PostmasterDeliveryError,
} from './webhookEvent';
export {
	MTA_WEBHOOK_EVENT_TYPES,
	MTA_WEBHOOK_MESSAGE_MAX_LENGTH,
	POSTMASTER_MAX_COMPLIANCE_CHECKS,
	POSTMASTER_MAX_DELIVERY_ERROR_CATEGORIES,
	POSTMASTER_TOKEN,
	isMtaWebhookEvent,
	isMtaWebhookEventType,
} from './webhookEvent';

export type { MtaIpReputationPayload } from './ipReputation';
export { normalizeIpReputationPayload } from './ipReputation';
