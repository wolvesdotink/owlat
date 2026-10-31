/**
 * Parse and check JSON text that is not a request body: a blob stored in a
 * string column, a decrypted credential, a provider's reply.
 *
 * `decodeJsonText` answers in the shape an HTTP transport needs (a status and a
 * client message); a reader of stored or fetched JSON needs only the verdict
 * and, for its log line, where the value failed. The issue is a path built from
 * the checker, never from the text, so it is safe to log next to a secret.
 */

import {
	decodeJsonText,
	type Checked,
	type Decoded,
	type JsonChecker,
} from '@owlat/worker-protocol/decodeJson';

export function decodeJsonString<C extends JsonChecker>(
	json: string,
	checker: C
): Decoded<Checked<C>> {
	const decoded = decodeJsonText(json, checker);
	if (decoded.ok) return decoded;
	return {
		ok: false,
		issue: decoded.failure.kind === 'invalid' ? decoded.failure.issue : '$: not valid JSON',
	};
}
