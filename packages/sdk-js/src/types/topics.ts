import type { AddContactToTopicRequest } from '@owlat/public-contract';

export type {
	AddToTopicResponse,
	DoiStatus,
	RemoveFromTopicResponse,
} from '@owlat/public-contract';

/**
 * Parameters for adding a contact to a topic: the topic goes in the path, the
 * contact reference in the body.
 */
export interface AddToTopicParams extends AddContactToTopicRequest {
	/**
	 * ID of the topic (required).
	 */
	topicId: string;
}

/**
 * Parameters for removing a contact from a topic.
 */
export interface RemoveFromTopicParams {
	/**
	 * ID of the topic (required).
	 */
	topicId: string;

	/**
	 * Contact's email address or ID (required).
	 */
	emailOrId: string;
}
