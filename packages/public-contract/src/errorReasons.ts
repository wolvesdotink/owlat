/**
 * The `error.data.reason` codes of the public v1 API. Plain TypeScript with no
 * imports, re-exported by `types.ts`; see there for why.
 */

/**
 * Why `POST /api/v1/transactional` refused a send, in `error.data.reason`.
 * Branch on these rather than on the message. New reasons can be added; treat
 * an unknown one by its HTTP status.
 */
export const TRANSACTIONAL_REFUSAL_REASONS = [
	'feature_disabled',
	'abuse_blocked',
	'no_delivery_provider',
	'recipient_blocked',
	'template_not_found',
	'template_not_published',
	'template_no_content',
	'sender_not_configured',
	'domain_unverified',
	'invalid_variables',
	'recipient_rate_limited',
	'daily_send_limit',
	'idempotency_conflict',
	'idempotency_erased',
] as const;

/** Why a transactional send was refused. */
export type TransactionalRefusalReason = (typeof TRANSACTIONAL_REFUSAL_REASONS)[number];

/**
 * Why a key-authenticated call was refused before it ran, in
 * `error.data.reason`: no usable `Authorization` header, a key that is not an
 * Owlat key, a key that does not authenticate (unknown, revoked and expired
 * keys answer alike), a key without the operation's scope, which
 * `error.data.scope` names, or too many failed key attempts from the caller's
 * address.
 */
export const API_KEY_ERROR_REASONS = [
	'missing_credentials',
	'malformed_key',
	'invalid_key',
	'missing_scope',
	'too_many_failed_attempts',
] as const;

/** Why a key-authenticated call was refused before it ran. */
export type ApiKeyErrorReason = (typeof API_KEY_ERROR_REASONS)[number];

/**
 * Why a write was refused whatever it wrote: the workspace is being deleted,
 * and nothing is accepted until the deletion has finished. Every route that
 * writes can answer it.
 */
export const WRITE_REFUSAL_REASONS = ['workspace_deletion_in_progress'] as const;

/** Why a write was refused whatever it wrote. */
export type WriteRefusalReason = (typeof WRITE_REFUSAL_REASONS)[number];

/**
 * Why a write to a transactional email or saved block was refused, in
 * `error.data.reason`:
 *
 * - `invalid_content`: a block fails the content check; `error.data.issues`
 *   lists each problem with the block's id.
 * - `content_too_large`: the email with its rendered HTML would not fit in one
 *   stored record.
 * - `slug_taken`: another transactional email has the slug.
 * - `revision_mismatch`: the `If-Match` revision is not the email's current
 *   one; `error.data.currentRevision` names it.
 * - `email_published`: the email is published and the request did not ask to
 *   change it while live (`?whilePublished=true`).
 * - `default_language_change`: the default language cannot change while the
 *   email has translations.
 * - `content_blocked`: the content scan refused the content of a published
 *   email; `error.data.scanScore` is the scan's score.
 * - `html_render_pending`: a saved block the email uses changed and its HTML is
 *   still being rendered; try again shortly.
 * - `template_write_rate_limited`: too many template writes from this key.
 *
 * New reasons can be added; treat an unknown one by its HTTP status.
 */
export const TEMPLATE_WRITE_REFUSAL_REASONS = [
	'invalid_content',
	'content_too_large',
	'slug_taken',
	'revision_mismatch',
	'email_published',
	'default_language_change',
	'content_blocked',
	'html_render_pending',
	'template_write_rate_limited',
] as const;

/** Why a template write was refused. */
export type TemplateWriteRefusalReason = (typeof TEMPLATE_WRITE_REFUSAL_REASONS)[number];

/** Every `error.data.reason` the contract declares. */
export type ApiErrorReason =
	| ApiKeyErrorReason
	| TransactionalRefusalReason
	| WriteRefusalReason
	| TemplateWriteRefusalReason;
