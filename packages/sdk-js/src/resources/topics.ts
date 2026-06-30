import { BaseResource } from './base';
import type {
	AddToTopicParams,
	RemoveFromTopicParams,
	AddToTopicResponse,
	RemoveFromTopicResponse,
} from '../types/topics';
import type { ApiResponse } from '../types/common';
import { ValidationError } from '../errors';

/**
 * Resource for managing topic memberships.
 */
export class TopicsResource extends BaseResource {
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
			throw new ValidationError(
				'Either email or contactId is required',
				'invalid_input'
			);
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
