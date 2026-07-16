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
// Default prefix octets assumed for a value passed to encodeHeaderValue when the
// caller does not pass an explicit prefix length (`Subject: ` = 9 octets).
const DEFAULT_HEADER_PREFIX_OCTETS = 'Subject: '.length;

/**
 * Soft fold width for an address-list header. A `To:`/`Cc:` list of many
 * recipients rendered on one physical line trivially crosses the RFC 5322
 * §2.1.1 998-octet hard cap, so the comma-separated list is folded across
 * CRLF + SP continuation lines once a line approaches this width. Folding is
 * transparent to a parser (the comma stays on the current line and the receiver
 * drops the folding white space), so the list round-trips identically.
 */
const ADDRESS_FOLD_WIDTH = 76;

export function escapeHeader(value: string): string {
	// Strip CRLF to prevent header injection
	return value.replace(/[\r\n]+/g, ' ');
}

/**
 * Fold a msg-id-list header value (`References` / `In-Reply-To`, RFC 5322
 * §3.6.4) so no physical line crosses the 998-octet hard cap.
 *
 * A long thread accumulates msg-ids and a References value of many
 * `<id@host>` tokens on one line trivially exceeds §2.1.1's 998-octet cap.
 * RFC 2047 encoded-words are forbidden in a `msg-id` context, so unlike a
 * subject this value can *only* be folded on the folding white space that
 * already separates the ids — CRLF + SP before a `<`. The receiver drops the
 * folding white space, so the id list round-trips identically.
 *
 * The value is first CRLF-stripped (injection defence — the ids are routinely
 * derived from an inbound message's Message-ID in reply flows), then the
 * whitespace-separated tokens are re-joined, breaking to a continuation line
 * whenever appending the next token against the actual `Name: ` prefix would
 * cross the cap. A single token longer than the cap (a pathological msg-id) is
 * emitted as-is — there is no interior FWS to fold on, exactly as for a
 * whitespace-free ASCII subject.
 */
export function foldMsgIdList(value: string, prefixOctets: number): string {
	const tokens = escapeHeader(value)
		.trim()
		.split(/\s+/)
		.filter((t) => t.length > 0);
	const first = tokens[0];
	if (first === undefined) return '';
	let out = first;
	let lineLen = prefixOctets + first.length;
	for (let i = 1; i < tokens.length; i++) {
		const next = tokens[i]!;
		if (lineLen + 1 + next.length > MAX_HEADER_LINE_OCTETS) {
			out += `\r\n ${next}`;
			lineLen = 1 + next.length; // leading SP + token on the continuation line
		} else {
			out += ` ${next}`;
			lineLen += 1 + next.length;
		}
	}
	return out;
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
 * The rendered line is `Name: value`, so the caller passes the actual
 * `prefixOctets` (`name.length + 2` for the `: ` separator) — `Subject: ` is
 * only the default. An ASCII value that — with its prefix — would exceed the cap
 * is routed through the same encoded-word folding as non-ASCII values. Base64
 * encoded-words are ASCII, fold with CRLF+SP, and decode back to the original
 * string, so the rendered line stays well under the limit without corrupting
 * the value (a whitespace-free 2000-char ASCII value can't be folded on FWS).
 */
export function encodeHeaderValue(
	value: string,
	prefixOctets: number = DEFAULT_HEADER_PREFIX_OCTETS
): string {
	const stripped = escapeHeader(value);
	// eslint-disable-next-line no-control-regex
	if (/^[\x00-\x7F]*$/.test(stripped)) {
		// ASCII stays verbatim unless the rendered `Name: value` line would blow the
		// 998-octet hard line limit; then fold it via encoded-words.
		if (prefixOctets + stripped.length <= MAX_HEADER_LINE_OCTETS) {
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
	const first = encoded[0];
	if (first === undefined) return '';
	// Join with ", " but fold the list onto CRLF + SP continuation lines before a
	// physical line approaches the 998-octet hard cap. A short list stays on one
	// line (byte-identical to the un-folded join); only a long recipient list
	// wraps. The comma is kept on the current line so the folded value round-trips
	// to the same address list after the receiver drops the folding white space.
	let out = first;
	let lineLen = first.length;
	for (let i = 1; i < encoded.length; i++) {
		const next = encoded[i]!;
		if (lineLen + 2 + next.length > ADDRESS_FOLD_WIDTH) {
			out += `,\r\n ${next}`;
			lineLen = 1 + next.length; // leading SP + address on the continuation line
		} else {
			out += `, ${next}`;
			lineLen += 2 + next.length;
		}
	}
	return out;
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
