import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import { activityMetadataValidator, segmentFiltersValidator } from '../lib/convexValidators';
import { contactActivityTypeValidator } from '../contactActivities/catalog';

/**
 * Contact tables — CRM contacts + custom properties + activity timeline + relationships + segments.
 *
 * Spread into `defineSchema()` from schema.ts via `...contactTables`.
 */
export const contactTables = {
	// Contacts table - email marketing contacts belonging to organizations
	// DOI (double opt-in) is tracked at the contact level, not per-topic
	//
	// Cascade on permanent delete (after the soft-delete retention window):
	// - contactTopics, contactPropertyValues, contactActivities,
	//   contactIdentities, contactRelationships (both from & to),
	//   automationRuns (required FK, per-contact)                 → deleted
	// - emailSends, transactionalSends                            → soft-deleted
	//   (deletedAt set, FK kept; row retained for audit)
	// - unifiedMessages, formSubmissions, inboundMessages,
	//   conversationThreads                                       → FK cleared
	//   (optional FK set undefined; row survives unlinked).
	// See lib/contactMutations.ts.
	contacts: defineTable({
		// Optional because Contacts can arrive via non-email channels
		// (SMS/WhatsApp/phone/generic) and have no email signal at all.
		// When present, this is denormalized from the primary email-channel
		// `contactIdentities` row — `Contact resolution (module)` is the only
		// writer at create time. Lookup-by-identifier always goes through
		// `contactIdentities.by_identifier`, never `contacts.by_email`.
		email: v.optional(v.string()),
		firstName: v.optional(v.string()),
		lastName: v.optional(v.string()),
		source: v.union(
			v.literal('api'),
			v.literal('import'),
			v.literal('form'),
			v.literal('transactional'),
			v.literal('inbound')
		),
		// Timezone for scheduling emails in recipient's local time (e.g., "America/New_York")
		timezone: v.optional(v.string()),
		// Preferred language for email content (e.g., "en", "de", "fr")
		language: v.optional(v.string()),
		// Denormalized search field: "email firstname lastname" for full-text search
		searchableText: v.optional(v.string()),
		// Denormalized email-engagement flags, set monotonically by the contact
		// activity writer (`contactActivities/writer.ts`) on the first
		// `email_opened` / `email_clicked` activity. Segment + automation
		// `email_activity` conditions read these booleans off the already-loaded
		// contact row instead of scanning the unbounded `contactActivities` table
		// (the old preload `.take(50000)`'d it, silently dropping contacts past
		// row 50k). Absent (undefined) means "never" → false.
		hasOpened: v.optional(v.boolean()),
		hasClicked: v.optional(v.boolean()),
		// Running count of consecutive SOFT bounces (RFC 3463 4.x.x transient
		// failures, e.g. 5.2.2 mailbox-full) recorded against this recipient by
		// the **Send lifecycle (module)**. A soft bounce alone is not terminal —
		// the address may recover — but a chronically-4xx address must eventually
		// be suppressed (ESP "suppress-after-N-soft" practice). The lifecycle
		// increments this on every soft bounce, escalates to the blocklist once
		// it reaches `SOFT_BOUNCE_SUPPRESSION_THRESHOLD`, and resets it to 0 on
		// the next `delivered`. Absent (undefined) means 0.
		softBounceCount: v.optional(v.number()),
		// Contact-level double opt-in status. Non-optional per ADR-0009 —
		// the Contact resolution (module) writes 'not_required' at create
		// time so undefined never appears in new rows. The DOI lifecycle
		// (module) is the only later writer.
		doiStatus: v.union(v.literal('not_required'), v.literal('pending'), v.literal('confirmed')),
		doiConfirmationToken: v.optional(v.string()),
		doiTokenExpiresAt: v.optional(v.number()),
		doiConfirmedAt: v.optional(v.number()),
		// Global marketing opt-out. Set when the Contact unsubscribes from ALL
		// topics at once (the public unsubscribe link / preference-center
		// "unsubscribe from everything") via `unsubscribeAllForContact` with no
		// `topicId`. Unlike topic membership (which segments ignore), this is a
		// contact-level signal the Audience resolution (module) consults so a
		// globally-unsubscribed Contact is never re-targeted by a matching
		// segment campaign (CAN-SPAM/GDPR). Marketing-only — it does NOT block
		// transactional sends the recipient explicitly requested; the
		// `blockedEmails` suppression list remains the boundary for those.
		// Cleared back to undefined when the Contact resubscribes to any topic.
		unsubscribedAt: v.optional(v.number()),
		// Source label populated when `doiStatus: 'confirmed'` was driven by the
		// **Contact import (module)** admin-attest path (e.g. 'mailchimp',
		// 'klaviyo', 'stripe', 'csv_admin'). Undefined on the token-keyed
		// confirm path. See ADR-0019.
		doiAttestedSource: v.optional(v.string()),
		// Soft-delete fields: when set, the row is considered deleted from the user's POV.
		// All list/lookup queries MUST filter `deletedAt === undefined`. A daily cron
		// permanently cascades to children after the 30-day retention window.
		deletedAt: v.optional(v.number()),
		deletedBy: v.optional(v.string()), // BetterAuth user id, or 'system' for automatic
		// Marks rows inserted by /seed/demo so they can be wiped on reset.
		seedTag: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_email', ['email'])
		.index('by_created_at', ['createdAt'])
		.index('by_doi_confirmation_token', ['doiConfirmationToken'])
		.index('by_deleted_at', ['deletedAt'])
		// Soft-delete browse index for the Listing engine (ADR-0037): deletedAt
		// leads so `deletedAt === undefined` rides the index range and createdAt
		// orders within it — the page is never thinned by a post-filter.
		.index('by_deleted_at_and_created_at', ['deletedAt', 'createdAt'])
		// SEALED-AT-REST NOTE (Sealed Mail E8b): `searchableText` here indexes contact
		// METADATA (name, email, company), not a sealed message body, so E8b at-rest
		// body sealing does not apply to it — it is intentionally plaintext for search.
		// See lib/atRestBodies.ts and apps/docs/content/3.developer/21.sealed-mail-at-rest.md.
		.searchIndex('search_contacts', {
			searchField: 'searchableText',
			// deletedAt is a filterField so the search path can drop soft-deleted
			// rows inside the index instead of post-filtering (ADR-0037).
			filterFields: ['deletedAt'],
		}),

	// Contact Properties - custom fields that organizations can define for their contacts
	contactProperties: defineTable({
		key: v.string(), // Internal key (e.g., "company", "phone_number")
		label: v.string(), // Display label (e.g., "Company", "Phone Number")
		type: v.union(
			v.literal('string'),
			v.literal('number'),
			v.literal('boolean'),
			v.literal('date')
		),
		// True when the row was inserted by the **Contact import (module)**'s
		// integration-driven property-key policy (Mailchimp `merge_fields`,
		// Stripe `metadata`). Operators can review + rename + delete these
		// rows from the contact-properties UI. See ADR-0019.
		autoRegistered: v.optional(v.boolean()),
		autoRegisteredSource: v.optional(v.string()),
		createdAt: v.number(),
	}).index('by_key', ['key']),

	// Contact Property Values - stores the actual values for custom properties per contact
	contactPropertyValues: defineTable({
		contactId: v.id('contacts'),
		propertyId: v.id('contactProperties'),
		value: v.string(), // Stored as string, parsed based on property type
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_contact', ['contactId'])
		.index('by_property', ['propertyId'])
		.index('by_contact_and_property', ['contactId', 'propertyId']),

	// Contact Activities - tracks all activities and events for contacts.
	// Used to display the activity timeline on contact detail pages.
	// Activity-type literals live in `contactActivities/catalog.ts` — adding
	// a new activity type is a one-place change.
	contactActivities: defineTable({
		contactId: v.id('contacts'),
		activityType: contactActivityTypeValidator,
		// Activity metadata with type-specific details
		// email_sent: { campaignId, emailSubject }
		// email_opened: { campaignId, emailSubject }
		// email_clicked: { campaignId, linkUrl }
		// email_bounced: { campaignId, bounceType, errorMessage }
		// email_complained: { campaignId }
		// topic_subscribed: { topicId, topicName }
		// topic_unsubscribed: { topicId, topicName }
		// topic_confirmed: { topicId, topicName }
		// property_updated: { propertyKey, oldValue, newValue }
		// created: { source }
		metadata: v.optional(activityMetadataValidator),
		// Timestamp when the activity occurred
		occurredAt: v.number(),
	})
		.index('by_contact', ['contactId'])
		.index('by_contact_and_type', ['contactId', 'activityType'])
		.index('by_contact_and_occurred_at', ['contactId', 'occurredAt']),

	// Segments - saved contact filter configurations for reuse in campaigns
	segments: defineTable({
		name: v.string(),
		description: v.optional(v.string()),
		// Filter configuration
		filters: segmentFiltersValidator,
		// Cached count of matching contacts (updated periodically)
		cachedCount: v.optional(v.number()),
		cachedCountUpdatedAt: v.optional(v.number()),
		// Timestamps
		createdAt: v.number(),
		updatedAt: v.number(),
	}),

	// Contact Identities - multi-channel identity for contact unification
	contactIdentities: defineTable({
		contactId: v.id('contacts'),
		channel: v.string(), // 'email', 'phone', 'whatsapp', 'twitter', etc.
		identifier: v.string(), // email address, phone number, handle
		isPrimary: v.boolean(),
		verifiedAt: v.optional(v.number()),
		// Marks rows inserted by /seed/demo so they can be wiped on reset.
		seedTag: v.optional(v.string()),
		createdAt: v.number(),
	})
		.index('by_contact', ['contactId'])
		.index('by_identifier', ['channel', 'identifier']),

	// Contact Relationships - relationship graph between contacts
	contactRelationships: defineTable({
		fromContactId: v.id('contacts'),
		toContactId: v.id('contacts'),
		relationship: v.string(), // "manager_of", "colleague", "reports_to", etc.
		confidence: v.number(), // 0-1
		// Relationships are authored by hand from the contact's Relationships tab.
		// Kept as a literal (not a bare string) so a future extraction source can
		// be added back as an explicit branch of a union.
		source: v.literal('manual'),
		createdAt: v.number(),
	})
		.index('by_from', ['fromContactId'])
		.index('by_to', ['toContactId']),
};
