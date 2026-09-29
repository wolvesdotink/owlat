/**
 * Pure `mailto:` parser (RFC 6068).
 *
 * One parser for every `mailto:` Owlat reads:
 *   - the desktop app's deep link, when Owlat is the OS default mail handler
 *     and the system hands it a `mailto:` URL to open a prefilled composer;
 *   - the `mailto:` target of a received List-Unsubscribe header. That URI is
 *     attacker-controlled, so nothing here may throw, and callers must
 *     HTML-escape `subject`/`body` before embedding them in markup.
 *
 * Imports nothing and touches no DOM, so every workspace (and every Docker
 * image that copies this package's source) can use it as is.
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

/**
 * Split an RFC 6068 comma-separated address list: split on the literal commas,
 * trim each entry, drop empties.
 *
 * With `decode`, each entry is percent-decoded after the split (the raw
 * `mailto:` form, where an encoded `%2C` belongs to its address and must not
 * split it). Leave `decode` off for a list that is already decoded, such as
 * the `?to=` route query the desktop deep link hands to the compose window:
 * decoding it a second time would alter an address holding a literal `%`.
 */
export function splitMailtoAddressList(raw: string, options: { decode?: boolean } = {}): string[] {
	return raw
		.split(',')
		.map((addr) => (options.decode ? decodeComponent(addr) : addr).trim())
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
	if (path) to.push(...splitMailtoAddressList(path, { decode: true }));

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
					to.push(...splitMailtoAddressList(rawVal, { decode: true }));
					break;
				case 'cc':
					cc.push(...splitMailtoAddressList(rawVal, { decode: true }));
					break;
				case 'bcc':
					bcc.push(...splitMailtoAddressList(rawVal, { decode: true }));
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
