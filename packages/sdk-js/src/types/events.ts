/**
 * Parameters for sending an event.
 */
export interface SendEventParams {
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
	 * These can be used in automation conditions.
	 */
	eventProperties?: Record<string, unknown>;

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
