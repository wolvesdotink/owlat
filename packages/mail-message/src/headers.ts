/**
 * RFC 5322 / RFC 2047 header value encoding.
 *
 * Pure functions: given plain strings they return the exact header-value bytes
 * to place after `Header: `. No `ctx`, db, network, or `await`. Deterministic
 * w.r.t. their inputs — the message composer relies on byte-stable output.
 */

/**
 * RFC 2047 §2 caps a single encoded-word at 75 octets *including* the
 * `=?UTF-8?B?` … `?=` delimiters, and RFC 5322 §2.2.3 caps a header line at
 * 998 octets. Anything that would cross either bound is folded across multiple
 * encoded-words joined by CRLF + SP.
 */
const MAX_HEADER_LINE_OCTETS = 998;
// Worst-case prefix for a value passed to encodeHeaderValue (`Subject: `).
const HEADER_PREFIX_OCTETS = 'Subject: '.length;

export function escapeHeader(value: string): string {
	// Strip CRLF to prevent header injection
	return value.replace(/[\r\n]+/g, ' ');
}

/**
 * RFC 2047 encoded-word for a header value that may contain non-ASCII
 * characters. Plain-ASCII strings round-trip unchanged so most subjects
 * stay readable on the wire.
 *
 * For non-ASCII values the text is emitted as one or more base64 encoded-words.
 * RFC 2047 §2 caps a single encoded-word at 75 octets *including* the
 * `=?UTF-8?B?` … `?=` delimiters, and RFC 5322 §2.2.3 caps a header line at
 * 998 octets (78 SHOULD). A single encoded-word for a long subject blows both
 * limits, so we chunk the UTF-8 payload onto multiple encoded-words and fold
 * the header with CRLF + SP between them (a "folding white space" per RFC 5322
 * §2.2.3). A receiver concatenates adjacent encoded-words, dropping the
 * intervening whitespace, so the original value round-trips exactly.
 *
 * Chunking happens on whole UTF-8 characters so a multi-byte codepoint is never
 * split across two encoded-words (which RFC 2047 §5 forbids — each encoded-word
 * must decode independently).
 *
 * A pure-ASCII value is normally left verbatim so the subject stays readable on
 * the wire, but RFC 5322 §2.1.1 still caps a physical header line at 998 octets.
 * The longest header prefix that routes through this helper is `Subject: `
 * (9 octets), so an ASCII value that — with that prefix — would exceed the cap
 * is routed through the same encoded-word folding as non-ASCII values. Base64
 * encoded-words are ASCII, fold with CRLF+SP, and decode back to the original
 * string, so the rendered line stays well under the limit without corrupting
 * the value (a whitespace-free 2000-char ASCII subject can't be folded on FWS).
 */
export function encodeHeaderValue(value: string): string {
	const stripped = escapeHeader(value);
	// eslint-disable-next-line no-control-regex
	if (/^[\x00-\x7F]*$/.test(stripped)) {
		// ASCII stays verbatim unless the rendered `Header: value` line would blow
		// the 998-octet hard line limit; then fold it via encoded-words.
		if (HEADER_PREFIX_OCTETS + stripped.length <= MAX_HEADER_LINE_OCTETS) {
			return stripped;
		}
	}
	return encodeWords(stripped).join('\r\n ');
}

/**
 * Build the list of RFC 2047 base64 encoded-words for a non-ASCII string, each
 * <=75 octets including delimiters. Returned un-folded so callers can join them
 * with whatever folding white space their header position requires.
 */
function encodeWords(text: string): string[] {
	const prefix = '=?UTF-8?B?';
	const suffix = '?=';
	// Octets available for base64 payload inside one <=75-octet encoded-word.
	const maxB64 = 75 - prefix.length - suffix.length;
	// Base64 emits 4 chars per 3 source octets; keep the source chunk a multiple
	// of 3 octets so each encoded-word's base64 is unpadded-until-the-last and
	// never overflows maxB64.
	const maxSrcBytes = Math.floor(maxB64 / 4) * 3;

	const words: string[] = [];
	let chunkBytes = 0;
	let chunk = '';
	const flush = () => {
		if (chunk.length === 0) return;
		words.push(`${prefix}${Buffer.from(chunk, 'utf-8').toString('base64')}${suffix}`);
		chunk = '';
		chunkBytes = 0;
	};
	// Iterate by codepoint (the spread operator splits on full Unicode chars, so
	// surrogate pairs and combining sequences stay whole within a word).
	for (const ch of text) {
		const chBytes = Buffer.byteLength(ch, 'utf-8');
		if (chunkBytes + chBytes > maxSrcBytes) flush();
		chunk += ch;
		chunkBytes += chBytes;
	}
	flush();
	return words;
}

/**
 * Encode an address-list header value (From / To / Cc) per RFC 5322 §3.4.
 *
 * Each address may be a bare `addr-spec` (`m@x.test`) or a `name-addr`
 * (`Display Name <m@x.test>`). The addr-spec is left literal — encoding it as a
 * 2047 word would make it unroutable — while a non-ASCII display-name phrase is
 * RFC-2047 encoded (RFC 2047 §5 allows encoded-words in a `phrase`). ASCII
 * phrases pass through unchanged.
 */
export function encodeAddressHeader(addresses: string[]): string {
	const encoded: string[] = [];
	for (const raw of addresses) {
		const one = encodeSingleAddress(escapeHeader(raw));
		if (one.length > 0) encoded.push(one);
	}
	return encoded.join(', ');
}

function encodeSingleAddress(addr: string): string {
	const trimmed = addr.trim();
	if (trimmed.length === 0) return '';
	// `name-addr` form: `phrase <addr-spec>`. Split on the last '<' so a '<' in
	// the display name doesn't confuse the parse (display names are rare to
	// contain one, but be defensive).
	const lt = trimmed.lastIndexOf('<');
	const gt = trimmed.lastIndexOf('>');
	if (lt > 0 && gt > lt) {
		const phrase = trimmed.slice(0, lt).trim();
		const addrSpec = trimmed.slice(lt, gt + 1); // includes the angle brackets
		const encodedPhrase = encodePhrase(phrase);
		return encodedPhrase ? `${encodedPhrase} ${addrSpec}` : addrSpec;
	}
	// Bare addr-spec (no display name) — leave literal.
	return trimmed;
}

function encodePhrase(phrase: string): string {
	// eslint-disable-next-line no-control-regex
	if (/^[\x00-\x7F]*$/.test(phrase)) {
		// ASCII phrase: keep readable. (Surrounding quotes, if any, are preserved
		// as the composer wrote them.)
		return phrase;
	}
	return encodeWords(phrase).join('\r\n ');
}

/** Filenames in `Content-Disposition: …; filename="…"` — strip CRLF, quotes, control chars. */
export function safeAttachmentFilename(name: string): string {
	// eslint-disable-next-line no-control-regex
	return name.replace(/[\r\n\x00-\x1F\x7F"]/g, '_');
}
