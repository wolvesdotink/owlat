/**
 * Credential redaction for provider error text.
 *
 * A provider that echoes the request back inside an error body would otherwise
 * carry the API key into a stored error string or a UI message. Every adapter
 * that holds a key strips it through this one function before any text leaves
 * the adapter, so the policy (exact match, `[redacted]` marker, empty key is a
 * no-op) is decided here and not by whichever adapter a new one is copied from.
 *
 * No Convex imports: both V8 modules and `'use node'` actions import it.
 */
export function withoutApiKey(text: string, apiKey: string): string {
	return apiKey.length > 0 ? text.split(apiKey).join('[redacted]') : text;
}
