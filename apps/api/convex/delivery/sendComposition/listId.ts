/**
 * Send composition (module) — List-Id leaf (RFC 2919).
 *
 * Single V8-pure builder for the RFC 2919 `List-Id` header, identifying the
 * mailing list a topic campaign was sent on behalf of. Until now Owlat only
 * READ `List-Id` inbound (anti-loop classification) and never STAMPED it
 * outbound, even though every topic has a stable id + name — so receiving
 * MTAs, mailbox filters, and the recipient's "unsubscribe from this list"
 * client affordances had no stable list handle to key on.
 *
 * RFC 2919 grammar (the relevant productions):
 *
 *   List-Id      = "List-Id:" [phrase] "<" list-id ">" CRLF
 *   list-id      = list-label "." list-id-namespace
 *   list-label   = dot-atom-text          ; RFC 2822 §3.2.4
 *   list-id-namespace = domain-name       ; the sending domain
 *
 * - The bracketed `list-id` is a globally-unique, immutable handle. We derive
 *   it as `topic-<topicId>.<sending-domain>` so it stays stable across the
 *   life of the topic and is unique per deployment domain.
 * - `dot-atom-text` permits ALETTERs/DIGITs and a restricted punctuation set
 *   (`!#$%&'*+-/=?^_\`{|}~`) plus interior dots — crucially NO spaces and no
 *   leading/trailing/consecutive dots. The builder sanitizes the topic id and
 *   the domain into this form so the emitted handle is always well-formed.
 * - The optional leading `phrase` is the human-readable list description (the
 *   topic name). RFC 2822 phrases that contain specials must be a quoted
 *   string; we emit the topic name as a `quoted-string` so arbitrary names
 *   (commas, brackets, …) never break the grammar or inject extra tokens.
 *
 * The builder is V8-pure (no `node:crypto`) so the composers stay runnable
 * from the Convex V8 runtime, mirroring `feedbackId.ts` / `trackingUrl.ts`.
 */

export type BuildListIdInput = {
	/** The sending domain (host part of the From address, e.g. `mail.acme.com`). */
	domain: string;
	/** The topic this campaign targets — its stable id + display name. */
	topic: { id: string; name: string };
};

/**
 * Lower-case, strip a leading user part / scheme + any port or path, and
 * reduce the domain to a bare dot-atom host: keep only host-legal chars
 * (`a-z0-9.-`), collapse runs of dots, and trim leading/trailing dots/hyphens.
 * Returns the empty string when nothing host-legal survives (the caller treats
 * that as "no domain anchor" and emits no header).
 */
function sanitizeDomain(domain: string): string {
	const host = domain
		.trim()
		.toLowerCase()
		// Drop anything before an `@` (a full address was passed) and any
		// path/port (`:`/`/`) after the host.
		.replace(/^.*@/, '')
		.replace(/[:/].*$/, '')
		// Strip surrounding angle brackets if a `<addr>` form leaked in.
		.replace(/[<>]/g, '');
	return host
		.replace(/[^a-z0-9.-]/g, '')
		.replace(/\.{2,}/g, '.')
		.replace(/^[.-]+|[.-]+$/g, '');
}

/**
 * Reduce the topic id to a `dot-atom-text`-safe label segment: keep only the
 * dot-atom-permitted character class, collapse dot runs, trim boundary dots.
 * Topic ids are Convex document ids (already `[a-z0-9]+`-ish) but this keeps
 * the builder total for any id shape.
 */
function sanitizeLabel(id: string): string {
	return id
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9!#$%&'*+/=?^_`{|}~-]/g, '')
		.replace(/\.{2,}/g, '.')
		.replace(/^[.-]+|[.-]+$/g, '');
}

/**
 * Render the topic name as an RFC 2822 `quoted-string` for the leading phrase.
 * Control chars (incl. CR/LF, which would split the header) are reduced to
 * spaces, internal whitespace runs collapse to a single space, and backslashes
 * + double-quotes are escaped. Returns `undefined` for an empty name so the
 * header is emitted without a leading phrase (still valid per the grammar).
 */
function quotePhrase(name: string): string | undefined {
	let collapsed = '';
	let lastWasSpace = false;
	for (const ch of name) {
		const code = ch.codePointAt(0) ?? 0;
		// Treat ASCII controls (<= 0x1F), DEL (0x7F), and any whitespace as a
		// single collapsing space — this also neutralizes CR/LF header injection.
		const isControlOrSpace = code <= 0x1f || code === 0x7f || /\s/.test(ch);
		if (isControlOrSpace) {
			if (!lastWasSpace && collapsed.length > 0) {
				collapsed += ' ';
				lastWasSpace = true;
			}
			continue;
		}
		collapsed += ch;
		lastWasSpace = false;
	}
	const cleaned = collapsed.trim();
	if (cleaned.length === 0) {
		return undefined;
	}
	const escaped = cleaned.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	return `"${escaped}"`;
}

/**
 * Build the RFC 2919 `List-Id` header VALUE for a topic campaign, or `null`
 * when no well-formed list-id can be produced (no sanitizable id or domain).
 * On `null` the composer omits the header entirely rather than emit a broken
 * one.
 *
 * Shape: `"Topic Name" <topic-<id>.<sending-domain>>` — the bracketed handle
 * is a dot-atom list-label (`topic-<id>`) joined by a dot to the dot-atom
 * sending domain, with the topic name as an optional quoted phrase prefix.
 */
export function getListIdHeader(input: BuildListIdInput): string | null {
	const label = sanitizeLabel(input.topic.id);
	const domain = sanitizeDomain(input.domain);
	if (label.length === 0 || domain.length === 0) {
		return null;
	}

	const listId = `<topic-${label}.${domain}>`;
	const phrase = quotePhrase(input.topic.name);
	return phrase ? `${phrase} ${listId}` : listId;
}
