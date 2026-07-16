/**
 * Outbound DKIM signing over composed message bytes (RFC 6376 / 8463 / 8601).
 *
 * `signMessage(raw, key)` produces a hardened `DKIM-Signature` and PREPENDS it
 * to the message, returning the signed wire bytes. It is the in-house
 * replacement for the MTA's `mailauth`-based signer (`apps/mta/src/smtp/dkim.ts`)
 * — same defense-in-depth posture, byte-for-byte the same output — but built on
 * the ONE shared canonicalizer instead of `mailauth`'s internals.
 *
 * ## The two hardening measures (vs a stock DKIM signer)
 *
 *   1. **Oversigning From/Subject/To** (RFC 6376 §8.15, M3AAWG). Each of these
 *      headers is listed in `h=` one MORE time than it occurs, so the extra slot
 *      is a "null" header a verifier treats as empty. An attacker who prepends a
 *      SECOND `From:` (the one a DMARC-aware verifier / MUA actually evaluates)
 *      after we sign then breaks the signature — the classic header-injection /
 *      "replay with a forged From" attack is closed.
 *
 *   2. **`t=` signature timestamp** (RFC 6376 §3.5): records when the signature
 *      was created so verifiers can reason about freshness / replay windows;
 *      many large receivers expect it. No `x=` (expiry) — an outbound MTA has no
 *      basis to expire its own signatures, and an absent `x=` is unambiguously
 *      "no expiry" (vs. a wrong `x=` that strands mail).
 *
 * ## One canon (U4)
 *
 * EVERY byte of canonicalization — relaxed body hashing, relaxed header
 * canonicalization, and blanking the signature's own `b=` before hashing —
 * comes from `@owlat/mail-auth/canon`, the single public canonicalizer the
 * inbound `verifyDkim` also consumes. Signer and verifier therefore canonicalize
 * by construction the same way: what we sign is exactly what a receiver (and our
 * own `verifyDkim`) recomputes. There is NO second canonicalization here.
 *
 * The header-block splitting, header-instance ordering and `DKIM-Signature`
 * line formatting below are message ASSEMBLY, not canonicalization; they mirror
 * `mailauth`'s `parseHeaders` / `formatSignatureHeaderLine` / `libmime.foldLines`
 * exactly so the emitted signature is byte-identical to the MTA signer's, pinned
 * by the bit-for-bit vector in `__tests__/dkim.test.ts`.
 *
 * Pure by construction: the only runtime imports are `node:crypto` and the pure
 * `@owlat/mail-auth/canon` subpath, so this module stays Convex-`'use node'`
 * safe (locked decision W1 / U4).
 */

import { createHash, createSign } from 'node:crypto';
import {
	canonicalizeBodyRelaxed,
	canonicalizeHeaderField,
	stripSignatureValue,
} from '@owlat/mail-auth/canon';

/** Resolved per-domain signing material (shape shared with the MTA signer). */
export interface DkimSigningKey {
	readonly domainName: string;
	readonly keySelector: string;
	readonly privateKey: string;
}

/**
 * Headers we sign when present (relaxed/relaxed). Mirrors the RFC 4871 §5.5
 * default set, trimmed to the headers Owlat actually emits, plus the
 * List-Unsubscribe PAIR so one-click unsubscribe stays integrity-protected.
 *
 * `list-unsubscribe-post` is deliberately listed alongside `list-unsubscribe`:
 * RFC 8058 §5.2 requires BOTH headers under the same DKIM signature whose `d=`
 * aligns with From, or Gmail suppresses the one-click unsubscribe button
 * (the 2024 bulk-sender rule). Dropping the `-post` entry re-introduces that
 * regression.
 */
const SIGNED_HEADERS: readonly string[] = [
	'from',
	'sender',
	'reply-to',
	'subject',
	'date',
	'message-id',
	'to',
	'cc',
	'mime-version',
	'content-type',
	'content-transfer-encoding',
	'list-unsubscribe',
	'list-unsubscribe-post',
];

/**
 * Headers we OVERSIGN: each gets one extra slot in `h=` beyond its occurrences
 * in the message. From/Subject/To are the DMARC- and display-critical headers
 * an attacker would re-prepend; oversigning them makes any added instance break
 * the signature. (RFC 6376 §8.15; M3AAWG oversigning.)
 */
const OVERSIGNED_HEADERS: readonly string[] = ['from', 'subject', 'to'];

/**
 * RFC 6376 §3.5 tag ordering for a `DKIM-Signature`. Mirrors `mailauth`'s
 * `keyOrderingDKIM` so the emitted tag sequence is byte-identical.
 */
const DKIM_KEY_ORDERING: readonly string[] = [
	'v',
	'a',
	'c',
	'd',
	'h',
	'i',
	'l',
	'q',
	's',
	't',
	'x',
	'z',
	'bh',
	'b',
];

/** One parsed, unfolded header field: lowercased key, original-cased key, raw bytes. */
interface ParsedHeaderLine {
	readonly key: string | null;
	readonly casedKey?: string;
	readonly line: Buffer;
}

/**
 * Split a header block into ordered, unfolded header lines. Mirrors `mailauth`'s
 * `parseHeaders`: continuation lines (starting with WSP) are folded back onto
 * their field, the field name is taken up to the first colon, and the raw bytes
 * are preserved (binary) so canonicalization sees exactly what arrived.
 */
function parseHeaderBlock(buf: Buffer): ParsedHeaderLine[] {
	const rows: string[][] = buf
		.toString('binary')
		.replace(/[\r\n]+$/, '')
		.split(/\r?\n/)
		.map((row) => [row]);

	for (let i = rows.length - 1; i >= 0; i--) {
		const cur = rows[i];
		if (i > 0 && cur && /^\s/.test(cur[0] ?? '')) {
			const prev = rows[i - 1];
			if (prev) rows[i - 1] = prev.concat(cur);
			rows.splice(i, 1);
		}
	}

	return rows.map((row) => {
		const joined = row.join('\r\n');
		const namePart = joined.match(/^[^:]+/)?.[0];
		let key: string | null = null;
		let casedKey: string | undefined;
		if (namePart !== undefined) {
			casedKey = namePart.trim();
			key = casedKey.toLowerCase();
		}
		return { key, casedKey, line: Buffer.from(joined, 'binary') };
	});
}

/** Split a raw RFC822 message into its header block and body (CRLFCRLF or LFLF). */
function splitHeadersAndBody(raw: Buffer): { headerBuf: Buffer; bodyBuf: Buffer } {
	let idx = raw.indexOf('\r\n\r\n');
	let sepLen = 4;
	if (idx === -1) {
		idx = raw.indexOf('\n\n');
		sepLen = 2;
	}
	if (idx === -1) {
		return { headerBuf: raw, bodyBuf: Buffer.alloc(0) };
	}
	return { headerBuf: raw.subarray(0, idx), bodyBuf: raw.subarray(idx + sepLen) };
}

/**
 * Fold a header line onto 76-octet physical lines at existing whitespace.
 * Faithful port of `libmime.foldLines` (afterSpace = false) so the emitted
 * `DKIM-Signature` wraps byte-identically to the MTA signer's output.
 */
function foldLines(str: string, lineLength = 76): string {
	let pos = 0;
	const len = str.length;
	let result = '';

	while (pos < len) {
		let line = str.slice(pos, pos + lineLength);
		if (line.length < lineLength) {
			result += line;
			break;
		}

		const newline = line.match(/^[^\n\r]*(?:\r?\n|\r)/)?.[0];
		if (newline !== undefined) {
			result += newline;
			pos += newline.length;
			continue;
		}

		const trailingWsp = line.match(/(\s+)[^\s]*$/)?.[0];
		if (trailingWsp !== undefined && trailingWsp.length < line.length) {
			line = line.slice(0, line.length - trailingWsp.length);
		} else {
			const nextToken = str.slice(pos + line.length).match(/^[^\s]+(\s*)/);
			const token = nextToken?.[0];
			if (token !== undefined) {
				const ws = nextToken?.[1] ?? '';
				line = line + token.slice(0, token.length - ws.length);
			}
		}

		result += line;
		pos += line.length;
		if (pos < len) {
			result += '\r\n';
		}
	}

	return result;
}

/**
 * Format a `DKIM-Signature:` header line from tag values. Mirrors `mailauth`'s
 * `formatSignatureHeaderLine('DKIM', …)`: fills the `v=1` / `q=dns/txt`
 * defaults, orders tags by {@link DKIM_KEY_ORDERING}, folds the base64 `b=`
 * value on 75-octet boundaries, then wraps the whole line via {@link foldLines}.
 *
 * `d=`/`s=` are emitted verbatim: Owlat's DKIM signing domains and selectors are
 * configured as ASCII A-labels (envelope domains are already IDN-punycoded at
 * composition, W6), so no U-label → A-label conversion is needed and none is
 * done — keeping this module free of a `punycode` dependency (W1).
 */
function formatDkimSignatureLine(values: Record<string, string | number>, folded: boolean): string {
	const merged: Record<string, string | number> = { v: 1, q: 'dns/txt', ...values };
	const body = Object.keys(merged)
		.filter((key) => merged[key] !== undefined && DKIM_KEY_ORDERING.includes(key))
		.sort((a, b) => DKIM_KEY_ORDERING.indexOf(a) - DKIM_KEY_ORDERING.indexOf(b))
		.map((key) => {
			const raw = merged[key];
			const val = raw === undefined ? '' : String(raw);
			if (key === 'b' && folded && val) {
				// Fold the signature value on 75-char boundaries (mailauth parity).
				return `${key}=${val}`.replace(/.{75}/g, '$& ').trim();
			}
			return `${key}=${val}`;
		})
		.join('; ');

	const header = `DKIM-Signature: ${body}`;
	return folded ? foldLines(header) : header;
}

/**
 * Produce a hardened `DKIM-Signature:` header line (no trailing CRLF) for the
 * given raw RFC822 message. Oversigns From/Subject/To and stamps `t=`.
 *
 * Throws if signing fails (e.g. an unusable private key) so the caller can fail
 * closed / fall back rather than ship a corrupt header — this pure module does
 * no logging; error handling belongs to the call site.
 */
export function buildDkimSignatureLine(
	raw: Buffer,
	key: DkimSigningKey,
	signTimeMs: number = Date.now()
): string {
	const { headerBuf, bodyBuf } = splitHeadersAndBody(raw);

	// Relaxed body hash via the ONE shared canonicalizer (U4).
	const bodyHash = createHash('sha256').update(canonicalizeBodyRelaxed(bodyBuf)).digest('base64');

	const parsed = parseHeaderBlock(headerBuf);

	// Group header instances by lowercased name, BOTTOM-to-top order. RFC 6376
	// §5.4.2: when a header appears in `h=`, the verifier consumes message
	// instances from the bottom up; we consume in that same order.
	const byName = new Map<string, ParsedHeaderLine[]>();
	for (let i = parsed.length - 1; i >= 0; i--) {
		const h = parsed[i];
		if (!h || h.key == null) continue;
		const arr = byName.get(h.key);
		if (arr) arr.push(h);
		else byName.set(h.key, [h]);
	}

	const consumed = new Map<string, number>();
	const takeNext = (name: string): ParsedHeaderLine | undefined => {
		const arr = byName.get(name);
		const used = consumed.get(name) ?? 0;
		consumed.set(name, used + 1);
		return arr ? arr[used] : undefined;
	};

	const hKeys: string[] = [];
	const canonChunks: Buffer[] = [];

	// Relaxed canonicalization of a single header line, CRLF-terminated (U4).
	const canonHeaderLine = (line: Buffer): Buffer =>
		Buffer.from(`${canonicalizeHeaderField(line.toString('binary'), 'relaxed')}\r\n`, 'binary');

	// First the normally-signed headers that are present.
	for (const name of SIGNED_HEADERS) {
		if (!byName.has(name)) continue;
		const inst = takeNext(name);
		if (!inst) continue;
		hKeys.push(inst.casedKey ?? name);
		canonChunks.push(canonHeaderLine(inst.line));
	}

	// Then the oversign slots: list the name again. If a further instance exists
	// it is canonicalized; otherwise the slot is a "null" header (nothing
	// appended), the RFC 6376 §5.4 oversign that breaks any LATER-added instance.
	for (const name of OVERSIGNED_HEADERS) {
		const inst = takeNext(name);
		hKeys.push(name);
		if (inst) canonChunks.push(canonHeaderLine(inst.line));
	}

	const tags: Record<string, string | number> = {
		a: 'rsa-sha256',
		c: 'relaxed/relaxed',
		s: key.keySelector,
		d: key.domainName,
		h: hKeys.join(':'),
		bh: bodyHash,
		t: Math.floor(signTimeMs / 1000),
	};

	// Canonicalize the DKIM-Signature header itself with an empty b= and sign over
	// (signed headers + that line), per RFC 6376 §3.7. Build the line once with a
	// placeholder b, canonicalize it relaxed, then blank b= via the shared canon
	// helper — the same dance mailauth's own signer does.
	const placeholderLine = formatDkimSignatureLine({ b: 'a'.repeat(73), ...tags }, true);
	const dkimCanon = stripSignatureValue(canonicalizeHeaderField(placeholderLine, 'relaxed'));
	canonChunks.push(Buffer.from(dkimCanon, 'binary'));

	const signature = createSign('RSA-SHA256')
		.update(Buffer.concat(canonChunks))
		.sign(key.privateKey, 'base64');

	return formatDkimSignatureLine({ b: signature, ...tags }, true);
}

/**
 * Sign `raw` and return the signed wire bytes: a hardened `DKIM-Signature`
 * (oversigned From/Subject/To, `t=`, relaxed/relaxed) PREPENDED to the message.
 *
 * The prepended header is byte-identical to the MTA signer's output for the same
 * inputs and verifies pass under both `mailauth` and our own `verifyDkim`.
 * Throws on signing failure (see {@link buildDkimSignatureLine}).
 */
export function signMessage(
	raw: Buffer,
	key: DkimSigningKey,
	signTimeMs: number = Date.now()
): Buffer {
	const sigLine = buildDkimSignatureLine(raw, key, signTimeMs);
	return Buffer.concat([Buffer.from(`${sigLine}\r\n`, 'utf8'), raw]);
}
