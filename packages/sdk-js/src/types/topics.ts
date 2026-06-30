/**
 * DOI (Double Opt-In) status for a contact.
 */
export type DoiStatus = 'not_required' | 'pending' | 'confirmed';

/**
 * Parameters for adding a contact to a topic.
 */
export interface AddToTopicParams {
	/**
	 * ID of the topic (required).
	 */
	topicId: string;

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
