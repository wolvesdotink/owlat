/** Batch sizes for bulk operations to stay within Convex transaction limits */
export const BATCH_SIZES = {
	CONTACTS_ADD_TO_LIST: 50,
	CONTACTS_REMOVE_FROM_LIST: 50,
	CONTACTS_DELETE: 25,
} as const;
