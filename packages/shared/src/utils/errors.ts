import { isRecord } from './guards';

/**
 * Normalizes any value to an Error object.
 *
 * Handles:
 * - Error instances (returned as-is)
 * - Strings (wrapped in Error)
 * - Objects with message property (wrapped in Error with that message)
 * - Unknown types (wrapped with String conversion)
 */
export function normalizeError(e: unknown): Error {
	if (e instanceof Error) {
		return e;
	}

	if (typeof e === 'string') {
		return new Error(e);
	}

	if (e !== null && typeof e === 'object' && 'message' in e && typeof e.message === 'string') {
		return new Error(e.message);
	}

	return new Error(String(e));
}

/** The human-readable message of anything a `catch` clause can receive. */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (isRecord(error) && 'message' in error) return String(error['message']);
	return String(error);
}
