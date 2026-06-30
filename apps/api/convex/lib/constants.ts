/**
 * Shared constants for the Convex backend.
 */

// Default pagination sizes by context
export const PAGE_SIZE_DEFAULT = 25;
export const PAGE_SIZE_SMALL = 5;
export const PAGE_SIZE_MEDIUM = 10;
export const PAGE_SIZE_LARGE = 50;

// Rate limiting
export const API_RATE_LIMIT_PER_SECOND = 10;
export const RATE_LIMIT_WINDOW_MS = 1000;

// Retry configuration
export const MAX_RETRY_ATTEMPTS = 3;
export const RETRY_DELAYS_MS = [1000, 5000, 30000] as const;

// Webhook delivery
export const MAX_WEBHOOK_ATTEMPTS = 3;
export const WEBHOOK_RETRY_DELAYS_MS = [0, 60_000, 300_000] as const;

// Token expiry durations
export const UNSUBSCRIBE_TOKEN_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
export const AUDIT_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Import batch sizes
export const IMPORT_BATCH_SIZE = 100;

// Full-table pagination limit (for internal operations)
export const BULK_QUERY_LIMIT = 1000;

// ─── Schema-versioning constants ───────────────────────────────────────────
// Every JSON blob stored as v.string() or v.any() is paired with a sibling
// `<field>Version` field. Bump the relevant constant when the blob shape
// changes; reader code can branch on the stored version.
// See CONVENTIONS.md "Schema evolution" section.

/** EditorBlock[] shape (emailTemplates.content, transactionalEmails.content, mailDrafts.bodyBlocks). */
export const CURRENT_CONTENT_BLOCK_VERSION = 1;

/** Renderer engine output shape (htmlContent on templates, shareLinks.htmlContent). */
export const CURRENT_RENDERER_VERSION = 1;

/** webhookDeliveryLogs.payload contract version — bumping is a breaking change for external receivers. */
export const CURRENT_WEBHOOK_PAYLOAD_VERSION = 1;

/** transactionalEmails.attachments JSON shape. */
export const CURRENT_TRANSACTIONAL_ATTACHMENTS_VERSION = 1;

/** externalMailAccounts encrypted credential envelope (AES-256-GCM blob) shape. */
export const CURRENT_EXTERNAL_MAIL_CRED_VERSION = 1;

/** transactionalEmails.translations / htmlTranslations JSON shape. */
export const CURRENT_TRANSLATIONS_VERSION = 1;

/** unifiedMessages.content JSON shape. */
export const CURRENT_UNIFIED_MESSAGE_CONTENT_VERSION = 1;

/** Embedding model identifier stored on knowledgeEntries / semanticFiles rows. */
export const CURRENT_EMBEDDING_MODEL = 'text-embedding-3-small';

/**
 * Width of the embedding vectors stored in the knowledge / semantic-file vector
 * indexes. Hard-coupled to the `dimensions: 1536` literals in
 * schema/knowledge.ts — Convex schema is build-time so the literal there can't
 * reference this constant; keep the two in sync. A configured embedding model
 * that produces a different width is rejected (see lib/llmProvider.ts).
 */
export const EMBEDDING_DIMENSIONS = 1536;
