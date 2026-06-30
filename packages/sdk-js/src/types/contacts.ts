/**
 * Contact resource returned by the API.
 */
export interface Contact {
	/**
	 * Unique identifier for the contact.
	 */
	id: string;

	/**
	 * Contact's email address.
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
	source: 'api' | 'import' | 'form' | 'transactional';

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
export interface CreateContactParams {
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
export interface UpdateContactParams {
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
