/**
 * Inbound ARC verification — RFC 8617 (Authenticated Received Chain).
 *
 * A mailing list or forwarding account re-sends a message from its OWN servers:
 * SPF now authenticates the forwarder's return-path and the original author's
 * DKIM signature is usually broken by the list's subject/footer rewrites, so
 * plain DMARC (RFC 7489) FAILS for the visible From-domain — a legitimate
 * forward false-fails and gets routed to Spam. This is backlog item 3.6.
 *
 * ARC lets each participating hop SEAL, into the message, (a) the authentication
 * results IT observed (the ARC-Authentication-Results / AAR header) and (b) a
 * chain of seals (ARC-Message-Signature / AMS + ARC-Seal / AS) so a later
 * verifier can confirm the attestation was not tampered with in transit. If we
 * TRUST the outermost sealer AND its sealed AAR attests the ORIGINAL passed, the
 * Convex delivery path can honour that attestation and skip the DMARC-fail →
 * Spam routing.
 *
 * The cryptographic verification now lives in the in-house `@owlat/mail-auth`
 * `verifyArc` (RFC 8617 over the SHARED canon, U4 — no `mailauth` on the inbound
 * runtime path). This module is a THIN ADAPTER: it maps `verifyArc`'s honest
 * `{ cv, sealerDomain, attestsOriginalPass }` result onto the `ArcVerdict` the
 * MTA records, and re-exports the trust predicate that `delivery.ts` applies.
 *
 * The TRUST decision (is this sealer on the operator's allow-list?) lives in the
 * shared `@owlat/shared/arcTrust` predicate and is APPLIED in
 * `apps/api/convex/mail/delivery.ts`, where the editable trusted-forwarder list
 * lives. Keeping verification here and trust there means the operator can edit
 * the allow-list without redeploying the MTA.
 *
 * Fail-open, like the in-house `@owlat/mail-auth` `verifyDkim` / `evaluateDmarc`: `verifyArc`
 * never throws (a broken chain is `cv: 'fail'`, no chain is `cv: 'none'`), and
 * this adapter defends the seam with its own catch so a truly unexpected failure
 * still yields `cv: 'none'` (no rescue) and NEVER a NACK of accepted bytes.
 */

import { verifyArc } from '@owlat/mail-auth';
import { logger } from '../monitoring/logger.js';
import type { ArcChainResult } from '@owlat/shared/arcTrust';

export {
	DEFAULT_TRUSTED_ARC_FORWARDERS,
	isTrustedForwarder,
	shouldArcOverrideDmarc,
	type ArcChainResult,
	type ArcOverrideInput,
} from '@owlat/shared/arcTrust';

/**
 * The verified ARC verdict extracted from an inbound message. All optional-ish
 * fields collapse to a "no rescue" shape (`cv: 'none'`) when there is no ARC
 * chain — a message without ARC headers, or an older MTA, contributes nothing.
 */
export interface ArcVerdict {
	/** RFC 8617 chain-validation state (`cv=`). Only `pass` is rescue-eligible. */
	readonly cv: ArcChainResult;
	/** `d=` of the outermost ARC seal — the forwarder vouching for the message. */
	readonly sealerDomain?: string;
	/**
	 * Whether the sealer's sealed ARC-Authentication-Results attest the ORIGINAL
	 * message passed authentication (DMARC pass, or a passing SPF/DKIM the
	 * forwarder recorded). A forwarder that sealed a FAIL earns no override.
	 */
	readonly attestsOriginalPass: boolean;
}

/**
 * Injection seam for the resolver the runtime path and the hermetic tests
 * supply: a TXT lookup returning each record's raw character-strings. The shared
 * cached adapter (`toThrowingTxtResolver`) serves `'TXT'` from the shared cache
 * and rejects every other rrtype, which is the only type the ARC/DKIM key path
 * queries. Widened to `rrtype: string` (rather than `@owlat/mail-auth`'s literal
 * `'TXT'`) so the same adapter drives both this and the differential `mailauth`
 * oracle in tests.
 */
export type ArcDnsResolver = (name: string, rrtype: string) => Promise<string[][]>;

export interface VerifyArcOptions {
	readonly resolver?: ArcDnsResolver;
}

/** The thin local interface a caller (and the hermetic tests) implements against. */
export type ArcVerifier = (rawBuffer: Buffer, options?: VerifyArcOptions) => Promise<ArcVerdict>;

/**
 * Verify the ARC chain on a raw inbound MIME message and extract the verdict,
 * delegating the RFC 8617 crypto to `@owlat/mail-auth`. Never throws: an
 * unexpected failure is logged and reported as the no-rescue `cv: 'none'`.
 */
export const verifyArcChain: ArcVerifier = async (rawBuffer, options = {}) => {
	try {
		const result = await verifyArc(
			rawBuffer,
			options.resolver ? { resolver: options.resolver } : {}
		);
		return {
			cv: result.cv,
			...(result.sealerDomain !== undefined ? { sealerDomain: result.sealerDomain } : {}),
			attestsOriginalPass: result.attestsOriginalPass,
		};
	} catch (err) {
		logger.warn({ err }, 'Inbound ARC verification failed — recording no chain');
		return { cv: 'none', attestsOriginalPass: false };
	}
};
