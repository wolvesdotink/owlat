import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { webhookPayloadValidator } from '../lib/convexValidators';
import { webhookEventValidator, subscribableWebhookEventValidator } from '../webhooks/events';

/**
 * Webhook tables — outbound notifications + delivery log + raw inbound payloads.
 *
 * Spread into `defineSchema()` from schema.ts via `...webhookTables`.
 *
 * Event literals come from `../webhooks/events`. Adding a new event is a
 * one-place change in that catalog — the schema validators, the
 * lib/validators re-export, and the endpoints.ts mutation args all derive
 * from it.
 */
export const webhookTables = {
	// Webhooks - notify external systems about events
	webhooks: defineTable({
		name: v.string(), // User-friendly name for the webhook
		url: v.string(), // The URL to send webhook notifications to
		// Events to subscribe to — subscribable subset (excludes `test`).
		events: v.array(subscribableWebhookEventValidator),
		// Secret for HMAC signature verification
		secret: v.string(),
		// Whether the webhook is active
		isActive: v.boolean(),
		// Marks rows inserted by /seed/demo so they can be wiped on reset.
		seedTag: v.optional(v.string()),
		// Timestamps
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_active', ['isActive']),

	// Webhook Delivery Logs - tracks webhook delivery attempts for debugging
	webhookDeliveryLogs: defineTable({
		webhookId: v.id('webhooks'),
		// Event — includes `test` for dashboard test fires.
		event: webhookEventValidator,
		// Payload that was sent — typed shape; see docs/webhook-payloads.md for per-event variants.
		payload: webhookPayloadValidator,
		// Webhook contract version for this payload; bumping is a breaking change for receivers.
		payloadVersion: v.optional(v.number()),
		// Delivery attempt information
		attemptNumber: v.number(), // 1, 2, or 3
		maxAttempts: v.number(), // Total attempts allowed (typically 3)
		// Delivery status
		status: v.union(
			v.literal('pending'),
			v.literal('success'),
			v.literal('failed'),
			v.literal('retrying')
		),
		// HTTP response details
		httpStatusCode: v.optional(v.number()),
		responseBody: v.optional(v.string()), // Truncated if too long
		// Error information
		errorMessage: v.optional(v.string()),
		// Timing
		scheduledAt: v.number(), // When delivery was scheduled
		attemptedAt: v.optional(v.number()), // When delivery was attempted
		nextRetryAt: v.optional(v.number()), // When next retry is scheduled
		completedAt: v.optional(v.number()), // When delivery completed (success or final failure)
		// Duration of the request in milliseconds
		durationMs: v.optional(v.number()),
	})
		.index('by_webhook', ['webhookId'])
		// Delivery-stats reads one webhook's logs over a recent window; the
		// compound index range-scans that window instead of collecting every
		// log the webhook ever produced and filtering in memory.
		.index('by_webhook_and_scheduled_at', ['webhookId', 'scheduledAt'])
		.index('by_status', ['status'])
		.index('by_webhook_and_status', ['webhookId', 'status'])
		// Retention cleanup range-scans one status for rows older than a cutoff;
		// the compound index seeks straight to the old tail instead of scanning
		// every row of that status.
		.index('by_status_and_completed_at', ['status', 'completedAt'])
		.index('by_event', ['event']),

	// Webhook Payloads - raw webhook payloads for audit and dispute resolution
	webhookPayloads: defineTable({
		source: v.string(), // 'resend' | 'mta' | 'ses'
		rawPayload: v.string(), // JSON string of the raw webhook body
		receivedAt: v.number(),
	})
		.index('by_received_at', ['receivedAt'])
		// Newest payload for one provider — powers the Delivery page's live
		// "last SES event received" line without scanning every source's rows.
		.index('by_source_and_received_at', ['source', 'receivedAt']),

	// Transactional idempotency receipts for MTA campaign complaint alerts.
	// The producer can retry after a lost HTTP response for up to its durable
	// marker horizon; retaining the immutable alert projection lets the API
	// distinguish a truthful replay from an event-id collision without writing
	// a second abuse-status audit row.
	mtaCampaignAlertReceipts: defineTable({
		eventId: v.string(),
		campaignId: v.string(),
		message: v.string(),
		complaintRate: v.number(),
		eventTimestamp: v.number(),
		processedAt: v.number(),
		expiresAt: v.number(),
		transitionApplied: v.union(v.literal('transitioned'), v.literal('recorded')),
	})
		.index('by_event_id', ['eventId'])
		.index('by_expires_at', ['expiresAt']),
};
