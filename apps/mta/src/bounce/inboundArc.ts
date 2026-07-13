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
 * This module does ONLY the cryptographic verification — extracting a small,
 * honest `ArcVerdict` (chain state + sealer domain + whether the sealer attested
 * the original passed). The TRUST decision (is this sealer on the operator's
 * allow-list?) lives in the shared `@owlat/shared/arcTrust` predicate and is
 * APPLIED in `apps/api/convex/mail/delivery.ts`, where the editable
 * trusted-forwarder list lives. Keeping verification here and trust there means
 * the operator can edit the allow-list without redeploying the MTA.
 *
 * `verifyArcChain` is deliberately a THIN LOCAL INTERFACE (`ArcVerifier`): the
 * own-the-inbound plan defers a full `packages/mail-auth` implementation, and
 * this seam lets that swap in later without touching callers.
 *
 * Fail-open, like the sibling `inboundDkim` / `inboundDmarc` modules: any
 * verification crash yields `cv: 'none'` (no rescue) and NEVER a NACK of
 * accepted bytes.
 */

import { dkimVerify } from 'mailauth/lib/dkim/verify.js';
import { arc } from 'mailauth/lib/arc/index.js';
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
 * Injection seam mirroring `mailauth`'s DNS resolver shape (also used by
 * `inboundDkim`). Tests supply a hermetic resolver returning the fixture's
 * public keys so CI never touches real DNS.
 */
export type ArcDnsResolver = (name: string, rrtype: string) => Promise<string[][] | string[]>;

export interface VerifyArcOptions {
	readonly resolver?: ArcDnsResolver;
}

/** The thin local interface a future `packages/mail-auth` can implement. */
export type ArcVerifier = (rawBuffer: Buffer, options?: VerifyArcOptions) => Promise<ArcVerdict>;

/** Shape we read off mailauth's `arc()` result (loosely typed upstream). */
interface MailauthArcResult {
	readonly status?: { readonly result?: string };
	readonly signature?: { readonly signingDomain?: string } | false;
	readonly authenticationResults?: {
		readonly spf?: { readonly result?: string };
		readonly dkim?: ReadonlyArray<{ readonly result?: string }>;
		readonly dmarc?: { readonly result?: string };
	};
}

/** Normalize mailauth's `cv=` keyword into our three-value vocabulary. */
function normalizeCv(raw: string | undefined): ArcChainResult {
	switch ((raw ?? '').toLowerCase()) {
		case 'pass':
			return 'pass';
		case 'fail':
			return 'fail';
		default:
			// `none`, absent, or any unexpected keyword => no chain to rely on.
			return 'none';
	}
}

/**
 * Did the sealer's sealed Authentication-Results attest the original passed?
 * True when the AAR records a passing DMARC, OR any passing DKIM signature, OR a
 * passing SPF — i.e. the forwarder saw the message authenticate before relaying.
 */
function attestsPass(ar: MailauthArcResult['authenticationResults']): boolean {
	if (!ar) return false;
	if ((ar.dmarc?.result ?? '').toLowerCase() === 'pass') return true;
	if ((ar.spf?.result ?? '').toLowerCase() === 'pass') return true;
	for (const entry of ar.dkim ?? []) {
		if ((entry.result ?? '').toLowerCase() === 'pass') return true;
	}
	return false;
}

/**
 * Verify the ARC chain on a raw inbound MIME message and extract the verdict.
 * Never throws: a verification crash is logged and reported as `cv: 'none'`.
 */
export const verifyArcChain: ArcVerifier = async (rawBuffer, options = {}) => {
	try {
		// Parse + verify DKIM first (mailauth threads the parsed ARC chain onto
		// `dkimResult.arc`), then validate the ARC seal chain. This lower-level
		// path skips SPF/DMARC so verification stays hermetic — only ARC seal
		// public keys are looked up, via the injected resolver in tests.
		const resolverOpt = options.resolver ? { resolver: options.resolver } : undefined;
		const dkimResult = (await dkimVerify(rawBuffer, resolverOpt)) as { arc?: unknown };
		if (!dkimResult?.arc) {
			return { cv: 'none', attestsOriginalPass: false };
		}
		const arcResult = (await arc(
			dkimResult.arc as Parameters<typeof arc>[0],
			{
				resolver: options.resolver,
			} as Parameters<typeof arc>[1]
		)) as unknown as MailauthArcResult;

		const cv = normalizeCv(arcResult.status?.result);
		const sealerDomain =
			arcResult.signature && arcResult.signature !== false
				? arcResult.signature.signingDomain
				: undefined;
		return {
			cv,
			sealerDomain: sealerDomain || undefined,
			attestsOriginalPass: attestsPass(arcResult.authenticationResults),
		};
	} catch (err) {
		logger.warn({ err }, 'Inbound ARC verification failed — recording no chain');
		return { cv: 'none', attestsOriginalPass: false };
	}
};
