/**
 * Web Key Directory (WKD) primitives — pure, Node-runtime helpers.
 *
 * WKD (draft-koch-openpgp-webkey-service) lets a client discover an address's
 * OpenPGP public key by fetching a well-known URL derived from the address.
 * We implement the DIRECT method: the key is served from the address's own
 * domain at `/.well-known/openpgpkey/hu/<zbase32(SHA-1(lowercase(localpart)))>`.
 *
 * This module is deliberately CONVEX-FREE (no `query`/`mutation`/`action`
 * exports and no `_generated` imports) so it can be unit-tested directly and
 * imported by the `'use node'` action plane without dragging the V8 query
 * runtime in. It DOES use `node:crypto` (SHA-1) and `openpgp` (armor<->binary),
 * so only Node-runtime callers may import it — never a V8 query/mutation file.
 */

import { createHash } from 'node:crypto';
import * as openpgp from 'openpgp';

/**
 * The z-base-32 alphabet (Zooko O'Whielacronx), as specified for WKD hashes.
 * NOT RFC 4648 base32 — the symbol set and ordering differ.
 */
export const ZBASE32_ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769';

/**
 * Encode raw bytes as z-base-32 (5 bits per output symbol, big-endian bit
 * order, no padding). A 20-byte SHA-1 digest yields a 32-character string.
 */
export function zbase32Encode(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const b of bytes) {
		value = (value << 8) | b;
		bits += 8;
		while (bits >= 5) {
			out += ZBASE32_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) {
		out += ZBASE32_ALPHABET[(value << (5 - bits)) & 31];
	}
	return out;
}

/**
 * The WKD hash of a mail local-part: `zbase32(SHA-1(lowercase(localpart)))`.
 * Case is folded before hashing (draft-koch), so `Joe.Doe` and `joe.doe` map to
 * the same hash. This is the `hu/<hash>` path segment.
 */
export function wkdLocalHash(localPart: string): string {
	const digest = createHash('sha1').update(localPart.toLowerCase(), 'utf8').digest();
	return zbase32Encode(new Uint8Array(digest));
}

/** Split a full email into a lowercased `{ localPart, domain }`. Throws on a malformed address. */
export function splitAddress(address: string): { localPart: string; domain: string } {
	const at = address.lastIndexOf('@');
	if (at <= 0 || at === address.length - 1) {
		throw new Error(`wkd: not a valid email address: ${address}`);
	}
	return {
		localPart: address.slice(0, at).toLowerCase(),
		domain: address.slice(at + 1).toLowerCase(),
	};
}

/** The WKD hash for a full email address (hashes the local-part only). */
export function wkdHashForAddress(address: string): string {
	return wkdLocalHash(splitAddress(address).localPart);
}

/**
 * Convert an ASCII-armored public key to the base64 of its BINARY transferable
 * form — the exact bytes a WKD `hu/<hash>` fetch returns
 * (`application/octet-stream`).
 */
export async function armoredToBinaryBase64(armoredKey: string): Promise<string> {
	const key = await openpgp.readKey({ armoredKey });
	return Buffer.from(key.write()).toString('base64');
}

/** Inverse of {@link armoredToBinaryBase64}: base64 binary key -> ASCII armor. */
export async function binaryBase64ToArmored(base64: string): Promise<string> {
	const key = await openpgp.readKey({ binaryKey: new Uint8Array(Buffer.from(base64, 'base64')) });
	return key.armor();
}
