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
import { normalizeDomain, type ArcChainResult } from '@owlat/shared/arcTrust';

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
 * supply. mailauth's `dkimVerify` / `arc` type their resolver as
 * `(name, rrtype: string) => Promise<string[][]>` (rrtype widened to `string`),
 * so this seam matches that shape rather than `@owlat/mail-auth`'s
 * `DkimDnsResolver` (whose `rrtype` is the literal `'TXT'`) — under
 * `strictFunctionTypes` the narrower parameter is not assignable at the
 * uncast `dkimVerify(...)` call. The shared cached adapter
 * (`toThrowingTxtResolver`) serves `'TXT'` from the shared cache and rejects
 * every other rrtype, which is the only type mailauth's DKIM/ARC path queries.
 * Deliberately NOT imported from `inboundDkim` (that pinned mailauth oracle
 * must stay out of every MTA runtime path).
 */
export type ArcDnsResolver = (name: string, rrtype: string) => Promise<string[][]>;

export interface VerifyArcOptions {
	readonly resolver?: ArcDnsResolver;
	/**
	 * A pre-parsed ARC seed from a prior `dkimVerify` pass over the SAME bytes
	 * (mailauth threads the parsed chain onto `dkimResult.arc`). Threading it in
	 * lets the hot ingest path verify DKIM once instead of parsing + verifying
	 * the raw message a second time here. Absent => we parse it ourselves.
	 */
	readonly arcSeed?: unknown;
}

/** The thin local interface a future `packages/mail-auth` can implement. */
export type ArcVerifier = (rawBuffer: Buffer, options?: VerifyArcOptions) => Promise<ArcVerdict>;

/** Shape we read off mailauth's `arc()` result (loosely typed upstream). */
interface MailauthArcResult {
	readonly status?: { readonly result?: string };
	readonly signature?: { readonly signingDomain?: string } | false;
	readonly authenticationResults?: {
		readonly spf?: { readonly result?: string; readonly smtp?: { readonly mailfrom?: string } };
		readonly dkim?: ReadonlyArray<{
			readonly result?: string;
			readonly header?: { readonly d?: string };
		}>;
		readonly dmarc?: { readonly result?: string; readonly header?: { readonly from?: string } };
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
 * Relaxed DMARC alignment (RFC 7489 §3.1.1, relaxed mode): an authenticated
 * domain aligns with the visible From domain when they share a registered
 * organizational domain — approximated here as equality or a sub-/super-domain
 * relationship. Both inputs are already normalized.
 */
function domainsAlign(authDomain: string, fromDomain: string): boolean {
	if (!authDomain || !fromDomain) return false;
	return (
		authDomain === fromDomain ||
		authDomain.endsWith('.' + fromDomain) ||
		fromDomain.endsWith('.' + authDomain)
	);
}

/**
 * Did the sealer's sealed Authentication-Results honestly attest that the
 * ORIGINAL message passed for its visible From domain?
 *
 * Fail-CLOSED, because this predicate is what lets a trusted forwarder suppress
 * DMARC-fail → Spam routing (a spammer posting a spoofed From through a trusted
 * list must NOT be rescued):
 *   - An explicit `dmarc=fail` in the AAR is authoritative → never attest, even
 *     if an unaligned SPF/DKIM passed (a spammer's own envelope SPF passes at
 *     the list while the spoofed From fails DMARC).
 *   - `dmarc=pass` proves From-alignment per RFC 8617 override practice → attest.
 *   - With no DMARC verdict recorded, fall back ONLY to a passing SPF or DKIM
 *     whose authenticated domain ALIGNS with the recorded From domain — an
 *     unaligned pass proves nothing about the visible sender.
 */
function attestsPass(ar: MailauthArcResult['authenticationResults']): boolean {
	if (!ar) return false;
	const dmarc = (ar.dmarc?.result ?? '').toLowerCase();
	if (dmarc === 'fail') return false;
	if (dmarc === 'pass') return true;

	const fromDomain = normalizeDomain(ar.dmarc?.header?.from);
	if (!fromDomain) return false;
	if (
		(ar.spf?.result ?? '').toLowerCase() === 'pass' &&
		domainsAlign(normalizeDomain(ar.spf?.smtp?.mailfrom), fromDomain)
	) {
		return true;
	}
	for (const entry of ar.dkim ?? []) {
		if (
			(entry.result ?? '').toLowerCase() === 'pass' &&
			domainsAlign(normalizeDomain(entry.header?.d), fromDomain)
		) {
			return true;
		}
	}
	return false;
}

/**
 * Verify the ARC chain on a raw inbound MIME message and extract the verdict.
 * Never throws: a verification crash is logged and reported as `cv: 'none'`.
 */
export const verifyArcChain: ArcVerifier = async (rawBuffer, options = {}) => {
	try {
		// One resolver seam for both mailauth calls (structurally identical to the
		// DKIM path): pass `{ resolver }` when injected, else `undefined` so
		// mailauth uses its default DNS. `arc()`'s second parameter is optional
		// upstream but loosely typed, so narrow it once here.
		const resolverOpt: { resolver: ArcDnsResolver } | undefined = options.resolver
			? { resolver: options.resolver }
			: undefined;

		// Reuse the ARC seed the hot ingest path already parsed via `verifyDkim`
		// (mailauth threads the parsed chain onto `dkimResult.arc`) instead of
		// parsing + verifying the raw bytes a second time. Only when it wasn't
		// supplied do we run our own DKIM pass to obtain it. This lower-level path
		// skips SPF/DMARC so verification stays hermetic — only ARC seal public
		// keys are looked up, via the injected resolver in tests.
		let arcSeed = options.arcSeed;
		if (arcSeed === undefined) {
			const dkimResult = (await dkimVerify(rawBuffer, resolverOpt)) as { arc?: unknown };
			arcSeed = dkimResult?.arc;
		}
		if (!arcSeed) {
			return { cv: 'none', attestsOriginalPass: false };
		}
		const arcResult = (await arc(
			arcSeed as Parameters<typeof arc>[0],
			resolverOpt as Parameters<typeof arc>[1]
		)) as unknown as MailauthArcResult;

		const cv = normalizeCv(arcResult.status?.result);
		const sealerDomain = arcResult.signature ? arcResult.signature.signingDomain : undefined;
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
