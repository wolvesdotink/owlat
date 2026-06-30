/**
 * DKIM key management + outbound signing for nodemailer
 *
 * Resolves per-domain DKIM private keys from the Redis-backed store and
 * produces a hardened, RFC 6376 conformant `DKIM-Signature` for an outbound
 * RFC822 message.
 *
 * ## Why a custom signer instead of nodemailer's built-in DKIM?
 *
 * nodemailer's bundled signer (lib/dkim/sign.js) has two defense-in-depth gaps:
 *
 *   1. It signs each header exactly once and offers no way to *oversign*
 *      (it de-duplicates the `h=` list through a Set). Oversigning lists a
 *      header in `h=` MORE times than it occurs so a verifier treats the extra
 *      slot as a "null" header. An attacker who prepends a SECOND `From:`
 *      (or `Subject:` / `To:`) after we sign then changes the displayed header
 *      a DMARC-aware verifier evaluates while the original signature still
 *      covers cryptographically valid bytes — the classic header-injection /
 *      "replay with a forged From" attack. Oversigning From/Subject/To closes
 *      it: adding a header instance breaks the signature. (RFC 6376 §8.15,
 *      M3AAWG "Email Authentication Best Common Practices" — oversigning.)
 *
 *   2. It emits no `t=` signature timestamp (RFC 6376 §3.5). `t=` records when
 *      the signature was created and lets verifiers reason about freshness /
 *      replay windows; many large receivers expect it.
 *
 * We delegate every byte of canonicalization, body hashing, key parsing and
 * signature-line formatting to `mailauth` — the same library
 * `bounce/inboundDkim.ts` already trusts for *verification* — and add only the
 * thin oversigning + `t=` layer on top. This keeps signer and verifier on the
 * identical relaxed/relaxed codec so what we sign is exactly what a receiver
 * (and our own `dkimVerify`) will recompute.
 */

import type Redis from 'ioredis';
import { createSign } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { buffer as consumeBuffer } from 'node:stream/consumers';
import { getDkimConfig } from './dkimStore.js';
import { logger } from '../monitoring/logger.js';
import {
	parseHeaders,
	formatRelaxedLine,
	formatSignatureHeaderLine,
	getPrivateKey,
} from 'mailauth/lib/tools.js';
import { dkimBody } from 'mailauth/lib/dkim/body/index.js';

/** Resolved per-domain signing material. */
export interface DkimSigningKey {
	readonly domainName: string;
	readonly keySelector: string;
	readonly privateKey: string;
}

/**
 * Headers we sign when present (relaxed/relaxed). Mirrors nodemailer's default
 * RFC 4871 §5.5 set, trimmed to the headers Owlat actually emits, plus the
 * List-Unsubscribe PAIR so one-click unsubscribe stays integrity-protected.
 *
 * `list-unsubscribe-post` is deliberately listed alongside `list-unsubscribe`:
 * nodemailer's built-in DKIM signer (`defaultFieldNames`) covers
 * List-Unsubscribe but NOT List-Unsubscribe-Post, so a verifier sees the
 * one-click POST directive as untrusted and Gmail suppresses the one-click
 * unsubscribe button. RFC 8058 §5.2 requires BOTH headers to be under the same
 * DKIM signature whose d= aligns with From. Keep both entries — dropping the
 * `-post` one re-introduces the Gmail 2024 bulk-sender failure. (See PR-16; the
 * regression-lock is `__tests__/dkimSign.e2e.test.ts` "PR-16".)
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
 * Build nodemailer DKIM options for a given sending domain.
 * Returns undefined if no DKIM key is configured for the domain.
 *
 * The shape matches nodemailer's transport `dkim` option for backward
 * compatibility with the connection pool key (`dkimDomain`) and any caller
 * that still reads `domainName`/`keySelector`.
 */
export async function getDkimOptions(
	redis: Redis,
	domain: string
): Promise<DkimSigningKey | undefined> {
	const key = await getDkimConfig(redis, domain.toLowerCase());
	if (!key) {
		logger.warn({ domain }, 'No DKIM key configured for domain');
		return undefined;
	}

	return {
		domainName: domain.toLowerCase(),
		keySelector: key.selector,
		privateKey: key.privateKey,
	};
}

/** Split a raw RFC822 message into its header block and body. */
function splitHeadersAndBody(raw: Buffer): { headerBuf: Buffer; bodyBuf: Buffer } {
	// Accept both CRLFCRLF and bare LFLF boundaries (defensive — nodemailer
	// emits CRLF, but a caller could hand us LF).
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

interface ParsedHeader {
	readonly key: string | null;
	readonly casedKey?: string;
	readonly line: Buffer;
}

/**
 * Produce a hardened `DKIM-Signature:` header line (no trailing CRLF) for the
 * given raw RFC822 message. Oversigns From/Subject/To and stamps `t=`.
 *
 * Returns undefined only if signing fails (e.g. an unusable private key) so the
 * caller can fail closed / fall back rather than ship a corrupt header.
 */
export function signMessage(
	raw: Buffer,
	key: DkimSigningKey,
	signTimeMs: number = Date.now()
): string | undefined {
	try {
		const { headerBuf, bodyBuf } = splitHeadersAndBody(raw);

		// Relaxed body hash via mailauth's exact canonicalizer.
		const hasher = dkimBody('relaxed', 'sha256', false) as {
			update(chunk: Buffer): void;
			digest(encoding: string): string;
		};
		hasher.update(bodyBuf);
		const bodyHash = hasher.digest('base64');

		const { parsed } = parseHeaders(headerBuf) as { parsed: ParsedHeader[] };

		// Group header instances by lowercased name, TOP-to-bottom order. RFC 6376
		// §5.4.2: when a header appears in `h=`, the verifier consumes message
		// instances from the bottom up; we consume in that same order.
		const byName = new Map<string, ParsedHeader[]>();
		for (let i = parsed.length - 1; i >= 0; i--) {
			const h = parsed[i];
			if (!h || h.key == null) continue;
			const arr = byName.get(h.key);
			if (arr) arr.push(h);
			else byName.set(h.key, [h]);
		}

		const consumed = new Map<string, number>();
		const takeNext = (name: string): ParsedHeader | undefined => {
			const arr = byName.get(name);
			const used = consumed.get(name) ?? 0;
			consumed.set(name, used + 1);
			return arr ? arr[used] : undefined;
		};

		const hKeys: string[] = [];
		const canonChunks: Buffer[] = [];

		// First the normally-signed headers that are present.
		for (const name of SIGNED_HEADERS) {
			if (!byName.has(name)) continue;
			const inst = takeNext(name);
			if (!inst) continue;
			hKeys.push(inst.casedKey ?? name);
			canonChunks.push(formatRelaxedLine(inst.line, '\r\n'));
		}

		// Then the oversign slots: list the name again. If a further instance
		// exists it is canonicalized; otherwise the slot is a "null" header
		// (nothing appended), which is exactly the RFC 6376 §5.4 oversign that
		// makes any LATER-added instance break verification.
		for (const name of OVERSIGNED_HEADERS) {
			const inst = takeNext(name);
			hKeys.push(name);
			if (inst) canonChunks.push(formatRelaxedLine(inst.line, '\r\n'));
		}

		const tags = {
			a: 'rsa-sha256',
			c: 'relaxed/relaxed',
			s: key.keySelector,
			d: key.domainName,
			h: hKeys.join(':'),
			bh: bodyHash,
			// RFC 6376 §3.5 t= signature timestamp (seconds). No x= (expiry) — an
			// outbound MTA has no basis to expire its own signatures, and an absent
			// x= is unambiguously "no expiry" (vs. a wrong x= that strands mail).
			t: Math.floor(signTimeMs / 1000),
		};

		// Canonicalize the DKIM-Signature header itself with an empty b= and sign
		// over (signed headers + that line), per RFC 6376 §3.7. We build the line
		// once with a placeholder b, blank it for the hash input, then re-emit
		// with the real signature — the same dance mailauth's own signer does.
		const placeholderLine = formatSignatureHeaderLine(
			'DKIM',
			{ b: 'a'.repeat(73), ...tags },
			true
		).toString();

		const dkimCanon = formatRelaxedLine(placeholderLine)
			.toString('binary')
			.replace(/([;:\s]+b=)[^;]+/, '$1');
		canonChunks.push(Buffer.from(dkimCanon, 'binary'));

		const canonicalizedHeader = Buffer.concat(canonChunks);
		const signature = createSign('RSA-SHA256')
			.update(canonicalizedHeader)
			.sign(getPrivateKey(key.privateKey), 'base64');

		return formatSignatureHeaderLine('DKIM', { b: signature, ...tags }, true).toString();
	} catch (err) {
		logger.error(
			{ err, domain: key.domainName, selector: key.keySelector },
			'DKIM signing failed'
		);
		return undefined;
	}
}

/**
 * Return a nodemailer `processFunc` that prepends a hardened DKIM-Signature to
 * the composed message stream. Wired through `transport.use('stream', ...)` so
 * it replaces nodemailer's built-in (non-oversigning, no-`t=`) DKIM signer.
 *
 * On any signing failure the message is passed through UNSIGNED rather than
 * corrupted — an unsigned message that fails DMARC is recoverable; a malformed
 * signature is not. The failure is logged inside `signMessage`.
 */
export function makeDkimProcessFunc(
	key: DkimSigningKey
): (input: NodeJS.ReadableStream) => NodeJS.ReadableStream {
	return (input: NodeJS.ReadableStream): NodeJS.ReadableStream => {
		const out = new PassThrough();

		// `buffer()` (node:stream/consumers) reads the whole input and tears down
		// its own listeners afterwards — so chaining many sends through one
		// transport never leaks listeners (a hand-rolled on('data')/on('end')
		// trips Node's MaxListenersExceededWarning under load).
		consumeBuffer(input)
			.then((raw) => {
				const sigLine = signMessage(raw, key);
				out.end(sigLine ? Buffer.concat([Buffer.from(sigLine + '\r\n', 'utf8'), raw]) : raw);
			})
			.catch((err: Error) => {
				out.destroy(err);
			});

		return out;
	};
}
