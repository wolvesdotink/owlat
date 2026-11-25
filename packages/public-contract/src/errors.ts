/**
 * The `error.data.reason` codes and the HTTP status each one answers with.
 * The OpenAPI document lists every reason an operation can send under the
 * status named here.
 */

import type { ApiErrorReason } from './errorReasons';

export const ERROR_REASON_STATUS: Record<ApiErrorReason, number> = {
	missing_credentials: 401,
	malformed_key: 401,
	invalid_key: 401,
	missing_scope: 403,
	too_many_failed_attempts: 429,
	feature_disabled: 403,
	abuse_blocked: 403,
	no_delivery_provider: 422,
	recipient_blocked: 422,
	template_not_found: 404,
	template_not_published: 422,
	template_no_content: 422,
	sender_not_configured: 422,
	domain_unverified: 422,
	invalid_variables: 400,
	recipient_rate_limited: 429,
	daily_send_limit: 429,
	idempotency_conflict: 409,
	idempotency_erased: 409,
	workspace_deletion_in_progress: 422,
	invalid_content: 400,
	content_too_large: 400,
	slug_taken: 409,
	revision_mismatch: 409,
	email_published: 422,
	email_in_review: 422,
	default_language_change: 422,
	content_blocked: 422,
	html_render_pending: 422,
	template_write_rate_limited: 429,
};
