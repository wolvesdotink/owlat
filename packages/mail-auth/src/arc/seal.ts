/**
 * RFC 8617 §5.1.1 ARC-Seal verification.
 *
 * Each ARC-Seal signs, under relaxed header canonicalization (the SHARED
 * `@owlat/mail-auth` canon — U4, no second implementation), every set's
 * AAR + AMS + AS in increasing instance order, the final AS having its `b=`
 * emptied and no trailing CRLF. THROWS (=> `cv: 'fail'`) on the first seal that
 * does not verify. Ed25519 seals sign the SHA-256 of the canonicalized headers
 * (RFC 8463) — this pre-hash matches the pinned `mailauth` 4.13.3, whose verify
 * also pre-hashes the ed25519 signing input.
 */

import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'crypto';
import { canonicalizeHeaderField, stripSignatureValue } from '../canon.js';
import { isKeyRecordError, parseDkimKeyRecord, type DkimKeyRecord } from '../dkim/keyRecord.js';
import type { DkimDnsResolver } from '../dkim/messageSignature.js';
import { parseSealAlgorithm, type ArcSet } from './chain.js';

/** DER SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * RFC 8301 §3.2: an RSA key shorter than 1024 bits MUST NOT be treated as valid
 * — a factorable modulus makes the seal forgeable. mailauth enforces the same
 * `minBitLength: 1024`. A weak seal key throws here (=> the seal is unverifiable
 * => `cv: 'fail'`), exactly like every other seal failure in this module.
 */
const MIN_RSA_KEY_BITS = 1024;

/**
 * Verify every ARC-Seal, outermost first — mirroring `mailauth`'s `verifyASChain`.
 * The chain has already passed `validateChainStructure` (called first in
 * `verifyArc`), so every `cv` is in {none, pass} and the instances are contiguous;
 * this validates the seal over instances `1..k` for each `k` from N down to 1, so a
 * broken inner seal is caught and no later hop can rescue it. THROWS on the first
 * seal that does not verify.
 */
export async function verifySealChain(
	chain: readonly ArcSet[],
	resolver: DkimDnsResolver
): Promise<void> {
	for (let i = chain.length - 1; i >= 0; i--) {
		await verifySeal(chain.slice(0, i + 1), resolver);
	}
}

/** Verify the ARC-Seal of the last set in `subset` over all sets in the subset. */
async function verifySeal(subset: readonly ArcSet[], resolver: DkimDnsResolver): Promise<void> {
	const last = subset[subset.length - 1];
	if (last === undefined) {
		throw new Error('internal: empty ARC subset');
	}

	const chunks: Buffer[] = [];
	for (let i = 0; i < subset.length; i++) {
		const set = subset[i];
		if (set === undefined) {
			throw new Error('internal: undefined ARC set');
		}
		chunks.push(relaxedLine(set.aar.raw));
		chunks.push(relaxedLine(set.ams.raw));
		if (i === subset.length - 1) {
			// The seal being verified: b= emptied, NO trailing CRLF.
			chunks.push(
				Buffer.from(canonicalizeHeaderField(stripSignatureValue(set.seal.raw), 'relaxed'), 'latin1')
			);
		} else {
			chunks.push(relaxedLine(set.seal.raw));
		}
	}
	const signingInput = Buffer.concat(chunks);

	const domain = last.sealTags.get('d');
	const selector = last.sealTags.get('s');
	if (domain === undefined || domain === '' || selector === undefined || selector === '') {
		throw new Error('ARC-Seal missing d= or s=');
	}
	const algorithm = parseSealAlgorithm((last.sealTags.get('a') ?? '').toLowerCase());
	if (algorithm === undefined) {
		throw new Error('ARC-Seal unsupported algorithm');
	}
	const signature = Buffer.from(stripWsp(last.sealTags.get('b') ?? ''), 'base64');
	const publicKey = await fetchSealKey(selector, domain, algorithm.keyType, resolver);

	const ok =
		algorithm.keyType === 'ed25519'
			? cryptoVerify(null, createHash('sha256').update(signingInput).digest(), publicKey, signature)
			: cryptoVerify('sha256', signingInput, publicKey, signature);
	if (!ok) {
		throw new Error('ARC-Seal signature verification failed');
	}
}

/** Relaxed-canonicalize a header field and re-terminate it with CRLF (§5.1.1). */
function relaxedLine(raw: string): Buffer {
	return Buffer.from(`${canonicalizeHeaderField(raw, 'relaxed')}\r\n`, 'latin1');
}

/** Strip all whitespace from a folded base64 value (`b=`). */
function stripWsp(value: string): string {
	return value.replace(/[ \t\r\n]+/g, '');
}

/**
 * Fetch and build the ARC-Seal public key. THROWS on any problem — a rejected
 * lookup, an empty/unparseable record, a revoked or type-mismatched key — so the
 * seal is treated as unverifiable (=> `fail`), never silently accepted.
 */
async function fetchSealKey(
	selector: string,
	domain: string,
	keyType: 'rsa' | 'ed25519',
	resolver: DkimDnsResolver
): Promise<KeyObject> {
	const records = await resolver(`${selector}._domainkey.${domain}`, 'TXT');
	const joined = records.map((chunks) => chunks.join('')).filter((r) => r !== '');
	if (joined.length === 0) {
		throw new Error('no ARC-Seal key record');
	}
	const parsed = joined.map((r) => parseDkimKeyRecord(r)).find((r) => !isKeyRecordError(r));
	if (parsed === undefined || isKeyRecordError(parsed)) {
		throw new Error('unparseable ARC-Seal key record');
	}
	if (parsed.revoked || parsed.keyType !== keyType) {
		throw new Error('ARC-Seal key revoked or wrong type');
	}
	// Enforce the SAME key-record restrictions the DKIM verifier applies (RFC 6376
	// §3.6.1), so a `_domainkey` record the DKIM path would reject cannot be
	// accepted here as an ARC-Seal key. ARC-Seal is always *-sha256 (RFC 8617
	// §4.1.3), so a key that forbids sha256 via `h=` is unusable; an explicit `s=`
	// service list must authorize `email` or `*`.
	if (parsed.hashAlgorithms !== undefined && !parsed.hashAlgorithms.includes('sha256')) {
		throw new Error('ARC-Seal key forbids sha256 (h=)');
	}
	if (
		parsed.serviceTypes.length > 0 &&
		!parsed.serviceTypes.includes('email') &&
		!parsed.serviceTypes.includes('*')
	) {
		throw new Error('ARC-Seal key does not authorize email (s=)');
	}
	return buildPublicKey(parsed, keyType);
}

/** Construct a Node public key from a parsed DKIM/ARC key record (RFC 8410 for ed25519). */
function buildPublicKey(record: DkimKeyRecord, keyType: 'rsa' | 'ed25519'): KeyObject {
	const material = Buffer.from(record.publicKey, 'base64');
	if (keyType === 'ed25519') {
		const der = Buffer.concat([ED25519_SPKI_PREFIX, material]);
		return createPublicKey({ key: der, format: 'der', type: 'spki' });
	}
	const key = createPublicKey({ key: material, format: 'der', type: 'spki' });
	// RFC 8301 §3.2: reject sub-1024-bit RSA seal keys (never treat as valid).
	const modulusLength = key.asymmetricKeyDetails?.modulusLength;
	if (modulusLength !== undefined && modulusLength < MIN_RSA_KEY_BITS) {
		throw new Error('ARC-Seal RSA key below 1024-bit minimum (RFC 8301)');
	}
	return key;
}
