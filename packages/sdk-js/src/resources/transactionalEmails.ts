import { BaseResource } from './base';
import type { ApiResponse, CursorPaginatedResponse } from '../types/common';
import type {
	CreateTransactionalEmailRequest,
	ListTemplatesParams,
	PutTransactionalEmailRequest,
	TransactionalEmail,
	TransactionalEmailSummary,
	TransactionalEmailWriteOptions,
	TransactionalEmailWriteResult,
} from '../types/templates';

const BASE_PATH = '/api/v1/transactional-emails';

const emailPath = (slug: string) => `${BASE_PATH}/${encodeURIComponent(slug)}`;

/**
 * Resource for reading and writing transactional emails: their blocks,
 * translations and variable schema, and whether they are published. Reads need
 * the `templates:read` scope, writes and publishing `templates:write`.
 *
 * A write is checked, sanitised, rendered and scanned as an edit in the editor
 * is. Its result lists what the content check found; a block with an error is
 * refused with a `ValidationError` (reason `invalid_content`) whose
 * `data.issues` names each block at fault.
 */
export class TransactionalEmailsResource extends BaseResource {
	/**
	 * List the transactional emails, oldest first, a page at a time, without
	 * their content. Pass `cursor` from the previous page's
	 * `pagination.cursor`, and stop once `pagination.isDone` is true.
	 *
	 * @example
	 * ```typescript
	 * const { data: emails } = await owlat.transactionalEmails.list({ limit: 100 });
	 * ```
	 */
	async list(
		params?: ListTemplatesParams
	): Promise<CursorPaginatedResponse<TransactionalEmailSummary>> {
		const searchParams = new URLSearchParams();
		if (params?.limit) searchParams.set('limit', String(params.limit));
		if (params?.cursor) searchParams.set('cursor', params.cursor);
		const queryString = searchParams.toString();
		const response = await this.http.get<CursorPaginatedResponse<TransactionalEmailSummary>>(
			queryString ? `${BASE_PATH}?${queryString}` : BASE_PATH
		);
		return response.data;
	}

	/**
	 * Get a transactional email by slug, with its blocks, translations and
	 * variable schema. {@link upsert} accepts the result as it is, so this is
	 * also the export.
	 *
	 * @throws {NotFoundError} If no email has the slug
	 */
	async get(slug: string): Promise<TransactionalEmail> {
		const response = await this.http.get<ApiResponse<TransactionalEmail>>(emailPath(slug));
		return response.data.data;
	}

	/**
	 * Create a transactional email as a draft.
	 *
	 * @throws {ConflictError} If another email has the slug (reason `slug_taken`)
	 * @throws {ValidationError} If a block has an error (reason `invalid_content`)
	 */
	async create(params: CreateTransactionalEmailRequest): Promise<TransactionalEmailWriteResult> {
		const response = await this.http.post<ApiResponse<TransactionalEmailWriteResult>>(
			BASE_PATH,
			params
		);
		return response.data.data;
	}

	/**
	 * Create the email with this slug, or replace its editable fields. A field
	 * left out takes its default. This is the import: the result of {@link get}
	 * is accepted as it is.
	 *
	 * @example
	 * ```typescript
	 * const email = await owlat.transactionalEmails.get('order-confirmation');
	 * const { issues } = await owlat.transactionalEmails.upsert(
	 *   'order-confirmation',
	 *   { ...email, subject: 'Your order is confirmed' },
	 *   { ifRevision: email.revision, whilePublished: true }
	 * );
	 * ```
	 *
	 * @throws {ConflictError} If `ifRevision` is no longer current (reason `revision_mismatch`)
	 * @throws {InvalidStateError} If the email is published and `whilePublished` is not set
	 */
	async upsert(
		slug: string,
		params: PutTransactionalEmailRequest,
		options?: TransactionalEmailWriteOptions
	): Promise<TransactionalEmailWriteResult> {
		const path = options?.whilePublished
			? `${emailPath(slug)}?whilePublished=true`
			: emailPath(slug);
		const response = await this.http.put<ApiResponse<TransactionalEmailWriteResult>>(
			path,
			params,
			undefined,
			revisionHeader(options?.ifRevision)
		);
		return response.data.data;
	}

	/**
	 * Publish an email so sends can use it. The content scan runs first:
	 * suspicious content comes back as `pending_review` until an admin
	 * approves it, blocked content is refused (reason `content_blocked`).
	 * Publishing a published email changes nothing.
	 */
	async publish(
		slug: string,
		options?: Pick<TransactionalEmailWriteOptions, 'ifRevision'>
	): Promise<TransactionalEmail> {
		const response = await this.http.post<ApiResponse<TransactionalEmail>>(
			`${emailPath(slug)}/publish`,
			undefined,
			undefined,
			undefined,
			revisionHeader(options?.ifRevision)
		);
		return response.data.data;
	}

	/** Return an email to draft, so sends that name it are refused. */
	async unpublish(slug: string): Promise<TransactionalEmail> {
		const response = await this.http.post<ApiResponse<TransactionalEmail>>(
			`${emailPath(slug)}/unpublish`
		);
		return response.data.data;
	}
}

function revisionHeader(revision: number | undefined): string | undefined {
	return revision === undefined ? undefined : `"${revision}"`;
}
