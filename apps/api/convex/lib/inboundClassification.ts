/**
 * Shared inbound-mail classification used by both the Postbox delivery hooks
 * (forwarding / vacation auto-reply) and the AI agent pipeline. Pure and
 * isolate-safe (no Node APIs) so it can be imported from a v8 mutation
 * (`inbox/messages.ts`) and a Node action (`mail/deliveryHooks.ts`) alike.
 */

/**
 * Lowercase every header key once so callers may pass either a raw header map
 * (mixed case, as parsed off the wire) or an already-normalized one. RFC 5322
 * header field names are case-insensitive.
 */
function lowerKeys(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, value] of Object.entries(headers)) out[k.toLowerCase()] = value;
	return out;
}

/**
 * RFC 3834 anti-loop / bulk-mail detection. Returns true when the message looks
 * machine-generated and must NOT trigger another machine reply (an auto-reply,
 * a forward, or — for the AI pipeline — a full guard+classify+draft+extract run
 * that could form a reply loop or be used for cost exhaustion).
 *
 *   - Auto-Submitted header, anything other than 'no' → automated mail
 *   - List-Id header → mailing-list traffic
 *   - Precedence: bulk/list/junk → bulk-mail signals
 *   - X-Owlat-Forwarded header → already touched by another Owlat mailbox
 */
export function isAutomatedMail(headers: Record<string, string>): boolean {
	const h = lowerKeys(headers);
	const norm = (s: string) => s.toLowerCase().trim();
	const autoSubmitted = h['auto-submitted'];
	if (autoSubmitted && norm(autoSubmitted) !== 'no') return true;
	if (h['list-id']) return true;
	const precedence = h['precedence'];
	if (precedence) {
		const p = norm(precedence);
		if (p === 'bulk' || p === 'list' || p === 'junk') return true;
	}
	if (h['x-owlat-forwarded']) return true;
	return false;
}

/** The only headers isAutomatedMail() consults — keep the parsed map tiny. */
const ANTI_LOOP_HEADER_NAMES = new Set(['auto-submitted', 'list-id', 'precedence', 'x-owlat-forwarded']);

/**
 * Extract just the anti-loop headers from a raw RFC 822 message. Parses only the
 * top header block (up to the first blank line), unfolds folded values, and
 * returns a lowercase-keyed map limited to the headers isAutomatedMail() needs —
 * small enough to hand to the post-delivery hook scheduler, and pure /
 * isolate-safe so it runs in the v8 ingest action without a Node MIME parser.
 */
export function extractAntiLoopHeaders(rawEml: string): Record<string, string> {
	const out: Record<string, string> = {};
	// The header block ends at the first blank line (CRLF CRLF or LF LF).
	const headerBlock = rawEml.split(/\r?\n\r?\n/, 1)[0] ?? '';
	// Unfold: a line starting with SP/HT continues the previous header value.
	const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
	for (const line of unfolded.split(/\r?\n/)) {
		const idx = line.indexOf(':');
		if (idx <= 0) continue;
		const name = line.slice(0, idx).trim().toLowerCase();
		if (!ANTI_LOOP_HEADER_NAMES.has(name)) continue;
		// First occurrence wins (RFC 5322 singleton semantics for these fields).
		if (!(name in out)) out[name] = line.slice(idx + 1).trim();
	}
	return out;
}
