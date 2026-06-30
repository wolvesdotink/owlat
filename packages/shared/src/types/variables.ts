/**
 * Unified variable interface for both marketing and transactional emails
 */
export interface Variable {
	/** Unique key for the variable */
	key: string;
	/** Display label for the variable */
	label: string;
	/** Optional group for categorizing variables (e.g., "Contact Fields", "Data Variables") */
	group?: string;
	/** Optional type for display purposes (e.g., "string", "number") */
	type?: string;
	/** Whether this is a built-in variable */
	isBuiltIn?: boolean;
}

/**
 * Variable type determines which TipTap extension is used
 */
export type VariableType = 'personalization' | 'data';
