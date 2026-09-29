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

import { createHash, verify as cryptoVerify, type KeyObject } from 'crypto';
import { canonicalizeHeaderField, stripSignatureValue } from '@owlat/mail-canon';
import { resolveDkimKey, type DkimDnsResolver } from '../dkim/keyRecord.js';
import { stripWsp } from '../dkim/tagList.js';
import { parseSealAlgorithm, type ArcSet } from './chain.js';

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

/**
 * Fetch and build the ARC-Seal public key through the shared `_domainkey`
 * resolver, so the seal key obeys exactly the key-record policy the DKIM
 * verifier applies (RFC 6376 §3.6.1 `h=` / `s=`, RFC 8301 RSA floor). ARC-Seal
 * is always *-sha256 (RFC 8617 §4.1.3). THROWS on any failure — a rejected
 * lookup, a missing or unparseable record, a revoked, mismatched, restricted,
 * undecodable or weak key — so the seal is unverifiable (=> `cv: 'fail'`),
 * never silently accepted.
 */
async function fetchSealKey(
	selector: string,
	domain: string,
	keyType: 'rsa' | 'ed25519',
	resolver: DkimDnsResolver
): Promise<KeyObject> {
	const resolved = await resolveDkimKey(resolver, selector, domain, { keyType, hash: 'sha256' });
	if (!resolved.ok) {
		throw new Error(`ARC-Seal key unusable: ${resolved.reason}`);
	}
	return resolved.key;
}
