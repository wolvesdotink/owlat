/**
 * Minimal type declarations for the internal `mailauth` modules we reuse for
 * outbound DKIM signing. mailauth ships top-level types (`mailauth`) and a few
 * per-module `.d.ts` (e.g. `lib/dkim/verify`, `lib/dkim/sign`) but NOT for the
 * shared `lib/tools.js` helpers or the `lib/dkim/body` hashers. We import those
 * directly in `smtp/dkim.ts` to keep our signer's canonicalization byte-for-byte
 * identical to mailauth's verifier, so we declare the small surface we use here.
 */

declare module 'mailauth/lib/tools.js' {
	import type { Buffer } from 'node:buffer';

	export interface ParsedHeaderLine {
		key: string | null;
		casedKey?: string;
		line: Buffer;
	}

	/** Parse an RFC822 header block into ordered, unfolded header lines. */
	export function parseHeaders(buf: Buffer): {
		parsed: ParsedHeaderLine[];
		original: Buffer;
	};

	/** Relaxed (RFC 6376 §3.4.1) canonicalization of a single header line. */
	export function formatRelaxedLine(line: Buffer | string, suffix?: string): Buffer;

	/** Build a folded `DKIM-Signature:`/`ARC-*:` header line from tag values. */
	export function formatSignatureHeaderLine(
		type: 'DKIM' | 'ARC' | 'AS',
		values: Record<string, string | number>,
		folded?: boolean
	): Buffer | string;

	/** Parse a PEM/DER private key into a Node KeyObject-compatible value. */
	export function getPrivateKey(key: string | Buffer): import('node:crypto').KeyObject;
}

declare module 'mailauth/lib/dkim/body/index.js' {
	import type { Buffer } from 'node:buffer';

	export interface DkimBodyHasher {
		update(chunk: Buffer): void;
		digest(encoding: string): string;
	}

	/** Construct a body-hash canonicalizer ('relaxed' or 'simple'). */
	export function dkimBody(
		canonicalization: string,
		algorithm?: string,
		maxBodyLength?: number | false
	): DkimBodyHasher;
}
