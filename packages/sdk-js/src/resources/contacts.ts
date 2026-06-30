import { BaseResource } from './base';
import type {
	Contact,
	CreateContactParams,
	UpdateContactParams,
	DeleteContactResponse,
} from '../types/contacts';
import type { ApiResponse, PaginatedResponse, PaginationParams } from '../types/common';

/**
 * Resource for managing contacts.
 */
export class ContactsResource extends BaseResource {
	/**
	 * Create a new contact.
	 *
	 * @param params - Contact creation parameters
	 * @returns The created contact
	 * @throws {ValidationError} If email is invalid
	 * @throws {ConflictError} If a contact with this email already exists
	 *
	 * @example
	 * ```typescript
	 * const contact = await owlat.contacts.create({
	 *   email: 'user@example.com',
	 *   firstName: 'John',
	 *   lastName: 'Doe',
	 * });
	 * console.log(contact.id);
	 * ```
	 */
	async create(params: CreateContactParams): Promise<Contact> {
		const response = await this.http.post<ApiResponse<Contact>>(
			'/api/v1/contacts',
			params
		);
		return response.data.data;
	}

	/**
	 * Get a contact by ID or email.
	 *
	 * @param idOrEmail - Contact ID or email address
	 * @returns The contact
	 * @throws {NotFoundError} If the contact is not found
	 *
	 * @example
	 * ```typescript
	 * // By ID
	 * const contact = await owlat.contacts.get('contact_123');
	 *
	 * // By email
	 * const contact = await owlat.contacts.get('user@example.com');
	 * ```
	 */
	async get(idOrEmail: string): Promise<Contact> {
		const encoded = encodeURIComponent(idOrEmail);
		const response = await this.http.get<ApiResponse<Contact>>(
			`/api/v1/contacts/${encoded}`
		);
		return response.data.data;
	}

	/**
	 * Update a contact.
	 *
	 * @param idOrEmail - Contact ID or email address
	 * @param params - Fields to update
	 * @returns The updated contact
	 * @throws {NotFoundError} If the contact is not found
	 * @throws {ConflictError} If updating email to one that already exists
	 *
	 * @example
	 * ```typescript
	 * const contact = await owlat.contacts.update('user@example.com', {
	 *   firstName: 'Jane',
	 * });
	 * ```
	 */
	async update(idOrEmail: string, params: UpdateContactParams): Promise<Contact> {
		const encoded = encodeURIComponent(idOrEmail);
		const response = await this.http.put<ApiResponse<Contact>>(
			`/api/v1/contacts/${encoded}`,
			params
		);
		return response.data.data;
	}

	/**
	 * Delete a contact.
	 *
	 * @param idOrEmail - Contact ID or email address
	 * @returns Deletion confirmation
	 * @throws {NotFoundError} If the contact is not found
	 *
	 * @example
	 * ```typescript
	 * await owlat.contacts.delete('user@example.com');
	 * ```
	 */
	async delete(idOrEmail: string): Promise<DeleteContactResponse> {
		const encoded = encodeURIComponent(idOrEmail);
		const response = await this.http.delete<ApiResponse<DeleteContactResponse>>(
			`/api/v1/contacts/${encoded}`
		);
		return response.data.data;
	}

	/**
	 * List contacts with cursor-based pagination and optional search.
	 *
	 * Pagination is cursor-based: pass `cursor` from the previous response's
	 * `pagination.cursor` to fetch the next page, and stop once
	 * `pagination.isDone` is true. There is no row ceiling — every contact is
	 * reachable. For iterating every page automatically, use {@link listAll}.
	 *
	 * @param params - Pagination and search options
	 * @returns One page of contacts plus cursor metadata
	 *
	 * @example
	 * ```typescript
	 * // Get the first page
	 * const page = await owlat.contacts.list({ limit: 25 });
	 * console.log(page.data); // Array of contacts
	 * console.log(page.pagination.totalItems);
	 *
	 * // Fetch the next page
	 * if (!page.pagination.isDone) {
	 *   const next = await owlat.contacts.list({ cursor: page.pagination.cursor });
	 * }
	 *
	 * // Search contacts (relevance-ordered)
	 * const results = await owlat.contacts.list({ search: 'john' });
	 * ```
	 */
	async list(params?: PaginationParams): Promise<PaginatedResponse<Contact>> {
		const searchParams = new URLSearchParams();

		if (params?.limit) searchParams.set('limit', String(params.limit));
		if (params?.cursor) searchParams.set('cursor', params.cursor);
		if (params?.search) searchParams.set('search', params.search);

		const queryString = searchParams.toString();
		const path = queryString ? `/api/v1/contacts?${queryString}` : '/api/v1/contacts';

		const response = await this.http.get<PaginatedResponse<Contact>>(path);
		return response.data;
	}

	/**
	 * Asynchronously iterate over every contact, following cursors until the
	 * server reports `isDone`. Yields contacts one at a time so callers never
	 * hold the full set in memory.
	 *
	 * @param params - Page size (`limit`) and optional `search`; any `cursor` is
	 *   ignored (iteration always starts from the beginning)
	 *
	 * @example
	 * ```typescript
	 * for await (const contact of owlat.contacts.listAll({ search: 'john' })) {
	 *   console.log(contact.email);
	 * }
	 * ```
	 */
	async *listAll(
		params?: Omit<PaginationParams, 'cursor'>
	): AsyncGenerator<Contact, void, unknown> {
		let cursor: string | null = null;
		do {
			const page = await this.list({ ...params, cursor });
			for (const contact of page.data) {
				yield contact;
			}
			cursor = page.pagination.isDone ? null : page.pagination.cursor;
		} while (cursor !== null);
	}
}
