/**
 * The DKIM evidence-capture seam (OSTR §7.2).
 *
 * An OSTR observer must be able to re-derive, offline and without the original
 * connection, WHY a message's DKIM signature verified: the exact bytes that
 * were hashed, the key record they were checked against, and the verdict that
 * came out. Everything needed is already local to `verifyMessageSignature`, so
 * this module adds only the shape of that record plus the collector the
 * verifier fills in as it goes — it performs NO verification of its own and
 * changes no verdict.
 *
 * Two invariants matter more than the payload:
 *
 *   - The observer is a PASSIVE tap. The collector swallows anything the
 *     callback throws, so a broken observer can never turn a `pass` into a
 *     `temperror` (locked decision D7: the verifier never throws).
 *   - The captured headers are the ones ACTUALLY HASHED. `selectSignedHeaders`
 *     is the single implementation of the `h=` selection rule (bottom-up per
 *     name, missing names contribute nothing) and is consumed by both the
 *     evidence record and `buildHeaderHashInput`, so the evidence can never
 *     drift from the signature input it claims to describe.
 */

import type { KeyObject } from 'crypto';
import type { DkimVerdict } from '../dmarc.js';
import type { HeaderField } from './message.js';

/** One signed header instance, captured verbatim (no CRLF; folds kept inline). */
export interface DkimSignedHeader {
	/** Lowercased field name, as matched against `h=`. */
	name: string;
	/**
	 * The exact bytes that were canonicalized and hashed — the COMPLETE field
	 * (name, colon, value, any folded continuation lines), minus its terminating
	 * CRLF.
	 *
	 * ENCODING: latin1-decoded, i.e. every code unit is exactly one signed octet.
	 * A header carrying 8-bit octets (an unencoded UTF-8 Subject is the common
	 * case) is NOT valid UTF-8 text here; recover the signed bytes with
	 * `Buffer.from(raw, 'latin1')`, never by re-encoding the string as UTF-8.
	 */
	raw: string;
}

/**
 * Everything an observer needs to reconstruct one DKIM signature check.
 *
 * Captured per signature attempt that reached DNS key resolution, whatever the
 * verdict — a `fail` is as interesting to a reputation observer as a `pass`.
 */
export interface DkimSignatureEvidence {
	/** `d=` — the signing domain, verbatim. */
	readonly signingDomain: string;
	/** `s=` — the selector, verbatim. */
	readonly selector: string;
	/** `a=` — the algorithm tag, verbatim (e.g. `rsa-sha256`). */
	readonly algorithm: string;
	/** Public-key size in bits when computable (RSA modulus; 256 for Ed25519). */
	readonly keyBits?: number;
	/** True when the signature carries an `l=` body-length tag (capped at neutral). */
	readonly usesBodyLengthTag: boolean;
	/** The `h=` names, lowercased, in `h=` order (duplicates preserved). */
	readonly signedHeaderNames: string[];
	/**
	 * The verbatim header fields that were hashed, in `h=` order. Selection
	 * follows DKIM's last-instance semantics: repeated names consume successive
	 * instances bottom-up, and a name with no remaining instance contributes
	 * nothing (so this array may be shorter than `signedHeaderNames`).
	 *
	 * This is the CANONICALIZATION SEQUENCE, not a document-order header block —
	 * a trap worth stating, because getting it wrong turns genuine evidence into
	 * a `fail` at a challenge opening. For `h=…:x-trace:x-trace` over a message
	 * whose headers read `X-Trace: first` then `X-Trace: second`, this array is
	 * `[second, first]`. Re-verification must therefore CONCATENATE the array as
	 * it stands:
	 *
	 *     rawSignedHeaders.map((f) => canonicalizeHeaderField(f.raw, mode) + CRLF)
	 *       .join('') + canonicalizeHeaderField(stripSignatureValue(sig), mode)
	 *
	 * Anything that instead reconstructs an RFC 822 message from this array and
	 * re-runs a verifier MUST first reverse each per-name duplicate group, or the
	 * bottom-up rule gets applied a second time and re-reverses it.
	 *
	 * SHAPE: the full raw field per instance, rather than the `[name, value]`
	 * field-body pairs OSTR spec §4.2 currently describes for the observer's
	 * bundle. The full field is what `simple` canonicalization hashes verbatim,
	 * so it is the only form that supports offline re-verification in both modes;
	 * and a name with no remaining instance is OMITTED rather than emitted as an
	 * empty pair, because RFC 6376 §3.5 makes a nonexistent header "the null
	 * input, including the header field name, the separating colon … and any CRLF
	 * terminator" — synthesizing `name:` there would false-`fail` the standard
	 * oversigning defense (`h=from:from` over one From header).
	 */
	readonly rawSignedHeaders: DkimSignedHeader[];
	/**
	 * The raw DKIM-Signature field, verbatim (name, colon, value, folds intact,
	 * `b=` NOT stripped) and latin1-decoded like `DkimSignedHeader.raw`. Hashing
	 * it requires emptying `b=` first (`stripSignatureValue`); §4.2's bundle
	 * member is the field BODY, so a bundle builder targeting the spec letter
	 * must drop the `DKIM-Signature:` name and colon itself.
	 */
	readonly dkimSignatureHeader: string;
	/**
	 * The joined TXT key record actually used, or `''` if none was usable —
	 * character strings concatenated with no separator, latin1-decoded.
	 */
	readonly dnsKeyRecordTxt: string;
	/**
	 * The RFC 8601 verdict this signature produced. `none` is excluded by
	 * construction: every exit that yields `none` (missing required tag, unknown
	 * `a=`, invalid `c=`) fires before the collector is armed at the key lookup,
	 * so an unarmed attempt stays silent and `report` drops a `none` outright.
	 * This is also the union `@owlat/ostr-observer` accepts.
	 */
	readonly verificationVerdict: Exclude<DkimVerdict, 'none'>;
	/** `bh=` — the body hash the signer published, whitespace stripped. */
	readonly bodyHash: string;
}

/** Split an `h=` tag into its lowercased names, in order, duplicates kept. */
export function parseSignedHeaderNames(hTag: string): string[] {
	return hTag
		.split(':')
		.map((name) => name.trim().toLowerCase())
		.filter((name) => name !== '');
}

/**
 * Select the header instances an `h=` tag names, in `h=` order.
 *
 * Per-name stacks of raw fields are built in document order and consumed from
 * the bottom, so a later-added duplicate can't be swapped in for the one that
 * was signed. A name with no (remaining) matching header contributes NOTHING —
 * not even an empty field — which is what lets the standard oversigning defense
 * (`h=from:from` over one From header) verify.
 */
export function selectSignedHeaders(
	headerFields: readonly HeaderField[],
	hTag: string
): DkimSignedHeader[] {
	const stacks = new Map<string, string[]>();
	for (const field of headerFields) {
		const stack = stacks.get(field.name);
		if (stack) {
			stack.push(field.raw);
		} else {
			stacks.set(field.name, [field.raw]);
		}
	}

	const selected: DkimSignedHeader[] = [];
	for (const name of parseSignedHeaderNames(hTag)) {
		const raw = stacks.get(name)?.pop();
		if (raw === undefined) {
			continue;
		}
		selected.push({ name, raw });
	}
	return selected;
}

/** The signature facts known before the key lookup runs. */
export interface DkimEvidenceContext {
	readonly domain: string;
	readonly selector: string;
	readonly algorithm: string;
	readonly usesBodyLengthTag: boolean;
	/** The raw `h=` value; names and raw fields are derived from it at report time. */
	readonly hTag: string;
	readonly bodyHash: string;
}

/**
 * The verifier's handle on the tap. Facts arrive in the order verification
 * learns them — `arm` at the key lookup, then the record, then the key size —
 * and `report` fires AT MOST ONCE, from whichever exit the verdict comes out of.
 * `arm` gates everything: an attempt that never reached DNS never reports, and
 * a `none` verdict (only ever produced by such an exit) is dropped.
 *
 * `report` takes the full `DkimVerdict` so the verifier can pipe every exit
 * through one unconditional call site; the narrowing to the observable five
 * (pass / fail / neutral / temperror / permerror) happens here, not at the
 * caller.
 */
export interface DkimEvidenceCollector {
	arm(context: DkimEvidenceContext): void;
	recordKeyRecord(txt: string): void;
	recordKey(key: KeyObject, keyType: 'rsa' | 'ed25519'): void;
	report(verdict: DkimVerdict): void;
}

/** Shared do-nothing collector for the (overwhelmingly common) no-observer case. */
const NOOP_COLLECTOR: DkimEvidenceCollector = {
	arm: () => {},
	recordKeyRecord: () => {},
	recordKey: () => {},
	report: () => {},
};

/**
 * Build the collector for one signature attempt. Without a callback this is a
 * shared no-op, so an unobserved verification does no extra work at all.
 *
 * The tap is strictly one-way: verification has already decided its verdict by
 * the time `report` runs, and anything the callback throws is absorbed — a
 * broken observer must never turn a `pass` into a `temperror` (decision D7).
 */
export function createEvidenceCollector(
	callback: ((evidence: DkimSignatureEvidence) => void) | undefined,
	sigField: string,
	headerFields: readonly HeaderField[]
): DkimEvidenceCollector {
	if (callback === undefined) {
		return NOOP_COLLECTOR;
	}

	let context: DkimEvidenceContext | undefined;
	let dnsKeyRecordTxt = '';
	let keyBits: number | undefined;
	// Latches the at-most-once contract rather than merely documenting it: today
	// it holds because every `withVerdict(...)` is in return position, and a
	// future edit that breaks that must not double-fire an observer's tap.
	let reported = false;

	return {
		arm: (next) => {
			context = next;
		},
		recordKeyRecord: (txt) => {
			dnsKeyRecordTxt = txt;
		},
		recordKey: (key, keyType) => {
			// Ed25519 keys are fixed-size (RFC 8032 §5.1); RSA reports its modulus.
			keyBits = keyType === 'ed25519' ? 256 : key.asymmetricKeyDetails?.modulusLength;
		},
		report: (verdict) => {
			// `none` is only reachable from a pre-DNS exit, where the collector is
			// unarmed anyway; dropping it explicitly keeps the emitted verdict inside
			// the observable five even if that ordering ever changes.
			if (reported || context === undefined || verdict === 'none') {
				return;
			}
			reported = true;
			try {
				callback({
					signingDomain: context.domain,
					selector: context.selector,
					algorithm: context.algorithm,
					...(keyBits !== undefined ? { keyBits } : {}),
					usesBodyLengthTag: context.usesBodyLengthTag,
					signedHeaderNames: parseSignedHeaderNames(context.hTag),
					rawSignedHeaders: selectSignedHeaders(headerFields, context.hTag),
					dkimSignatureHeader: sigField,
					dnsKeyRecordTxt,
					verificationVerdict: verdict,
					bodyHash: context.bodyHash,
				});
			} catch {
				// Deliberate: an observer's failure is not the message's problem.
			}
		},
	};
}
