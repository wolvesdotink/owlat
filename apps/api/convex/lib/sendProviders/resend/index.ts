/**
 * Resend Send provider adapter (module).
 *
 * Per ADR-0020. Single-attempt `sendEmail` via the Resend SDK; failures are
 * classified by the response's `error.name` / `error.statusCode` first, then
 * fall back to substring matching.
 */

import { Resend } from 'resend';
import { getRequired } from '../../env';
import { withTimeout } from '../../inputGuards';
import {
	EmailErrorCode,
	httpStatusToErrorCode,
	type EmailSendAttempt,
	type EmailSendParams,
	type ResendExtras,
	type SendProviderModule,
} from '../types';
import { RETRY_DELAYS_MS } from '../../constants';
const RESEND_TIMEOUT_MS = 30_000;

let cachedClient: Resend | null = null;

// Exported so other Resend callers (e.g. confirmationEmail) reuse the same
// cached, env-validated client instead of re-deriving it.
export function getResendClient(): Resend {
	if (cachedClient) return cachedClient;
	cachedClient = new Resend(getRequired('RESEND_API_KEY'));
	return cachedClient;
}

export const resendSendProvider: SendProviderModule<'resend'> = {
	kind: 'resend',
	retryDelays: RETRY_DELAYS_MS,

	async sendEmail(
		params: EmailSendParams,
		extras?: ResendExtras,
	): Promise<EmailSendAttempt> {
		let client: Resend;
		try {
			client = getResendClient();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			return {
				success: false,
				errorMessage,
				errorCode: EmailErrorCode.AUTH_FAILED,
			};
		}

		try {
			const result = await withTimeout(
				client.emails.send(
					{
						to: params.to,
						from: params.from,
						subject: params.subject,
						html: params.html,
						replyTo: params.replyTo,
						headers:
							params.headers && Object.keys(params.headers).length > 0 ? params.headers : undefined,
						attachments: params.attachments?.map((a) => ({
							filename: a.filename,
							content: a.content,
							content_type: a.contentType,
						})),
					},
					// Stable idempotency key → Resend `Idempotency-Key` header, so a
					// surviving retry of the same Send de-dupes at Resend.
					extras?.idempotencyKey ? { idempotencyKey: extras.idempotencyKey } : undefined,
				),
				RESEND_TIMEOUT_MS,
				'Resend API call timed out',
			);

			if (result.error) {
				const errorName = result.error.name ?? '';
				const errorMessage = result.error.message ?? 'Resend send failed';
				return {
					success: false,
					errorMessage,
					errorCode: this.categorizeError(`${errorName}: ${errorMessage}`),
				};
			}

			return { success: true, id: result.data?.id ?? '' };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			return {
				success: false,
				errorMessage,
				errorCode: this.categorizeError(errorMessage),
			};
		}
	},

	/**
	 * Classify a Resend error. Resend errors carry a `name` (e.g.
	 * `rate_limit_exceeded`, `invalid_to_field`, `missing_api_key`) plus a
	 * `message`. The dispatch helper passes `${error.name}: ${error.message}`.
	 */
	categorizeError(message: string, httpStatus?: number): EmailErrorCode {
		if (httpStatus !== undefined) {
			const byStatus = httpStatusToErrorCode(httpStatus);
			if (byStatus !== undefined) return byStatus;
		}

		const lower = message.toLowerCase();

		if (lower.includes('rate_limit') || lower.includes('rate limit') || lower.includes('too many')) {
			return EmailErrorCode.RATE_LIMIT;
		}
		if (
			lower.includes('internal_server_error') ||
			lower.includes('application_error') ||
			lower.includes('timeout') ||
			lower.includes('timed out') ||
			lower.includes('econnrefused')
		) {
			return EmailErrorCode.SERVER_ERROR;
		}
		if (
			lower.includes('invalid_to_field') ||
			lower.includes('invalid_to') ||
			(lower.includes('invalid') && (lower.includes('recipient') || lower.includes('to ')))
		) {
			return EmailErrorCode.INVALID_RECIPIENT;
		}
		if (
			lower.includes('invalid_from_field') ||
			lower.includes('invalid_from') ||
			lower.includes('not_verified') ||
			lower.includes('domain_not_verified') ||
			(lower.includes('invalid') && (lower.includes('from') || lower.includes('sender')))
		) {
			return EmailErrorCode.INVALID_SENDER;
		}
		if (
			lower.includes('missing_api_key') ||
			lower.includes('invalid_api_key') ||
			lower.includes('restricted_api_key') ||
			lower.includes('unauthorized')
		) {
			return EmailErrorCode.AUTH_FAILED;
		}
		if (
			lower.includes('validation_error') &&
			(lower.includes('spam') || lower.includes('blocked'))
		) {
			return EmailErrorCode.CONTENT_REJECTED;
		}
		if (lower.includes('spam') || lower.includes('blocked')) {
			return EmailErrorCode.CONTENT_REJECTED;
		}

		return EmailErrorCode.UNKNOWN;
	},
};

// Exported for tests that need to bypass the lazy-init cache between cases.
export function _resetResendClientCacheForTests(): void {
	cachedClient = null;
}
