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

/** Every `error.data.reason` the contract declares. */
export type ApiErrorReason = ApiKeyErrorReason | TransactionalRefusalReason;
