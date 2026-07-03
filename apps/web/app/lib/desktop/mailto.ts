/**
 * Pure `mailto:` parser (RFC 6068).
 *
 * Used when Owlat is the OS default mail handler and the system hands the
 * desktop app a `mailto:` URL to open a prefilled composer. Kept free of any
 * Tauri/DOM dependency so it is trivially unit-testable and reusable.
 *
 * Behaviour:
 *   - recipients may appear in the path (`mailto:a@x,b@y`) and/or as `to`
 *     query fields; they are merged, comma-split, percent-decoded and trimmed.
 *   - `cc` / `bcc` behave the same as `to`.
 *   - `subject` / `body` are percent-decoded; the first occurrence wins.
 *   - a malformed percent-escape degrades to the raw text rather than throwing.
 *   - anything that is not a `mailto:` URL, or a `mailto:` with nothing usable
 *     to compose, returns `null` (safe empty) so callers can no-op.
 *
 * Per RFC 6068 `mailto:` uses percent-encoding, not form-encoding, so a literal
 * `+` is preserved (e.g. `list+news@x.com`) rather than turned into a space.
 */

export interface ParsedMailto {
	to: string[];
	cc: string[];
	bcc: string[];
	subject?: string;
	body?: string;
}

/** Percent-decode a single component; leave it untouched on a malformed escape. */
function decodeComponent(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

/** Split a comma-separated address list, decode + trim each, drop empties. */
function splitAddresses(raw: string): string[] {
	return raw
		.split(',')
		.map((addr) => decodeComponent(addr).trim())
		.filter((addr) => addr.length > 0);
}

export function parseMailto(uri: string): ParsedMailto | null {
	if (typeof uri !== 'string') return null;
	const match = uri.match(/^mailto:([^?]*)(?:\?(.*))?$/i);
	if (!match) return null;

	const to: string[] = [];
	const cc: string[] = [];
	const bcc: string[] = [];
	let subject: string | undefined;
	let body: string | undefined;

	const path = (match[1] ?? '').trim();
	if (path) to.push(...splitAddresses(path));

	const query = match[2] ?? '';
	if (query) {
		for (const pair of query.split('&')) {
			if (!pair) continue;
			const eq = pair.indexOf('=');
			const rawKey = eq === -1 ? pair : pair.slice(0, eq);
			const rawVal = eq === -1 ? '' : pair.slice(eq + 1);
			const key = decodeComponent(rawKey).toLowerCase();
			switch (key) {
				case 'to':
					to.push(...splitAddresses(rawVal));
					break;
				case 'cc':
					cc.push(...splitAddresses(rawVal));
					break;
				case 'bcc':
					bcc.push(...splitAddresses(rawVal));
					break;
				case 'subject':
					if (subject === undefined) subject = decodeComponent(rawVal);
					break;
				case 'body':
					if (body === undefined) body = decodeComponent(rawVal);
					break;
				default:
					break;
			}
		}
	}

	if (to.length === 0 && cc.length === 0 && bcc.length === 0 && !subject && !body) {
		return null;
	}
	return {
		to,
		cc,
		bcc,
		...(subject !== undefined ? { subject } : {}),
		...(body !== undefined ? { body } : {}),
	};
}
