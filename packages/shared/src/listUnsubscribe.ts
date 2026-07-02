/**
 * List-Unsubscribe (RFC 2369) / List-Unsubscribe-Post (RFC 8058) parsing for
 * the Postbox "Unsubscribe" chip.
 *
 * Pure and isolate-safe (no Node APIs): parsed ONCE at ingest inside the
 * Convex delivery actions and stored on the `mailMessages` row as a small
 * `{ httpUrl?, mailtoUrl?, oneClick }` object, so the reader never has to
 * re-open the raw .eml just to know whether the chip should render.
 *
 * Also home to the SSRF guard for the server-side One-Click POST — the header
 * value is attacker-controlled inbound mail, so the URL must be validated
 * before the backend ever fetches it.
 */

export interface ListUnsubscribeTarget {
	/** First https:// URI in the List-Unsubscribe header (http:// is ignored). */
	httpUrl?: string;
	/** First mailto: URI in the List-Unsubscribe header. */
	mailtoUrl?: string;
	/**
	 * RFC 8058 One-Click: `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
	 * is present AND the header carries an https URL. When true the client may
	 * offer a server-side POST instead of opening the URL in a tab.
	 */
	oneClick: boolean;
}

/**
 * Parse the two headers' VALUES into an unsubscribe target.
 *
 * `List-Unsubscribe` is a comma-separated list of `<URI>` entries, optionally
 * interleaved with RFC 5322 comments. The first https URL and the first
 * mailto URI win. Returns null when the header is absent or carries no
 * usable URI (malformed, or only schemes we don't act on — e.g. http://,
 * which we refuse to send users to for an unsubscribe).
 */
export function parseListUnsubscribe(
	listUnsubscribe: string | undefined | null,
	listUnsubscribePost?: string | undefined | null,
): ListUnsubscribeTarget | null {
	if (!listUnsubscribe) return null;

	let httpUrl: string | undefined;
	let mailtoUrl: string | undefined;
	for (const match of listUnsubscribe.matchAll(/<([^>]+)>/g)) {
		const uri = match[1]?.trim();
		if (!uri) continue;
		if (!httpUrl && /^https:\/\//i.test(uri)) httpUrl = uri;
		else if (!mailtoUrl && /^mailto:/i.test(uri)) mailtoUrl = uri;
	}
	if (!httpUrl && !mailtoUrl) return null;

	// RFC 8058 §3.1: the POST header's value is exactly the pair
	// `List-Unsubscribe=One-Click`; One-Click only applies to the https URI.
	const oneClick =
		!!httpUrl && !!listUnsubscribePost && /list-unsubscribe\s*=\s*one-click/i.test(listUnsubscribePost);

	return { httpUrl, mailtoUrl, oneClick };
}

/**
 * Extract + parse the unsubscribe headers straight from a raw RFC 822 message
 * (or just its leading bytes — only the top header block is read). Unfolds
 * folded header lines; first occurrence of each header wins (RFC 5322
 * singleton semantics). Mirrors `extractAntiLoopHeaders` in the API's
 * inbound-classification helper.
 */
export function extractListUnsubscribe(rawEml: string): ListUnsubscribeTarget | null {
	const headerBlock = rawEml.split(/\r?\n\r?\n/, 1)[0] ?? '';
	const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
	let listUnsubscribe: string | undefined;
	let listUnsubscribePost: string | undefined;
	for (const line of unfolded.split(/\r?\n/)) {
		const idx = line.indexOf(':');
		if (idx <= 0) continue;
		const name = line.slice(0, idx).trim().toLowerCase();
		if (name === 'list-unsubscribe' && listUnsubscribe === undefined) {
			listUnsubscribe = line.slice(idx + 1).trim();
		} else if (name === 'list-unsubscribe-post' && listUnsubscribePost === undefined) {
			listUnsubscribePost = line.slice(idx + 1).trim();
		}
	}
	return parseListUnsubscribe(listUnsubscribe, listUnsubscribePost);
}

/** Dotted-quad IPv4 literal (each octet 0-255 is checked by the caller). */
const IPV4_LITERAL = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * SSRF guard for the server-side One-Click POST. The URL comes from an
 * attacker-controlled mail header, so before the backend fetches it we
 * require:
 *
 *   - https scheme (RFC 8058 mandates https for One-Click anyway);
 *   - no embedded credentials (`https://user:pass@host` smuggling);
 *   - a real DNS hostname — ANY IP-literal host (IPv4 or IPv6, private OR
 *     public) is rejected. Legitimate unsubscribe endpoints never live on a
 *     raw IP, and rejecting the whole class is far safer than enumerating
 *     private ranges;
 *   - not a local/internal name (localhost, *.localhost, *.local,
 *     *.internal, single-label hostnames).
 *
 * NOTE: this validates the URL as written; it does not resolve DNS, so a
 * public hostname pointing at an internal IP (DNS rebinding) is out of scope
 * here — the POST is fire-and-forget with a bounded timeout and its response
 * body is never surfaced to the client, which bounds that residual risk.
 */
export function isSafeUnsubscribeUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== 'https:') return false;
	if (parsed.username !== '' || parsed.password !== '') return false;

	const host = parsed.hostname.toLowerCase();
	if (host === '') return false;

	// IPv6 literal (URL keeps the brackets on hostname) — reject outright.
	if (host.startsWith('[') || host.includes(':')) return false;

	// IPv4 literal — reject outright (private or public).
	const v4 = host.match(IPV4_LITERAL);
	if (v4) {
		const octets = v4.slice(1).map(Number);
		if (octets.every((o) => o >= 0 && o <= 255)) return false;
		// Not actually a valid IPv4 → falls through to hostname rules below.
	}

	// Local / internal names.
	if (host === 'localhost' || host.endsWith('.localhost')) return false;
	if (host.endsWith('.local') || host.endsWith('.internal')) return false;
	// Single-label hostnames (`https://intranet/`) only resolve on internal
	// resolvers — nothing on the public internet unsubscribes there.
	if (!host.includes('.')) return false;

	return true;
}
