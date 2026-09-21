/**
 * ONE spelling of a DNS name: trimmed, lowercased, without the trailing root
 * dot, and, for internationalized names, in IDNA ASCII (punycode) form.
 *
 * The IDNA step runs through the WHATWG URL parser so the helper works in the
 * browser as well as in Node. Only non-ASCII input goes through it; ASCII input
 * is returned as-is, and input the parser rejects or does not consume whole
 * (a port, a path, userinfo) keeps its lowercased spelling so callers can still
 * compare or report it.
 */
export function normalizeDomain(domain: string | null | undefined): string {
	const normalized = (domain ?? '').trim().toLowerCase().replace(/\.$/, '');
	if (isAscii(normalized)) return normalized;
	try {
		const url = new URL(`http://${normalized}`);
		return url.href === `http://${url.hostname}/` ? url.hostname : normalized;
	} catch {
		return normalized;
	}
}

function isAscii(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		if (value.charCodeAt(index) > 0x7f) return false;
	}
	return true;
}
