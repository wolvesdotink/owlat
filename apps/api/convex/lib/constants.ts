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

// Connected-app (Tier 2) connection test — a one-shot, SSRF-guarded reachability
// probe of an app's hook endpoint from the registration UX. It is NOT a signed
// hook (that is PP-24): it never carries the shared secret and grants the app
// nothing. The deadline is short and the response body is bounded so a slow or
// oversized endpoint can neither hang the action nor exhaust memory.
export const CONNECTED_APP_TEST_TIMEOUT_MS = 5_000;
export const CONNECTED_APP_TEST_MAX_RESPONSE_BYTES = 64 * 1024;

// Connected-app (Tier 2) SIGNED SYNCHRONOUS HOOKS (PP-24) — the outbound
// draft/gate/score calls Owlat makes to a connected app's endpoint. Unlike the
// unsigned connection probe above, these carry a per-request HMAC signature over
// the body and are bounded on every axis so a hostile or broken endpoint can
// neither stall the pipeline nor exhaust memory:
//   - a hard per-call deadline (the guarded fetch is aborted at it);
//   - a request-body byte cap (defense-in-depth; the payload is bounded upstream);
//   - a response-body byte cap (drained under the cap; over-cap → fail closed);
//   - a response-timestamp tolerance for the response-side replay defense.
export const CONNECTED_APP_HOOK_TIMEOUT_MS = 5_000;
export const CONNECTED_APP_HOOK_MAX_REQUEST_BYTES = 64 * 1024;
export const CONNECTED_APP_HOOK_MAX_RESPONSE_BYTES = 64 * 1024;
/** Allowed skew between now and a response's signed timestamp (replay window). */
export const CONNECTED_APP_HOOK_RESPONSE_TOLERANCE_MS = 30_000;
/** Consecutive hook failures that trip the per-(app,kind) circuit breaker OPEN. */
export const CONNECTED_APP_HOOK_CIRCUIT_FAILURE_THRESHOLD = 5;
/** How long the circuit stays open before a single half-open trial call, in ms. */
export const CONNECTED_APP_HOOK_CIRCUIT_COOLDOWN_MS = 60_000;
/** Code-point clamp for an accepted (untrusted) draft-hook body. */
export const CONNECTED_APP_HOOK_MAX_DRAFT_CODE_POINTS = 64 * 1024;
/** Code-point clamp for an accepted (untrusted) gate/score reason string. */
export const CONNECTED_APP_HOOK_MAX_REASON_CODE_POINTS = 300;

// Redacted hook DELIVERY LOG reads (PP-25). The log is a per-org diagnostic
// table; every read is bounded and org-scoped. A read scans at most SCAN_CAP
// recent rows off an index, JS-filters the requested kind/source, and returns up
// to the (clamped) page limit — so combined filters stay indexed and bounded.
export const CONNECTED_APP_HOOK_LOG_DEFAULT_LIMIT = 50;
export const CONNECTED_APP_HOOK_LOG_MAX_LIMIT = 200;
export const CONNECTED_APP_HOOK_LOG_SCAN_CAP = 500;
/** Rows deleted per retention batch before the cleanup mutation reschedules. */
export const CONNECTED_APP_HOOK_LOG_CLEANUP_BATCH_SIZE = 100;

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

/** pluginStorageEntries.valueJson canonical JSON shape. */
export const CURRENT_PLUGIN_STORAGE_VALUE_JSON_VERSION = 1;

/**
 * connectedApps sealed hook-signing secret envelope (AES-256-GCM blob) shape.
 * Bump alongside a one-shot re-seal migration if the KDF/cipher context in
 * `connectedApps/secretBox.ts` changes.
 */
export const CURRENT_CONNECTED_APP_SECRET_VERSION = 1;

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
