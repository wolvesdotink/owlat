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
 * ON THE ONE DEPENDENCY — recorded in full in
 * `docs/adr/0056-mta-protocol-package.md`. D7 asks for a zero-dependency leaf,
 * and this is a leaf — nothing in `packages/` imports it, only the two apps do
 * — but it does depend on `@owlat/shared`. That is deliberate: the wire is
 * STATED IN TERMS OF the shared vocabularies (`DeliveryDomain`,
 * `GovernedRoutingContext`, the destination-provider taxonomy D8 gives exactly
 * one declaration, the IP readiness verdicts), and a package that re-declared
 * any of them to buy literal zero-dependency status would trade one duplication
 * for a worse one.
 *
 * The dependency runs one way and one way only: nothing in `packages/` may
 * import this package. That is not left to good intentions — the
 * `@owlat/shared` direction is a cycle `bun install`, knip and `tsc` all accept
 * in silence, and any other `packages/` importer would not even cycle — so
 * `scripts/check-cross-package-imports.sh` asserts it over every workspace
 * manifest and source file on every `bun run lint`.
 *
 * Runtime imports here are taken from `@owlat/shared`'s SUBPATHS, never its
 * barrel: the barrel re-exports modules that pull `tldts` (~1MB of public-suffix
 * data), and the Convex bundle would carry it for the sake of one guard.
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
export { MTA_SEND_ERROR_CODES, isMtaSendErrorCode } from './send';

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
	isMtaRelayDecisionReason,
	mtaDeferReasonOrigin,
} from './routingDecision';

export type {
	GooglePostmasterComplianceEvent,
	GooglePostmasterDomainAuthorizationEvent,
	GooglePostmasterStatsEvent,
	GooglePostmasterWebhookEvent,
	MtaWebhookEventDraft,
	MtaWebhookEventFields,
	MtaWebhookEventType,
	MtaWebhookPayloads,
	PostmasterComplianceCheck,
	PostmasterDeliveryError,
	ValidatedMtaWebhookEvent,
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
