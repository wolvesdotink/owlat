/**
 * The wire types of the public v1 API: the package's root export.
 *
 * This file is plain TypeScript with no imports. The JavaScript SDK
 * re-exports these declarations type-only and its declaration build inlines
 * this one file into the published `.d.ts`, so it must stay a single module
 * that reaches nothing else. The schemas beside it are checked against these
 * types at compile time (`__tests__/typeAgreement.test.ts`).
 */

// ── Shared envelopes and values ─────────────────────────────────────────────

/** A JSON primitive: the only value a template variable or event property may hold. */
export type JsonPrimitive = string | number | boolean | null;

/**
 * Query parameters of a cursor-paginated list request.
 *
 * Pagination is cursor-based: pass {@link ListQuery.cursor} from the previous
 * response's {@link PaginationMeta.cursor} to fetch the next page. There is no
 * row ceiling — every record is reachable.
 */
export interface ListQuery {
	/**
	 * Number of items per page (max 100). Defaults to 25.
	 */
	limit?: number;
	/**
	 * Opaque continuation cursor from a previous response's `pagination.cursor`.
	 * Omit (or pass `null`) to fetch the first page.
	 */
	cursor?: string | null;
	/**
	 * Search query to filter results. Search results are relevance-ordered.
	 */
	search?: string;
}

/**
 * Cursor-based pagination metadata returned with list responses.
 */
export interface PaginationMeta {
	/**
	 * Items per page.
	 */
	limit: number;
	/**
	 * Total number of items (across all pages).
	 */
	totalItems: number;
	/**
	 * Opaque continuation cursor for the next page, or `null` once `isDone` is
	 * true (the final page has been returned).
	 */
	cursor: string | null;
	/**
	 * True once the final page has been returned.
	 */
	isDone: boolean;
}

/**
 * Base response wrapper for single items.
 */
export interface ApiResponse<T> {
	data: T;
}

/**
 * Response wrapper for paginated lists.
 */
export interface PaginatedResponse<T> {
	data: T[];
	pagination: PaginationMeta;
}

/**
 * Error response from the API — the HTTP serialization of an Operation error.
 * `category` is the closed classification (e.g. 'not_found', 'invalid_input',
 * 'rate_limited'); `data` carries the specifics ({ field }, { retryAfter }, …).
 */
export interface ApiErrorResponse {
	error: {
		category: string;
		message: string;
		data?: Record<string, unknown>;
	};
}

/**
 * Body of `GET /api/v1/health`, the unauthenticated liveness probe.
 */
export interface HealthStatus {
	/** Always `'ok'` when the API answers. */
	status: 'ok';
	/** ISO 8601 timestamp of the answer. */
	timestamp: string;
}

// ── Contacts ────────────────────────────────────────────────────────────────

/** Where a contact came from. `inbound` is set only by the server, never accepted on create. */
export const CONTACT_SOURCES = ['api', 'import', 'form', 'transactional', 'inbound'] as const;

/** How the contact was added. */
export type ContactSource = (typeof CONTACT_SOURCES)[number];

/**
 * Contact resource returned by the API.
 */
export interface Contact {
	/**
	 * Unique identifier for the contact.
	 */
	id: string;
	/**
	 * Contact's email address. Empty for a contact that arrived through a
	 * channel without an email address.
	 */
	email: string;
	/**
	 * Contact's first name.
	 */
	firstName: string | null;
	/**
	 * Contact's last name.
	 */
	lastName: string | null;
	/**
	 * How the contact was added.
	 */
	source: ContactSource;
	/**
	 * ISO 8601 timestamp of when the contact was created.
	 */
	createdAt: string;
	/**
	 * ISO 8601 timestamp of when the contact was last updated.
	 */
	updatedAt: string;
}

/**
 * Parameters for creating a new contact.
 */
export interface CreateContactRequest {
	/**
	 * Contact's email address (required).
	 */
	email: string;
	/**
	 * Contact's first name.
	 */
	firstName?: string;
	/**
	 * Contact's last name.
	 */
	lastName?: string;
}

/**
 * Parameters for updating an existing contact.
 */
export interface UpdateContactRequest {
	/**
	 * Updated email address.
	 */
	email?: string;
	/**
	 * Updated first name.
	 */
	firstName?: string;
	/**
	 * Updated last name.
	 */
	lastName?: string;
}

/**
 * Response when a contact is deleted.
 */
export interface DeleteContactResponse {
	/**
	 * ID of the deleted contact.
	 */
	id: string;
	/**
	 * Always true on successful deletion.
	 */
	deleted: boolean;
}

// ── Events ──────────────────────────────────────────────────────────────────

/**
 * Parameters for sending an event.
 */
export interface SendEventRequest {
	/**
	 * Contact's email address (required).
	 */
	email: string;
	/**
	 * Name of the event (required).
	 * Must start with a letter and contain only alphanumeric characters,
	 * underscores, or hyphens. Maximum 100 characters.
	 */
	eventName: string;
	/**
	 * Additional properties associated with the event.
	 * These can be used in automation conditions. Each value must be a string,
	 * number, boolean or `null`; nested objects and arrays are rejected.
	 */
	eventProperties?: Record<string, JsonPrimitive>;
	/**
	 * Whether to create a new contact if one doesn't exist.
	 * Defaults to false.
	 */
	createContactIfNotExists?: boolean;
}

/**
 * Response when an event is sent.
 */
export interface SendEventResponse {
	/**
	 * Unique identifier for this event.
	 */
	eventId: string;
	/**
	 * ID of the associated contact.
	 */
	contactId: string;
	/**
	 * Name of the event that was sent.
	 */
	eventName: string;
	/**
	 * Number of automations triggered by this event.
	 */
	triggeredAutomations: number;
	/**
	 * Whether a new contact was created.
	 */
	contactCreated: boolean;
}

// ── Topics ──────────────────────────────────────────────────────────────────

/** Double opt-in states a topic membership can be in. */
export const DOI_STATUSES = ['not_required', 'pending', 'confirmed'] as const;

/**
 * DOI (Double Opt-In) status for a contact.
 */
export type DoiStatus = (typeof DOI_STATUSES)[number];

/**
 * Body of `POST /api/v1/topics/{topicId}/contacts`.
 */
export interface AddContactToTopicRequest {
	/**
	 * Contact's email address.
	 * Either email or contactId must be provided.
	 */
	email?: string;
	/**
	 * Contact's ID.
	 * Either email or contactId must be provided.
	 */
	contactId?: string;
}

/**
 * Response when a contact is added to a topic.
 */
export interface AddToTopicResponse {
	/**
	 * Whether the operation was successful.
	 */
	success: boolean;
	/**
	 * ID of the contact that was added.
	 */
	contactId: string;
	/**
	 * ID of the topic.
	 */
	topicId: string;
	/**
	 * DOI status for the contact.
	 * If 'pending', a confirmation email has been sent.
	 */
	doiStatus: DoiStatus;
}

/**
 * Response when a contact is removed from a topic.
 */
export interface RemoveFromTopicResponse {
	/**
	 * Whether the operation was successful.
	 */
	success: boolean;
	/**
	 * Whether the contact was actually removed.
	 * False if contact was not a member of the topic.
	 */
	removed: boolean;
}

// ── Transactional ───────────────────────────────────────────────────────────

/**
 * An attachment to include with the transactional email.
 */
export interface TransactionalAttachment {
	/**
	 * Filename for the attachment (e.g., 'invoice.pdf'). Must not contain `/`
	 * or `\`.
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
export interface SendTransactionalRequest {
	/**
	 * Recipient's email address (required).
	 */
	email: string;
	/**
	 * ID of the transactional email template.
	 * Either transactionalId or slug must be provided; the ID wins when both are.
	 */
	transactionalId?: string;
	/**
	 * Slug identifier of the transactional email template.
	 * Either transactionalId or slug must be provided.
	 */
	slug?: string;
	/**
	 * Variables to replace in the email template.
	 * Keys should match the variable names defined in your template. Each value
	 * must be a string, number, boolean or `null`; nested objects and arrays are
	 * rejected.
	 */
	dataVariables?: Record<string, JsonPrimitive>;
	/**
	 * Language code for selecting a translation (e.g., 'en', 'de', 'fr').
	 * Falls back to contact's language preference, then template default.
	 */
	language?: string;
	/**
	 * File attachments to include with the email.
	 * Maximum 10 attachments and 10 MB (10 MiB) of decoded content in total.
	 * Send `content` as plain base64 without line breaks.
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
