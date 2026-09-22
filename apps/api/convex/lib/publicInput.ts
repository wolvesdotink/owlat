import { throwInvalidInput } from '../_utils/errors';

/**
 * Compatibility ceiling for strings without a tighter domain limit. Checked
 * by every public write builder, including nested arrays/objects and v.any().
 * Measured in UTF-16 code units, like validateStringLength and HTML maxlength.
 * Large binary/file content belongs in storage, not public function arguments.
 */
export const PUBLIC_STRING_MAX_CHARS = 1024 * 1024;

export function validatePublicInputStrings(value: unknown): void {
	const pending: unknown[] = [value];
	while (pending.length) {
		const current = pending.pop();
		if (typeof current === 'string') {
			if (current.length > PUBLIC_STRING_MAX_CHARS) {
				throwInvalidInput(`Text fields must be at most ${PUBLIC_STRING_MAX_CHARS} characters`);
			}
		} else if (Array.isArray(current)) {
			for (const entry of current) pending.push(entry);
		} else if (
			current !== null &&
			typeof current === 'object' &&
			!(current instanceof ArrayBuffer)
		) {
			for (const [key, entry] of Object.entries(current)) {
				pending.push(key, entry);
			}
		}
	}
}
