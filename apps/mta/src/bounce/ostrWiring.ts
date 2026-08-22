/**
 * The OSTR seam of the MX listener (plan §12.2), in one place: the consumer's
 * lifecycle on the listener, and the per-message half of the lookup.
 *
 * Split out of `server.ts` so the listener module stays about SMTP policy and
 * the registry wiring reads as the one feature it is. Nothing here can change
 * an SMTP reply — the tier is a SIGNAL that rides along to Convex — and with
 * OSTR off there is no client, so no path issues a lookup at all.
 */

import type { ResolveTxt } from '@owlat/ostr-client';
import type { MtaConfig } from '../config.js';
import { createOstrConsumer } from './ostrClient.js';
import {
	resolveOstrSignal,
	type OstrLookupDeps,
	type OstrLookupOutcome,
	type OstrSignal,
} from './ostrLookup.js';
import {
	buildOstrDkimEvidence,
	isDomainAligned,
	type OstrDkimEvidencePayload,
	type OstrEvidenceCapture,
} from './ostrEvidence.js';

/** The consumer bound to one listener: what lookups ask, and how to stop it. */
export interface BounceOstrWiring {
	/** Handed to `lookupOstrIpTier` / `resolveOstrSignal`. */
	readonly deps: OstrLookupDeps;
	/**
	 * Stop the hourly snapshot refresh. Idempotent, and a no-op when the
	 * instance consumes no registry — a closed listener must not leave a fetch
	 * behind it, and nothing else in the process consumes the registry.
	 */
	readonly stop: () => void;
}

/**
 * Start the process-wide consumer client for this listener: subjects resolve
 * out of the aggregator's signed snapshot first and the DNS zone only on a
 * miss. With `OSTR_ENABLED` off `createOstrConsumer` returns `null`, which is
 * how "off" stays off — there is then nothing that could issue a lookup.
 */
export function startBounceOstr(config: MtaConfig, resolveTxt: ResolveTxt): BounceOstrWiring {
	const consumer = createOstrConsumer(config, { resolveTxt });
	consumer?.start();
	return {
		deps: { config, client: consumer?.client ?? null },
		stop: () => consumer?.stop(),
	};
}

/** What one received message offers the registry and the observer. */
export interface OstrMessageInput {
	/** Every `d=` whose signature verified, in signature order. */
	readonly dkimPassingDomains?: readonly string[];
	/** `d=` of the first signature that passed, whatever its alignment. */
	readonly passingSignatureDomain?: string;
	/** RFC5322.From domain, for the alignment pick and for evidence selection. */
	readonly fromDomain: string | undefined;
	/** The connection's IP lookup, started in `onConnect`. */
	readonly connectionIpTier?: Promise<OstrLookupOutcome>;
	/** Present only with observer mode ON. */
	readonly evidenceCapture?: OstrEvidenceCapture;
	readonly messageId?: string;
	/** When the signature was verified — stamped into the evidence payload. */
	readonly verifiedAt: Date;
}

/**
 * The OSTR fields of the bounce ctx, shaped to be SPREAD: with OSTR off and
 * observer mode off it is empty, so the payload Convex receives is
 * byte-identical to the pre-OSTR one.
 */
export interface OstrMessageContext {
	ostrTier?: OstrSignal['tier'];
	ostrScore?: OstrSignal['score'];
	ostrDkimEvidence?: OstrDkimEvidencePayload;
}

/**
 * The signature a message is JUDGED on, for both the registry subject and the
 * observer's evidence: the passing `d=` that is DMARC-aligned with the
 * RFC5322.From domain, else whichever passed first.
 *
 * A signer prepends its own signature, so on forwarded or list mail "first" is
 * the last hop — naming it would report a party that merely handled the mail
 * (§7.3's false-accusation risk), which is what the alignment pick avoids.
 */
export function reportedSigningDomain(input: OstrMessageInput): string | undefined {
	return (
		input.dkimPassingDomains?.find((domain) => isDomainAligned(domain, input.fromDomain)) ??
		input.passingSignatureDomain
	);
}

/**
 * Resolve the per-message OSTR context: one more weighted signal beside
 * SPF/DKIM/DMARC, plus the DKIM evidence an observer may later report on.
 *
 * The domain half is asked here, because only now is there an authenticated
 * `d=` to ask about; the IP half was asked once at connection time and is only
 * consulted when the domain produced no evidence. The tier NEVER gates
 * acceptance — see `ostrLookup.ts` for the fail-open rules.
 */
export async function resolveOstrMessageContext(
	ostr: OstrLookupDeps,
	input: OstrMessageInput
): Promise<OstrMessageContext> {
	const signingDomain = reportedSigningDomain(input);
	const signal = await resolveOstrSignal(ostr, {
		...(signingDomain !== undefined ? { dkimSigningDomain: signingDomain } : {}),
		...(input.connectionIpTier !== undefined ? { connectionIpTier: input.connectionIpTier } : {}),
	});
	// Present only with observer mode ON, a signature that verified, and a
	// record admissible as evidence under §7.1.
	const dkimEvidence = buildOstrDkimEvidence(
		input.evidenceCapture?.select(input.fromDomain),
		input.messageId,
		input.verifiedAt
	);
	return {
		...(signal !== null ? { ostrTier: signal.tier, ostrScore: signal.score } : {}),
		...(dkimEvidence !== undefined ? { ostrDkimEvidence: dkimEvidence } : {}),
	};
}
