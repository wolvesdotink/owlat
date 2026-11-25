import { BaseResource } from './base';
import type {
	ListTransactionalSendsParams,
	SendTransactionalParams,
	SendTransactionalResponse,
	TransactionalSendStatus,
} from '../types/transactional';
import type { ApiResponse, CursorPaginatedResponse, RequestOptions } from '../types/common';
import { ValidationError } from '../errors';

/**
 * Resource for sending transactional emails.
 */
export class TransactionalResource extends BaseResource {
	/**
	 * Send a transactional email.
	 *
	 * Transactional emails are triggered programmatically and sent immediately.
	 * They're ideal for welcome emails, password resets, order confirmations, etc.
	 *
	 * @param params - Send parameters
	 * @param options - Per-call options; `idempotencyKey` makes the send safe to
	 *   retry (see {@link RequestOptions})
	 * @returns Response with queue status and contact info
	 * @throws {ValidationError} If required parameters are missing or invalid
	 * @throws {NotFoundError} If the transactional email template is not found
	 * @throws {ConflictError} If `idempotencyKey` was already used for a different request
	 *
	 * @example
	 * ```typescript
	 * // Send by slug
	 * const result = await owlat.transactional.send({
	 *   email: 'user@example.com',
	 *   slug: 'welcome-email',
	 *   dataVariables: {
	 *     userName: 'John',
	 *     activationLink: 'https://example.com/activate/abc123',
	 *   },
	 * });
	 *
	 * // A list feeds a repeated block, which reads `{{item.name}}`
	 * const result = await owlat.transactional.send({
	 *   email: 'user@example.com',
	 *   slug: 'order-confirmation',
	 *   dataVariables: {
	 *     items: [
	 *       { name: 'Tent', quantity: 1 },
	 *       { name: 'Stove', quantity: 2 },
	 *     ],
	 *   },
	 * });
	 *
	 * // Send by ID
	 * const result = await owlat.transactional.send({
	 *   email: 'user@example.com',
	 *   transactionalId: 'abc123',
	 *   language: 'de', // Send German translation
	 * });
	 *
	 * // Safe to retry: the server sends at most once per key
	 * const result = await owlat.transactional.send(
	 *   { email: 'user@example.com', slug: 'order-confirmation' },
	 *   { idempotencyKey: `order-${orderId}-confirmation` }
	 * );
	 * ```
	 */
	async send(
		params: SendTransactionalParams,
		options?: RequestOptions
	): Promise<SendTransactionalResponse> {
		// Validate that either transactionalId or slug is provided
		if (!params.transactionalId && !params.slug) {
			throw new ValidationError('Either transactionalId or slug is required', 'invalid_input');
		}

		// Validate attachments
		if (params.attachments) {
			if (params.attachments.length > 10) {
				throw new ValidationError('Maximum 10 attachments allowed', 'invalid_input');
			}

			const DANGEROUS_MIME_TYPES = new Set([
				'application/x-msdownload',
				'application/x-executable',
				'application/x-msdos-program',
				'application/x-sh',
				'application/x-bat',
				'application/x-cmd',
			]);

			let totalSizeBytes = 0;
			const MAX_TOTAL_SIZE = 10 * 1024 * 1024; // 10 MiB of decoded bytes

			for (const attachment of params.attachments) {
				if (!attachment.filename) {
					throw new ValidationError('Each attachment must have a filename', 'invalid_input');
				}
				if (attachment.content && attachment.url) {
					throw new ValidationError(
						'Attachment must have either content or url, not both',
						'invalid_input'
					);
				}
				if (!attachment.content && !attachment.url) {
					throw new ValidationError('Attachment must have either content or url', 'invalid_input');
				}

				// Validate base64 content format
				if (attachment.content) {
					if (!/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.content)) {
						// MIME-style base64 wraps lines every 76 characters; name
						// that case, since the bare message does not say what is wrong.
						const hint = /[\r\n]/.test(attachment.content)
							? ': it contains line breaks; send plain base64 without line breaks'
							: '';
						throw new ValidationError(
							`Attachment "${attachment.filename}" has invalid base64 content${hint}`,
							'invalid_input'
						);
					}
					// Track the exact decoded size (3 bytes per 4 characters, less
					// the padding), the figure the API checks against 10 MiB.
					const padding = attachment.content.endsWith('==')
						? 2
						: attachment.content.endsWith('=')
							? 1
							: 0;
					totalSizeBytes += Math.floor((attachment.content.length * 3) / 4) - padding;
				}

				// Reject dangerous MIME types
				if (
					attachment.contentType &&
					DANGEROUS_MIME_TYPES.has(attachment.contentType.toLowerCase())
				) {
					throw new ValidationError(
						`Attachment "${attachment.filename}" has a disallowed content type: ${attachment.contentType}`,
						'invalid_input'
					);
				}

				// Require HTTPS for URL-based attachments
				if (attachment.url && !attachment.url.startsWith('https://')) {
					throw new ValidationError(
						`Attachment "${attachment.filename}" URL must use HTTPS`,
						'invalid_input'
					);
				}
			}

			if (totalSizeBytes > MAX_TOTAL_SIZE) {
				throw new ValidationError(
					`Total attachment size (~${Math.round(totalSizeBytes / 1024 / 1024)}MB) exceeds 10MB limit`,
					'invalid_input'
				);
			}
		}

		const response = await this.http.post<ApiResponse<SendTransactionalResponse>>(
			'/api/v1/transactional',
			params,
			undefined,
			options
		);
		return response.data.data;
	}

	/**
	 * Get where one send stands: queued, sent, delivered, bounced, failed, ...
	 * A failed send names its `errorCode` and `errorMessage`; a bounced one its
	 * `bounceType`, `bounceCause` and the receiving server's text in
	 * `errorMessage`. The send's data variables are never returned. Needs the
	 * `transactional:send` scope.
	 *
	 * @param sendId - The `transactionalEmailId` that {@link send} returned
	 *   (every `email.*` webhook for the send carries it as `sendId`)
	 * @returns The send's status
	 * @throws {NotFoundError} If no send created through this API has that id
	 *
	 * @example
	 * ```typescript
	 * const { transactionalEmailId } = await owlat.transactional.send({
	 *   email: 'user@example.com',
	 *   slug: 'password-reset',
	 * });
	 * const send = await owlat.transactional.get(transactionalEmailId);
	 * if (send.status === 'failed') console.warn(send.errorCode, send.errorMessage);
	 * ```
	 */
	async get(sendId: string): Promise<TransactionalSendStatus> {
		const response = await this.http.get<ApiResponse<TransactionalSendStatus>>(
			`/api/v1/transactional/${encodeURIComponent(sendId)}`
		);
		return response.data.data;
	}

	/**
	 * List the sends this API created, newest first, each as {@link get}
	 * answers it: the sends to one address, in one state, or both, within
	 * a window of at most 30 days (by default the last 30). Needs the
	 * `transactional:send` scope.
	 *
	 * Pass `cursor` from the previous response's `pagination.cursor`, with the
	 * same filters, to fetch the next page, and stop once `pagination.isDone`
	 * is true. The page has no total.
	 *
	 * @param params - Filters, page size and cursor
	 * @returns One page of sends plus cursor metadata
	 * @throws {ValidationError} If a filter is malformed, the window is over 30
	 *   days, or the cursor belongs to other filters
	 *
	 * @example
	 * ```typescript
	 * // What happened to the reset mail for this customer?
	 * const { data: sends } = await owlat.transactional.list({ email: 'user@example.com' });
	 * for (const send of sends) {
	 *   if (send.status === 'bounced') console.warn(send.bounceCause, send.errorMessage);
	 * }
	 *
	 * // Which sends failed in the last hour?
	 * const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
	 * const failed = await owlat.transactional.list({ status: 'failed', since });
	 *
	 * // Did anything sent to this address bounce?
	 * const bounced = await owlat.transactional.list({ email: 'user@example.com', status: 'bounced' });
	 * ```
	 */
	async list(
		params: ListTransactionalSendsParams = {}
	): Promise<CursorPaginatedResponse<TransactionalSendStatus>> {
		const searchParams = new URLSearchParams();
		// A filter given empty is sent as is, for the server to refuse: dropped,
		// it would widen the list to every recipient.
		for (const name of ['email', 'status', 'since', 'until'] as const) {
			const value = params[name];
			if (value !== undefined) searchParams.set(name, value);
		}
		if (params.cursor) searchParams.set('cursor', params.cursor);
		if (params.limit) searchParams.set('limit', String(params.limit));
		const queryString = searchParams.toString();
		const response = await this.http.get<CursorPaginatedResponse<TransactionalSendStatus>>(
			queryString ? `/api/v1/transactional?${queryString}` : '/api/v1/transactional'
		);
		return response.data;
	}
}
