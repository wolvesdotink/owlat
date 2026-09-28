import { v } from 'convex/values';
import { bounceTypeValidator } from '../literalValidators';

/**
 * Send vocabulary shared by the two per-recipient send tables, `emailSends`
 * (schema/campaigns.ts) and `transactionalSends` (schema/templates.ts).
 */

/** One tracked-link click on a send (`clickedLinks`). */
const linkClickValidator = v.object({
	url: v.string(),
	clickedAt: v.number(),
});

/**
 * The tracking columns both send tables carry. The Send lifecycle
 * (`delivery/sendLifecycle/`) writes the same patch to either table, so a column
 * it writes has to exist on both: add it here, never to one table only.
 *
 * Kept per table: `queuedAt` (required on campaign sends, optional on
 * transactional ones) and each kind's provenance columns (`seedTag`,
 * `attachmentStorageIds`, ...).
 */
export const sendTrackingFields = {
	// Timestamps for status changes. `sentAt` is optional because rows start
	// life in `queued` (ADR-0006); it is set when the send transitions to `sent`.
	sentAt: v.optional(v.number()),
	deliveredAt: v.optional(v.number()),
	failedAt: v.optional(v.number()),
	openedAt: v.optional(v.number()),
	clickedAt: v.optional(v.number()),
	bouncedAt: v.optional(v.number()),
	// Bounce classification; required-via-runtime-guard when status='bounced'.
	// See CONTEXT.md "Send status" — canonical encoding of bounce class.
	bounceType: v.optional(bounceTypeValidator),
	complainedAt: v.optional(v.number()),
	// When this send absorbed the recipient's unsubscribe. NOT a status — the
	// send itself succeeded — and NOT the contact's unsubscribe record either
	// (that is `contacts.unsubscribedAt` + the membership rows). It exists as
	// the per-send uniqueness gate for the `unsubscribed` transport outcome,
	// the same role `openedAt` plays for `opened`. On `transactionalSends` only
	// marketing (`kind: 'automation'`) rows can ever carry it:
	// transactional/agent/preview mail has no one-click header to answer. See
	// `delivery/unsubscribeOutcome.ts`.
	unsubscribedAt: v.optional(v.number()),
	// The UTC DAY this send last had a last-mile deferral counted against its
	// cell — the rate limiter for the `deferred` transport outcome, so a send
	// the router holds all afternoon contributes one event and not one per
	// re-entry. A day rather than an instant because the outcome buckets are
	// daily: still deferred tomorrow is tomorrow's evidence. Not a status; the
	// send stays `queued` throughout. Every governed send kind can carry it: the
	// last-mile router defers campaign, automation and transactional mail alike.
	// See `delivery/deferralOutcome.ts`.
	deferralCountedDay: v.optional(v.number()),
	// Link tracking for click attribution
	clickedLinks: v.optional(v.array(linkClickValidator)),
	// Open tracking count (may open multiple times)
	openCount: v.optional(v.number()),
	// Automated pixel fetches (Apple Mail Privacy Protection, security
	// scanners, arrival prefetch), kept apart from the reader opens above.
	// Only the count and the first one's time are kept, never the
	// User-Agent or IP they were judged on. See `delivery/automatedOpens.ts`.
	automatedOpenedAt: v.optional(v.number()),
	automatedOpenCount: v.optional(v.number()),
	// Tracked links followed by a security gateway or link scanner, kept
	// apart from clickedAt / clickedLinks. Only the count and the first
	// one's time are kept, never the User-Agent. See `delivery/automatedClicks.ts`.
	automatedClickedAt: v.optional(v.number()),
	automatedClickCount: v.optional(v.number()),
	// Error information for failures (e.g., from provider error responses)
	errorMessage: v.optional(v.string()),
	errorCode: v.optional(v.string()),
	// Provider routing metadata (multi-tenant sending platform).
	// Which provider sent this email: a `SendTransportKind` (`@owlat/shared`),
	// core or `plugin.<pluginId>.<localId>`, written POST-HOC from the dispatch
	// result. Stored open per ADR-0055 (D10); the kinds have one declaration,
	// which is the catalog, so they are deliberately not re-listed here.
	providerType: v.optional(v.string()),
	// Correlation ID for end-to-end traceability (API request → send → webhook)
	correlationId: v.optional(v.string()),
	// Soft-delete fields: set on cascade from a soft-deleted contact, so the
	// historical send record remains for audit but stops appearing in normal
	// queries.
	deletedAt: v.optional(v.number()),
	deletedBy: v.optional(v.string()),
};
