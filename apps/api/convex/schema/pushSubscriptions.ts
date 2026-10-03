import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Web Push device subscriptions (push/).
 *
 * One row per browser profile or installed PWA that turned notifications on in
 * Preferences → This device. `endpoint` plus the two keys are what the browser's
 * `PushSubscription` reports; together they are a capability to show this
 * person a notification, so no query ever returns `p256dh` or `auth`, and the
 * endpoint is only compared, never listed.
 *
 * Lifecycle: written by `push/subscriptions.subscribe` (an endpoint already on
 * file moves to the new owner — a shared browser profile belongs to whoever
 * enabled it last), deleted by the user, by the sender when the push service
 * answers 404/410, by member erasure and by workspace deletion. Account export
 * includes the device label and timestamps, never the endpoint or keys.
 *
 * Spread into `defineSchema()` from schema.ts via `...pushSubscriptionTables`.
 */
export const pushSubscriptionTables = {
	pushSubscriptions: defineTable({
		// BetterAuth user id of the person the device notifies.
		userId: v.string(),
		// The push service URL the browser handed out (https, bounded length).
		endpoint: v.string(),
		// The browser's ECDH public key (uncompressed P-256 point, base64url).
		p256dh: v.string(),
		// The browser's 16-byte auth secret, base64url.
		auth: v.string(),
		// "Chrome on macOS" — derived in the browser from its user agent, so the
		// device list can tell the rows apart. Never the raw user-agent string.
		label: v.string(),
		// The device's IANA time zone, so quiet hours (local minutes) are
		// evaluated on the clock the person is actually looking at. Absent ⇒ UTC.
		timeZone: v.optional(v.string()),
		createdAt: v.number(),
		// When a push service last accepted a message for this device.
		lastSuccessAt: v.optional(v.number()),
		// Notifications quiet hours held back on this device since the window
		// opened, rolled into one summary when it closes. Absent ⇒ none.
		quietDeferredCount: v.optional(v.number()),
		// When that summary is scheduled to go out. Absent ⇒ nothing scheduled.
		quietSummaryAt: v.optional(v.number()),
	})
		.index('by_user', ['userId'])
		.index('by_endpoint', ['endpoint']),
};
