/**
 * The `error.data.reason` codes and the HTTP status each one answers with.
 * The OpenAPI document lists every reason an operation can send under the
 * status named here.
 */

import type { ApiErrorReason } from './types';

export const ERROR_REASON_STATUS: Record<ApiErrorReason, number> = {
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
};
