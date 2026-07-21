import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	linkClickValidator,
	dataVariablesSchemaValidator,
	jsonPrimitiveRecord,
	emailTemplateTypeValidator,
} from '../lib/convexValidators';

/**
 * Email template + send tables — media assets, marketing/transactional templates,
 * reusable blocks, share links, and per-recipient transactional sends.
 *
 * Spread into `defineSchema()` from schema.ts via `...templateTables`.
 */
export const templateTables = {
	// Media Assets - persistent media library for uploaded images
	mediaAssets: defineTable({
		storageId: v.id('_storage'),
		filename: v.string(),
		mimeType: v.string(),
		fileSize: v.number(),
		width: v.optional(v.number()),
		height: v.optional(v.number()),
		url: v.string(),
		alt: v.optional(v.string()),
		tags: v.optional(v.array(v.string())),
		uploadedBy: v.string(),
		searchableText: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_created_at', ['createdAt'])
		.index('by_storage_id', ['storageId'])
		.searchIndex('search_media', {
			searchField: 'searchableText',
			filterFields: [],
		}),

	// Email Templates - reusable email designs for campaigns and transactional emails
	emailTemplates: defineTable({
		name: v.string(),
		subject: v.string(),
		previewText: v.optional(v.string()), // Preview text shown in inbox
		content: v.string(), // JSON string for editor state
		htmlContent: v.optional(v.string()), // Rendered HTML for sending
		type: emailTemplateTypeValidator,
		status: v.union(v.literal('draft'), v.literal('published')),
		publishedAt: v.optional(v.number()),
		// For transactional emails: whether to show unsubscribe link
		showUnsubscribe: v.optional(v.boolean()),
		// Multi-language support
		// Default language for this email (e.g., "en", "de", "fr")
		defaultLanguage: v.optional(v.string()),
		// Available translation language codes (e.g., ["en", "de", "fr"])
		supportedLanguages: v.optional(v.array(v.string())),
		// Translations keyed by language code (JSON string)
		// Structure: { "de": { "subject": "...", "previewText": "...", "blocks": {...} }, ... }
		// Default language content is stored in main subject/previewText/content fields
		translations: v.optional(v.string()),
		// Pre-rendered HTML translations keyed by language code (JSON string)
		// Structure: { "de": { "htmlContent": "...", "subject": "..." }, ... }
		// Published when template is published with translations
		htmlTranslations: v.optional(v.string()),
		// IDs of saved blocks currently linked in this template's content
		linkedBlockIds: v.optional(v.array(v.string())),
		// Denormalized search field: "name subject" for full-text search
		searchableText: v.optional(v.string()),
		// Schema version for `content` (EditorBlock[]). Bump on block shape change.
		contentBlockVersion: v.optional(v.number()),
		// Renderer engine version that produced `htmlContent`. Bump when rendering output changes materially.
		rendererVersion: v.optional(v.number()),
		// Saved-block rerender state. `stale: true` means `htmlContent` no
		// longer matches `content` because a linked saved block was edited;
		// the rerender pool clears it once the action succeeds. Per ADR-0023.
		htmlRenderState: v.optional(
			v.object({
				stale: v.boolean(),
				failureCount: v.optional(v.number()),
				lastFailureAt: v.optional(v.number()),
			})
		),
		// Marks rows inserted by /seed/demo so they can be wiped on reset.
		seedTag: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_type', ['type'])
		.index('by_status', ['status'])
		// Browse indexes for the Listing engine (ADR-0037): updatedAt is the
		// default browse order; the compound serves type-filtered browse
		// index-natively (type leads, updatedAt orders within it) instead of
		// `.collect()`-ing the whole table.
		.index('by_updated_at', ['updatedAt'])
		.index('by_type_and_updated_at', ['type', 'updatedAt'])
		.searchIndex('search_templates', {
			searchField: 'searchableText',
			filterFields: ['type', 'status'],
		}),

	// Email Blocks - reusable content blocks for email templates
	emailBlocks: defineTable({
		name: v.string(),
		description: v.optional(v.string()),
		content: v.string(), // JSON string for block content
		usageCount: v.number(), // Number of times this block has been used
		seedTag: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
	}),

	// Share Links - expiring preview links for email templates
	shareLinks: defineTable({
		// Polymorphic FK: targetType discriminates which of the two id fields is set.
		// Mutations MUST set targetType and enforce the xor invariant at write time.
		targetType: v.union(v.literal('emailTemplate'), v.literal('transactionalEmail')),
		emailTemplateId: v.optional(v.id('emailTemplates')),
		transactionalEmailId: v.optional(v.id('transactionalEmails')),
		token: v.string(), // nanoid(24)
		htmlContent: v.string(), // Snapshot at creation time
		// Renderer engine version that produced `htmlContent`; needed when the renderer changes.
		rendererVersion: v.optional(v.number()),
		subject: v.string(),
		previewText: v.optional(v.string()),
		expiresAt: v.number(), // createdAt + 48h
		createdBy: v.string(), // BetterAuth user ID
		revokedAt: v.optional(v.number()),
		createdAt: v.number(),
	})
		.index('by_token', ['token'])
		.index('by_email_template', ['emailTemplateId'])
		.index('by_transactional_email', ['transactionalEmailId']),

	// Transactional Emails - API-triggered email templates with variable support
	transactionalEmails: defineTable({
		name: v.string(),
		slug: v.string(), // Unique identifier, used for API identification
		subject: v.string(),
		content: v.string(), // JSON string for editor state
		htmlContent: v.optional(v.string()), // Rendered HTML for sending
		// JSON schema defining expected data variables
		// Example: { "orderNumber": "string", "totalAmount": "number" }
		dataVariablesSchema: v.optional(dataVariablesSchemaValidator),
		status: v.union(
			v.literal('draft'),
			v.literal('published'),
			v.literal('pending_review') // Held for admin approval (content scan flagged as suspicious)
		),
		publishedAt: v.optional(v.number()),
		// Whether to show unsubscribe link in the email (default: false for transactional)
		showUnsubscribe: v.optional(v.boolean()),
		// Multi-language support (same as emailTemplates)
		// Default language for this email (e.g., "en", "de", "fr")
		defaultLanguage: v.optional(v.string()),
		// Available translation language codes (e.g., ["en", "de", "fr"])
		supportedLanguages: v.optional(v.array(v.string())),
		// Translations keyed by language code (JSON string)
		// Structure: { "de": { "subject": "...", "blocks": {...} }, ... }
		// Default language content is stored in main subject/content fields
		translations: v.optional(v.string()),
		// Pre-rendered HTML translations keyed by language code (JSON string)
		// Structure: { "de": { "htmlContent": "...", "subject": "..." }, ... }
		// Published when template is published with translations
		htmlTranslations: v.optional(v.string()),
		// IDs of saved blocks currently linked in this email's content
		linkedBlockIds: v.optional(v.array(v.string())),
		// File attachments stored as JSON string
		// Structure: [{ id, filename, storageId, url, contentType, fileSize, mediaAssetId? }]
		attachments: v.optional(v.string()),
		// Denormalized search field: "name subject slug" for full-text search
		searchableText: v.optional(v.string()),
		// Schema version for `content` (EditorBlock[]). Bump on block shape change.
		contentBlockVersion: v.optional(v.number()),
		// Renderer engine version that produced `htmlContent`. Bump when rendering output changes materially.
		rendererVersion: v.optional(v.number()),
		// Schema version for `attachments` JSON. Bump on shape change.
		attachmentsVersion: v.optional(v.number()),
		// Schema version for `translations` / `htmlTranslations` JSON. Bump on shape change.
		translationsVersion: v.optional(v.number()),
		// AGGREGATED — total transactional sends enqueued against this
		// template. Bumped atomically with the `transactionalSends` insert
		// in `transactional/dispatch.ts`. The list page reads this directly
		// instead of N+1 scanning `transactionalSends` per template.
		sendCount: v.optional(v.number()),
		// Saved-block rerender state. `stale: true` means `htmlContent` no
		// longer matches `content` because a linked saved block was edited;
		// the rerender pool clears it once the action succeeds. Per ADR-0023.
		htmlRenderState: v.optional(
			v.object({
				stale: v.boolean(),
				failureCount: v.optional(v.number()),
				lastFailureAt: v.optional(v.number()),
			})
		),
		// Marks rows inserted by /seed/demo so they can be wiped on reset.
		seedTag: v.optional(v.string()),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_slug', ['slug'])
		.index('by_status', ['status'])
		.searchIndex('search_transactional', {
			searchField: 'searchableText',
			filterFields: [],
		}),

	// Transactional Sends - tracks individual non-campaign email sends and their
	// status. Generalized beyond strictly transactional sends: `kind`
	// discriminates the three non-campaign sources (transactional API, automation
	// step, agent approved-reply) so all of them flow through the same Send
	// lifecycle (blocklist on hard bounce, sendingReputation denominator, etc.).
	// SendRef stays two-armed (campaign | transactional); this row's `kind`
	// distinguishes the non-campaign sources downstream.
	transactionalSends: defineTable({
		// Which non-campaign source produced this Send. `transactional` is the
		// public transactional API; `automation` is an automation email step;
		// `agent_reply` is an approved agent-drafted inbox reply.
		kind: v.union(v.literal('transactional'), v.literal('automation'), v.literal('agent_reply')),
		// Set for `kind: 'transactional'` (the template-backed API send). Optional
		// because automation/agent sends carry their own provenance + pre-rendered
		// subject/html instead of a template id.
		transactionalEmailId: v.optional(v.id('transactionalEmails')),
		// Provenance for `kind: 'automation'` — the owning automation.
		automationId: v.optional(v.id('automations')),
		// Provenance for `kind: 'agent_reply'` — the inbound message being replied
		// to. The Send completion module drives that inbound message to
		// `sent`/`failed` once the worker outcome lands.
		inboundMessageId: v.optional(v.id('inboundMessages')),
		// Pre-rendered subject for automation/agent sends (which have no template
		// id to read it from). Surfaces in the email_sent contact-activity row.
		subject: v.optional(v.string()),
		// Recipient information
		email: v.string(), // Recipient email address
		contactId: v.optional(v.id('contacts')), // Optional link to contact if they exist
		// Resolved recipient language for this send. Populated at intake by
		// the Transactional send intake (module) from the request → contact →
		// template-default fallback chain. Surfaces in analytics queries;
		// pre-ADR-0021 the resolved language lived on the API response only.
		language: v.optional(v.string()),
		// Data variables that were used for this send
		dataVariables: v.optional(jsonPrimitiveRecord),
		// Provider information
		providerMessageId: v.optional(v.string()), // Message ID from email provider (Resend)
		// Current status of this email send. Per ADR-0006, transactional sends
		// now pre-create in `queued` (symmetric with campaign sends) so the
		// worker-completion path goes through the Send lifecycle for both
		// kinds; `failed` rows persist once the worker errors.
		status: v.union(
			v.literal('queued'),
			v.literal('sent'),
			v.literal('failed'),
			v.literal('delivered'),
			v.literal('opened'),
			v.literal('clicked'),
			v.literal('bounced'),
			v.literal('complained')
		),
		// Timestamps for status changes. `sentAt` is optional because rows
		// start life in `queued` (ADR-0006); it is set when the worker
		// transitions to `sent`.
		queuedAt: v.optional(v.number()),
		sentAt: v.optional(v.number()),
		deliveredAt: v.optional(v.number()),
		failedAt: v.optional(v.number()),
		openedAt: v.optional(v.number()),
		clickedAt: v.optional(v.number()),
		bouncedAt: v.optional(v.number()),
		// Bounce classification; required-via-runtime-guard when status='bounced'.
		// See CONTEXT.md "Send status" — canonical encoding of bounce class.
		bounceType: v.optional(v.union(v.literal('hard'), v.literal('soft'))),
		complainedAt: v.optional(v.number()),
		// Link tracking for click attribution
		clickedLinks: v.optional(v.array(linkClickValidator)),
		// Open tracking count (may open multiple times)
		openCount: v.optional(v.number()),
		// Error information for failures (e.g., from provider error responses)
		errorMessage: v.optional(v.string()),
		errorCode: v.optional(v.string()),
		// Provider routing metadata (multi-tenant sending platform)
		providerType: v.optional(v.string()), // Which provider sent this email (mta, ses, resend)
		// Correlation ID for end-to-end traceability (API request → send → webhook)
		correlationId: v.optional(v.string()),
		// Storage IDs of attachment blobs, captured at queue time and cleaned
		// up via the `attachment_cleanup` sendLifecycle effect on terminal
		// worker outcomes (sent / failed). Per ADR-0006.
		attachmentStorageIds: v.optional(v.array(v.string())),
		// Soft-delete fields: cascade from soft-deleted contact; preserves audit trail.
		deletedAt: v.optional(v.number()),
		deletedBy: v.optional(v.string()),
	})
		.index('by_transactional_email', ['transactionalEmailId'])
		.index('by_status', ['status'])
		.index('by_email', ['email'])
		.index('by_contact', ['contactId'])
		.index('by_sent_at', ['sentAt'])
		.index('by_provider_message_id', ['providerMessageId']),
};
