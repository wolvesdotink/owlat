import { BaseResource } from './base';
import type {
	AddToTopicParams,
	ListTopicsParams,
	RemoveFromTopicParams,
	AddToTopicResponse,
	RemoveFromTopicResponse,
	Topic,
} from '../types/topics';
import type { ApiResponse, PaginatedResponse } from '../types/common';
import { ValidationError } from '../errors';

/**
 * Resource for listing topics and managing topic memberships.
 */
export class TopicsResource extends BaseResource {
	/**
	 * List the topics contacts can be subscribed to, oldest first, a page at a
	 * time. Each topic's `id` is the `topicId` that {@link addContact} and
	 * {@link removeContact} take. Needs the `topics:read` scope.
	 *
	 * Pass `cursor` from the previous response's `pagination.cursor` to fetch
	 * the next page, and stop once `pagination.isDone` is true.
	 *
	 * @param params - Page size and cursor
	 * @returns One page of topics plus cursor metadata
	 * @throws {ForbiddenError} If the key lacks the `topics:read` scope
	 *
	 * @example
	 * ```typescript
	 * const { data: topics } = await owlat.topics.list();
	 * const updates = topics.find((topic) => topic.name === 'Product updates');
	 * if (updates) {
	 *   await owlat.topics.addContact({ topicId: updates.id, email: 'user@example.com' });
	 * }
	 * ```
	 */
	async list(params?: ListTopicsParams): Promise<PaginatedResponse<Topic>> {
		const searchParams = new URLSearchParams();
		if (params?.limit) searchParams.set('limit', String(params.limit));
		if (params?.cursor) searchParams.set('cursor', params.cursor);
		const queryString = searchParams.toString();
		const path = queryString ? `/api/v1/topics?${queryString}` : '/api/v1/topics';
		const response = await this.http.get<PaginatedResponse<Topic>>(path);
		return response.data;
	}

	/**
	 * Add a contact to a topic.
	 *
	 * If the topic requires double opt-in (DOI) and the contact hasn't confirmed yet,
	 * a confirmation email will be sent. The contact won't receive campaign emails
	 * from DOI-required topics until they confirm.
	 *
	 * @param params - Parameters specifying the topic and contact
	 * @returns Response with membership status
	 * @throws {ValidationError} If neither email nor contactId is provided
	 * @throws {NotFoundError} If the topic or contact is not found
	 *
	 * @example
	 * ```typescript
	 * // Add by email
	 * const result = await owlat.topics.addContact({
	 *   topicId: 'topic_123',
	 *   email: 'user@example.com',
	 * });
	 *
	 * if (result.doiStatus === 'pending') {
	 *   console.log('Confirmation email sent');
	 * }
	 *
	 * // Add by contact ID
	 * const result = await owlat.topics.addContact({
	 *   topicId: 'topic_123',
	 *   contactId: 'contact_456',
	 * });
	 * ```
	 */
	async addContact(params: AddToTopicParams): Promise<AddToTopicResponse> {
		if (!params.email && !params.contactId) {
			throw new ValidationError('Either email or contactId is required', 'invalid_input');
		}

		const body: Record<string, string> = {};
		if (params.email) body['email'] = params.email;
		if (params.contactId) body['contactId'] = params.contactId;

		const response = await this.http.post<ApiResponse<AddToTopicResponse>>(
			`/api/v1/topics/${params.topicId}/contacts`,
			body
		);
		return response.data.data;
	}

	/**
	 * Remove a contact from a topic.
	 *
	 * @param params - Parameters specifying the topic and contact
	 * @returns Response indicating if contact was removed
	 * @throws {NotFoundError} If the topic or contact is not found
	 *
	 * @example
	 * ```typescript
	 * // Remove by email
	 * const result = await owlat.topics.removeContact({
	 *   topicId: 'topic_123',
	 *   emailOrId: 'user@example.com',
	 * });
	 *
	 * // Remove by contact ID
	 * const result = await owlat.topics.removeContact({
	 *   topicId: 'topic_123',
	 *   emailOrId: 'contact_456',
	 * });
	 *
	 * if (result.removed) {
	 *   console.log('Contact removed from topic');
	 * }
	 * ```
	 */
	async removeContact(params: RemoveFromTopicParams): Promise<RemoveFromTopicResponse> {
		const encoded = encodeURIComponent(params.emailOrId);
		const response = await this.http.delete<ApiResponse<RemoveFromTopicResponse>>(
			`/api/v1/topics/${params.topicId}/contacts/${encoded}`
		);
		return response.data.data;
	}
}
