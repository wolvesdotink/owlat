/**
 * Parse the `mailto:` target of a List-Unsubscribe header into compose
 * prefill values. Pure + fail-soft: the URI comes from an attacker-controlled
 * header on received mail, so nothing here may throw, and callers must
 * HTML-escape `body`/`subject` before embedding them in markup.
 */
export interface UnsubscribeMailtoPrefill {
	to: string[];
	subject?: string;
	body?: string;
}

/** decodeURIComponent that tolerates malformed percent-encoding (URIError → raw input). */
function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/** `mailto:a@x,b@y?subject=...&body=...` → compose prefill, or null if unusable. */
export function parseUnsubscribeMailto(uri: string): UnsubscribeMailtoPrefill | null {
	const match = uri.match(/^mailto:([^?]+)(?:\?(.*))?$/i);
	if (!match?.[1]) return null;
	// RFC 6068 allows multiple comma-separated recipients in the hname part.
	const to = match[1]
		.split(',')
		.map((addr) => safeDecode(addr).trim())
		.filter(Boolean);
	if (to.length === 0) return null;
	// RFC 6068 query values are percent-encoded; unlike form encoding a literal
	// '+' is a plus sign, so protect it from URLSearchParams' '+' → space rule.
	const params = new URLSearchParams((match[2] ?? '').replace(/\+/g, '%2B'));
	return {
		to,
		subject: params.get('subject') ?? undefined,
		body: params.get('body') ?? undefined,
	};
}
