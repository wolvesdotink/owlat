import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { unifiedMessageChannelValidator } from '../lib/convexValidators';

/**
 * Multi-channel messaging tables — unified inbox for all channels + per-channel config.
 *
 * Spread into `defineSchema()` from schema.ts via `...messagingTables`.
 */
export const messagingTables = {
	// Unified Messages - all messages across all channels in a single table
	unifiedMessages: defineTable({
		threadId: v.id('conversationThreads'),
		channel: unifiedMessageChannelValidator,
		direction: v.union(v.literal('inbound'), v.literal('outbound')),
		// Sender/recipient
		contactId: v.optional(v.id('contacts')),
		memberId: v.optional(v.string()), // Internal sender (BetterAuth user ID)
		// Message content (JSON: { text, html, subject, mediaUrl })
		content: v.string(),
		// Schema version for `content` JSON blob; bump on shape change to allow migration.
		contentVersion: v.optional(v.number()),
		// Storage encoding version, independent from the JSON schema above:
		// 1 = legacy plaintext JSON, 2 = authenticated at-rest envelope.
		contentStorageVersion: v.optional(v.number()),
		// External provider message ID
		externalMessageId: v.optional(v.string()),
		// Delivery status
		status: v.union(
			v.literal('received'),
			v.literal('queued'),
			v.literal('sent'),
			v.literal('delivered'),
			v.literal('read'),
			v.literal('failed')
		),
		// Channel-specific metadata (JSON)
		metadata: v.optional(v.string()),
		createdAt: v.number(),
	})
		.index('by_thread', ['threadId'])
		.index('by_channel', ['channel'])
		.index('by_contact', ['contactId'])
		// Per-contact reverse-chronological browse — backs the contact timeline's
		// keyset pagination (range `createdAt < beforeTimestamp` instead of fetching
		// the newest N and JS-filtering, which made older pages unreachable).
		.index('by_contact_and_created_at', ['contactId', 'createdAt'])
		.index('by_created_at', ['createdAt'])
		// Outbound delivery-status poller (channels.outbound.pollDeliveryStatus):
		// range-scans the `outbound`/`sent` partition newest-first (createdAt) to
		// pick the small recent tail of channel messages still awaiting a
		// delivered/read/failed transition, instead of scanning every row.
		.index('by_direction_status_and_created_at', ['direction', 'status', 'createdAt'])
		// Idempotency key for mirrored email rows: an inbound email's SMTP
		// Message-ID and an outbound agent reply's provider message id are unique
		// per (channel, direction), so re-delivery / onComplete retries can guard
		// against duplicate mirror rows. See unifiedMessages.recordInbound /
		// mirrorEmailSend.
		.index('by_external_message_id', ['externalMessageId']),

	// Channel Configs - per-channel configuration and credentials
	channelConfigs: defineTable({
		channel: unifiedMessageChannelValidator,
		isEnabled: v.boolean(),
		displayName: v.optional(v.string()),
		// Encrypted credentials (JSON string, encrypted at rest)
		config: v.optional(v.string()),
		// Health monitoring
		healthStatus: v.optional(
			v.union(v.literal('healthy'), v.literal('degraded'), v.literal('down'))
		),
		lastHealthCheckAt: v.optional(v.number()),
		lastSuccessfulSend: v.optional(v.number()),
		lastError: v.optional(v.string()),
		// Timestamps
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index('by_channel', ['channel']),
};
