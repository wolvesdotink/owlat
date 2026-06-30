import { BaseResource } from './base';
import type { SendTransactionalParams, SendTransactionalResponse } from '../types/transactional';
import type { ApiResponse } from '../types/common';
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
	 * @returns Response with queue status and contact info
	 * @throws {ValidationError} If required parameters are missing or invalid
	 * @throws {NotFoundError} If the transactional email template is not found
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
	 * // Send by ID
	 * const result = await owlat.transactional.send({
	 *   email: 'user@example.com',
	 *   transactionalId: 'abc123',
	 *   language: 'de', // Send German translation
	 * });
	 * ```
	 */
	async send(params: SendTransactionalParams): Promise<SendTransactionalResponse> {
		// Validate that either transactionalId or slug is provided
		if (!params.transactionalId && !params.slug) {
			throw new ValidationError(
				'Either transactionalId or slug is required',
				'invalid_input'
			);
		}

		// Validate attachments
		if (params.attachments) {
			if (params.attachments.length > 10) {
				throw new ValidationError(
					'Maximum 10 attachments allowed',
					'invalid_input'
				);
			}

			const DANGEROUS_MIME_TYPES = new Set([
				'application/x-msdownload', 'application/x-executable',
				'application/x-msdos-program', 'application/x-sh',
				'application/x-bat', 'application/x-cmd',
			]);

			let totalSizeBytes = 0;
			const MAX_TOTAL_SIZE = 10 * 1024 * 1024; // 10 MB

			for (const attachment of params.attachments) {
				if (!attachment.filename) {
					throw new ValidationError(
						'Each attachment must have a filename',
						'invalid_input'
					);
				}
				if (attachment.content && attachment.url) {
					throw new ValidationError(
						'Attachment must have either content or url, not both',
						'invalid_input'
					);
				}
				if (!attachment.content && !attachment.url) {
					throw new ValidationError(
						'Attachment must have either content or url',
						'invalid_input'
					);
				}

				// Validate base64 content format
				if (attachment.content) {
					if (!/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.content)) {
						throw new ValidationError(
							`Attachment "${attachment.filename}" has invalid base64 content`,
							'invalid_input'
						);
					}
					// Track approximate decoded size (base64 is ~4/3 of original)
					totalSizeBytes += Math.ceil(attachment.content.length * 3 / 4);
				}

				// Reject dangerous MIME types
				if (attachment.contentType && DANGEROUS_MIME_TYPES.has(attachment.contentType.toLowerCase())) {
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
			params
		);
		return response.data.data;
	}
}
