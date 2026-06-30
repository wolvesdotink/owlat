/** Batch sizes for bulk operations to stay within Convex transaction limits */
export const BATCH_SIZES = {
	CONTACTS_ADD_TO_LIST: 50,
	CONTACTS_REMOVE_FROM_LIST: 50,
	CONTACTS_DELETE: 25,
} as const;

/** Standard timeouts in milliseconds */
export const TIMEOUTS = {
	TOAST_SUCCESS: 3000,
	REDIRECT_AFTER_SUCCESS: 1500,
	TEST_EMAIL_FEEDBACK: 2000,
} as const;
