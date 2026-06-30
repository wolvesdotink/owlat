/**
 * An attachment to include with the transactional email.
 */
export interface TransactionalAttachment {
	/**
	 * Filename for the attachment (e.g., 'invoice.pdf').
	 */
	filename: string;

	/**
	 * Base64-encoded file content. Mutually exclusive with `url`.
	 */
	content?: string;

	/**
	 * HTTPS URL to fetch the attachment from. Mutually exclusive with `content`.
	 */
	url?: string;

	/**
	 * MIME type of the attachment (e.g., 'application/pdf').
	 * Auto-detected from filename if not provided.
	 */
	contentType?: string;
}

/**
 * Parameters for sending a transactional email.
 */
export interface SendTransactionalParams {
	/**
	 * Recipient's email address (required).
	 */
	email: string;

	/**
	 * ID of the transactional email template.
	 * Either transactionalId or slug must be provided.
	 */
	transactionalId?: string;

	/**
	 * Slug identifier of the transactional email template.
	 * Either transactionalId or slug must be provided.
	 */
	slug?: string;

	/**
	 * Variables to replace in the email template.
	 * Keys should match the variable names defined in your template.
	 */
	dataVariables?: Record<string, unknown>;

	/**
	 * Language code for selecting a translation (e.g., 'en', 'de', 'fr').
	 * Falls back to contact's language preference, then template default.
	 */
	language?: string;

	/**
	 * File attachments to include with the email.
	 * Maximum 10 attachments, 10 MB total size limit.
	 */
	attachments?: TransactionalAttachment[];
}

/**
 * Response when a transactional email is queued for sending.
 */
export interface SendTransactionalResponse {
	/**
	 * Status of the email. Always 'queued' on success.
	 */
	status: 'queued';

	/**
	 * Recipient's email address.
	 */
	email: string;

	/**
	 * ID of the send record created for this email (a `transactionalSends`
	 * row), NOT the template id. Use it to correlate with delivery webhooks.
	 */
	transactionalEmailId: string;

	/**
	 * Slug of the transactional email template used.
	 */
	slug: string;

	/**
	 * ID of the associated contact (if exists or created).
	 */
	contactId?: string;

	/**
	 * Whether a new contact was created.
	 */
	contactCreated: boolean;

	/**
	 * The language used for this email send.
	 */
	language: string;
}
