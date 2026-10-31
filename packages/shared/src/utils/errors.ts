import { isRecord } from './guards';

/** The human-readable message of anything a `catch` clause can receive. */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (isRecord(error) && 'message' in error) return String(error['message']);
	return String(error);
}
