'use node';

/** Emailit transport adapter. Authentication and provider tracking stay at this boundary. */
import { withTimeout } from '../../inputGuards';
import {
	EmailErrorCode,
	httpStatusToErrorCode,
	parseRetryAfterDeltaMs,
	type DispatchExtrasInput,
	type EmailitExtras,
	type EmailSendAttempt,
	type EmailSendParams,
	type SendProviderModule,
} from '../types';
import { sendProviderCatalogEntry } from '../catalog';
import { transportEnvRequired } from '../transportEnv';
import type { SendTransportRecord } from '../transports';

export const EMAILIT_SEND_URL = 'https://api.emailit.com/v2/emails';
export const EMAILIT_SEND_TIMEOUT_MS = 30_000;
const EMAILIT_TIMEOUT_MESSAGE = 'Emailit API call timed out';

interface EmailitErrorBody {
	readonly message?: unknown;
	readonly error?: unknown;
}

function safeErrorMessage(body: string, status: number, apiKey: string): string {
	let message = `Emailit send failed (HTTP ${status})`;
	try {
		const parsed = JSON.parse(body) as EmailitErrorBody;
		if (typeof parsed.message === 'string' && parsed.message.trim()) message = parsed.message;
		else if (typeof parsed.error === 'string' && parsed.error.trim()) message = parsed.error;
	} catch {
		// Gateway HTML and malformed payloads are intentionally not surfaced.
	}
	return apiKey ? message.split(apiKey).join('[redacted]') : message;
}

function responseId(value: unknown): string | null {
	if (!value || typeof value !== 'object') return null;
	const id = (value as { id?: unknown }).id;
	return typeof id === 'string' && id.trim().length > 0 ? id : null;
}

export const emailitSendProvider: SendProviderModule<'emailit'> = {
	kind: 'emailit',
	retryDelays: sendProviderCatalogEntry('emailit').retryDelays,

	buildDispatchExtras(input: DispatchExtrasInput): EmailitExtras {
		return { idempotencyKey: input.idempotencyKey };
	},

	// No buildSystemMailExtras: the catalog declares
	// `deduplicatesOnIdempotencyKey: false` (vendor dedup unproven), and the
	// declaration-wiring parity test refuses a key the disposition cannot
	// trust. Restore the builder together with the flag once proven.

	async sendEmail(
		transport: SendTransportRecord,
		params: EmailSendParams,
		extras?: EmailitExtras
	): Promise<EmailSendAttempt> {
		let apiKey: string;
		try {
			apiKey = transportEnvRequired(transport, 'EMAILIT_API_KEY');
		} catch (error) {
			return {
				success: false,
				errorMessage: error instanceof Error ? error.message : 'Emailit is not configured',
				errorCode: EmailErrorCode.AUTH_FAILED,
			};
		}

		const abort = new AbortController();
		try {
			const response = await withTimeout(
				fetch(EMAILIT_SEND_URL, {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${apiKey}`,
						'Content-Type': 'application/json',
						...(extras?.idempotencyKey ? { 'Idempotency-Key': extras.idempotencyKey } : {}),
					},
					body: JSON.stringify({
						from: params.from,
						to: params.to,
						subject: params.subject,
						html: params.html,
						...(params.text !== undefined ? { text: params.text } : {}),
						...(params.replyTo ? { reply_to: params.replyTo } : {}),
						...(params.headers && Object.keys(params.headers).length > 0
							? { headers: params.headers }
							: {}),
						...(params.attachments
							? {
									attachments: params.attachments.map((attachment) => ({
										filename: attachment.filename,
										content: attachment.content.toString('base64'),
										content_type: attachment.contentType ?? 'application/octet-stream',
										encoding: 'base64',
									})),
								}
							: {}),
						// Owlat owns open/click instrumentation across every transport.
						tracking: { loads: false, clicks: false },
					}),
					signal: abort.signal,
				}),
				EMAILIT_SEND_TIMEOUT_MS,
				EMAILIT_TIMEOUT_MESSAGE
			);

			if (!response.ok) {
				const body = await response.text().catch(() => '');
				const retryAfterMs = parseRetryAfterDeltaMs(response.headers.get('Retry-After'));
				return {
					success: false,
					errorMessage: safeErrorMessage(body, response.status, apiKey),
					errorCode: this.categorizeError(body, response.status),
					...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
				};
			}

			const id = responseId(await response.json());
			return id
				? { success: true, id }
				: {
						success: false,
						errorMessage: 'Emailit returned no message id',
						errorCode: EmailErrorCode.UNKNOWN,
					};
		} catch (error) {
			const message = (error instanceof Error ? error.message : 'Unknown error')
				.split(apiKey)
				.join('[redacted]');
			return { success: false, errorMessage: message, errorCode: this.categorizeError(message) };
		} finally {
			abort.abort();
		}
	},

	categorizeError(message: string, httpStatus?: number): EmailErrorCode {
		if (httpStatus !== undefined) {
			const code = httpStatusToErrorCode(httpStatus);
			if (code !== undefined) return code;
		}
		const lower = message.toLowerCase();
		if (lower.includes('rate limit') || lower.includes('too many'))
			return EmailErrorCode.RATE_LIMIT;
		if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('econn')) {
			return EmailErrorCode.SERVER_ERROR;
		}
		if (lower.includes('api key') || lower.includes('unauthorized'))
			return EmailErrorCode.AUTH_FAILED;
		if (lower.includes('sender') || lower.includes('from address'))
			return EmailErrorCode.INVALID_SENDER;
		if (lower.includes('recipient') || lower.includes('to address')) {
			return EmailErrorCode.INVALID_RECIPIENT;
		}
		if (lower.includes('spam') || lower.includes('content')) return EmailErrorCode.CONTENT_REJECTED;
		return EmailErrorCode.UNKNOWN;
	},
};
