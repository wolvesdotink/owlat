/**
 * Signing observer drafts (plan §5).
 *
 * The envelope is filled exactly once, here: `v`, the observer name and the
 * signature all come from a single {@link ObserverIdentity}, so a draft cannot
 * be published under a name whose `_ostr` record does not carry the key that
 * signed it. Canonicalization and the signature itself belong to
 * `@owlat/ostr-core` and are not reimplemented.
 *
 * Every signed document is validated against the core's structural rules before
 * it is handed back. A draft this package built and the log rejects is a bug in
 * this package, and a builder that discovers it at submission time discovers it
 * after the network round-trip, per log, in production.
 */
import {
	signAttestation,
	validateAttestation,
	type Attestation,
	type UnsignedAttestation,
} from '@owlat/ostr-core';
import { normalizeDomain, type AttestationDraft, type ObserverIdentity } from './types.js';

/** Fill the `v: 1` envelope around a draft. `window` is omitted rather than set
 *  to `undefined`: the signature covers the canonical form, and an absent member
 *  and a present-but-empty one must not be two spellings of one document. */
export function draftToUnsigned<TBody>(
	observer: string,
	draft: AttestationDraft<TBody>
): UnsignedAttestation<TBody> {
	const unsigned: UnsignedAttestation<TBody> = {
		v: 1,
		kind: draft.kind,
		observer,
		subject: draft.subject,
		body: draft.body,
	};
	if (draft.window !== undefined) unsigned.window = draft.window;
	return unsigned;
}

/**
 * Sign every draft with the observer's key, in order.
 *
 * @throws RangeError if the identity's domain is not a usable FQDN, or if a
 * signed document fails `validateAttestation` — both are producer bugs, and the
 * message names the offending index and the core's own errors.
 */
export function signDrafts(
	identity: ObserverIdentity,
	drafts: readonly AttestationDraft[]
): Attestation[] {
	const observer = normalizeDomain(identity.domain);
	if (observer === undefined) {
		throw new RangeError('observer identity domain must be an FQDN');
	}
	return drafts.map((draft, index) => {
		const signed = signAttestation(draftToUnsigned(observer, draft), identity.privateKeyBase64);
		const validation = validateAttestation(signed);
		if (!validation.ok) {
			throw new RangeError(
				`draft ${index} (${draft.kind}) is invalid: ${validation.errors.join('; ')}`
			);
		}
		return signed;
	});
}
