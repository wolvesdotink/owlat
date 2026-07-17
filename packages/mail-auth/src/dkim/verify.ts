/**
 * RFC 6376 / RFC 8463 / RFC 8601 inbound DKIM verifier.
 *
 * Replaces the `mailauth`-backed `apps/mta/src/bounce/inboundDkim.ts` on the
 * inbound path. It reduces a message's DKIM-Signature header(s) to the single
 * RFC 8601 verdict Owlat records (`mailMessages.dkimResult`), with three
 * invariants carried over verbatim and one sanctioned improvement:
 *
 *   - STRONGEST-WINS across multiple signatures — precedence identical to the
 *     old `inboundDkim.pickVerdict` (pass > fail > permerror > temperror >
 *     neutral > none): one valid signature authenticates the message
 *     (RFC 6376 §6.1).
 *   - NEVER THROWS (locked decision D7): any internal error — a hostile header,
 *     a broken key record, a DNS explosion — becomes `temperror`, so an
 *     already-accepted message is never dropped because verification crashed.
 *   - Both `rsa-sha256` and `ed25519-sha256` (RFC 8463) verify; `rsa-sha1` is
 *     verified but POLICY-FAILED per RFC 8301 (it is deprecated and MUST NOT be
 *     treated as a pass).
 *   - SANCTIONED IMPROVEMENT (locked decision D2): the `l=` body-length tag is
 *     honored cryptographically but a signature that carries it is CAPPED AT
 *     `neutral` — never `pass`. `l=` lets an attacker append unsigned content
 *     to a validly-signed body, so we refuse to call such a message
 *     authenticated. This is the one intentional divergence from the old
 *     library and is pinned by `dkimVerify.ltag.test.ts`.
 *
 * The single-signature core (canonicalization, body hash, key retrieval, crypto)
 * lives in `./messageSignature.ts` and is shared verbatim with the outbound
 * signer and the ARC verifier (U4); this file owns only the message-level
 * strongest-wins reduction over a message's DKIM-Signature headers.
 */

import { resolveTxt } from 'dns/promises';
import type { Canonicalization } from '../canon.js';
import type { DkimVerdict } from '../dmarc.js';
import { splitMessage } from './message.js';
import {
	verifyMessageSignature,
	type BodyHashCache,
	type DkimDnsResolver,
	type DkimSignatureResult,
} from './messageSignature.js';

// Re-export the shared single-signature surface so consumers (and `index.ts`)
// keep importing the DKIM types from `./verify.js`.
export type { DkimDnsResolver, DkimSignatureResult } from './messageSignature.js';

export interface VerifyDkimOptions {
	/** Injectable TXT resolver (defaults to Node `dns/promises` resolveTxt). */
	readonly resolver?: DkimDnsResolver;
	/** Verification time in UNIX seconds (defaults to now); for `x=` expiry. */
	readonly now?: number;
}

/** The message-level DKIM outcome. */
export interface DkimVerifyResult {
	/** The strongest-wins RFC 8601 verdict for the whole message. */
	readonly result: DkimVerdict;
	/** Signing domain (`d=`) of the verdict-deciding signature, if any. */
	readonly domain?: string;
	/** Every signature's individual verdict, in document order. */
	readonly signatures: readonly DkimSignatureResult[];
}

/** RFC 8601 verdict precedence — MUST match `inboundDkim.pickVerdict`. */
const VERDICT_RANK: Record<DkimVerdict, number> = {
	pass: 6,
	fail: 5,
	permerror: 4,
	temperror: 3,
	neutral: 2,
	none: 1,
};

/**
 * Upper bound on the number of DKIM-Signature headers we evaluate. Legitimate
 * mail carries a handful; a hostile message can carry thousands to force a
 * key-lookup / hash storm (the "signature bomb"). We evaluate the first
 * `MAX_SIGNATURES` in document order and ignore the rest — a bounded-safety
 * measure that only affects pathological messages, never real mail.
 */
const MAX_SIGNATURES = 10;

/**
 * Verify the DKIM signature(s) on a raw RFC 822 message.
 *
 * Never throws (D7): the whole body is wrapped so any unexpected failure
 * surfaces as `temperror`.
 */
export async function verifyDkim(
	raw: Buffer,
	options: VerifyDkimOptions = {}
): Promise<DkimVerifyResult> {
	try {
		const resolver = options.resolver ?? defaultResolver;
		const nowSeconds = options.now ?? Math.floor(Date.now() / 1000);

		const { headerFields, body } = splitMessage(raw);
		const signatureFields = headerFields.filter((f) => f.name === 'dkim-signature');
		if (signatureFields.length === 0) {
			return { result: 'none', signatures: [] };
		}

		// Cache body canon + full-body hash across the signature loop: both are
		// O(body) and depend only on (bodyMode) / (bodyMode, hash), so a multi-sig
		// message costs one pass per combination, not one per signature.
		const bodyCache: BodyHashCache = {
			canon: new Map<Canonicalization, Buffer>(),
			hash: new Map<string, string>(),
		};

		const signatures: DkimSignatureResult[] = [];
		for (const sigField of signatureFields.slice(0, MAX_SIGNATURES)) {
			signatures.push(
				await verifyMessageSignature(sigField.raw, headerFields, body, resolver, nowSeconds, {
					bodyCache,
				})
			);
		}

		// Strongest-wins reduction (RFC 6376 §6.1), matching pickVerdict.
		let best: DkimSignatureResult = { verdict: 'none' };
		for (const sig of signatures) {
			if (VERDICT_RANK[sig.verdict] > VERDICT_RANK[best.verdict]) {
				best = sig;
			}
		}

		return best.domain !== undefined
			? { result: best.verdict, domain: best.domain, signatures }
			: { result: best.verdict, signatures };
	} catch {
		// D7: an unexpected internal error is a transient result, never a throw.
		return { result: 'temperror', signatures: [] };
	}
}

/** Default resolver: Node `dns/promises` resolveTxt (`string[][]`). */
const defaultResolver: DkimDnsResolver = (name) => resolveTxt(name);
