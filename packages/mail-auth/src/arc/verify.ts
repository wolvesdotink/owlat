/**
 * RFC 8617 ARC (Authenticated Received Chain) chain verification — orchestrator.
 *
 * Replaces the `mailauth`-backed verifier `apps/mta/src/bounce/inboundArc.ts` ran
 * on the inbound path (the R1 "mailauth production-zero" unblocker). ARC lets each
 * forwarding hop SEAL the authentication results it observed so a later verifier
 * can, if it TRUSTS the sealer, honour that attestation instead of routing a
 * legitimately-forwarded message (broken author DKIM, failing DMARC) to Spam.
 * This module does ONLY the cryptographic verification and emits the small honest
 * verdict the trust layer (`@owlat/shared/arcTrust`, applied in
 * `apps/api/convex/mail/delivery.ts`) consumes — the trust decision is OUT of scope.
 *
 * The work is split across sibling modules — chain parsing/structure (`chain.ts`),
 * seal crypto (`seal.ts`), sealed-AAR attestation (`attestation.ts`) — all over the
 * SHARED `@owlat/mail-auth` canon + DKIM core (U4), with NO second canonicalization.
 * Behaviour is verdict-equivalent to the replaced `mailauth` path, pinned by
 * `__tests__/arcVerify.differential.test.ts` and the checked-in
 * `fixtures/sealed-mail/arc` interop corpus the MTA suite reuses.
 *
 * NEVER THROWS (I6): once a chain is present any failure is `cv: 'fail'` (never a
 * rescue, never a NACK); no ARC headers, or a crash before a chain is recognized,
 * is `cv: 'none'`.
 */

import { resolveTxt } from 'dns/promises';
import { splitMessage } from '../dkim/message.js';
import { verifyMessageSignature, type DkimDnsResolver } from '../dkim/messageSignature.js';
import { aarAttestsPass, normalizeDomain } from './attestation.js';
import { arcHeaderKind, buildArcChain, validateChainStructure } from './chain.js';
import { verifySealChain } from './seal.js';

/** RFC 8617 chain-validation state (`cv=`). Only `pass` is rescue-eligible. */
export type ArcChainState = 'pass' | 'fail' | 'none';

/** The honest ARC verdict extracted from an inbound message. */
export interface ArcVerifyResult {
	/** Chain-validation state: `pass` (valid chain), `fail`, or `none` (no chain). */
	readonly cv: ArcChainState;
	/** `d=` of the outermost ARC-Seal — the forwarder vouching for the message. */
	readonly sealerDomain?: string;
	/**
	 * Whether the outermost sealer's sealed ARC-Authentication-Results HONESTLY
	 * attest that the ORIGINAL message passed authentication for its visible From.
	 */
	readonly attestsOriginalPass: boolean;
}

export interface VerifyArcOptions {
	/** Injectable TXT resolver (defaults to Node `dns/promises` resolveTxt). */
	readonly resolver?: DkimDnsResolver;
	/** Verification time in UNIX seconds (defaults to now); for the AMS `x=`. */
	readonly now?: number;
}

const NONE: ArcVerifyResult = { cv: 'none', attestsOriginalPass: false };
const FAIL: ArcVerifyResult = { cv: 'fail', attestsOriginalPass: false };

/**
 * Verify the ARC chain on a raw inbound MIME message and extract the verdict.
 * Never throws (I6): a chain present but broken is `fail`; no chain is `none`.
 */
export async function verifyArc(
	raw: Buffer,
	options: VerifyArcOptions = {}
): Promise<ArcVerifyResult> {
	const resolver = options.resolver ?? defaultResolver;
	const nowSeconds = options.now ?? Math.floor(Date.now() / 1000);

	let sawChain = false;
	try {
		const { headerFields, body } = splitMessage(raw);
		// A message with NO ARC headers contributes nothing (`none`). The moment any
		// ARC header is present, a broken chain is `fail` — so set the flag BEFORE
		// `buildArcChain`, whose structural rejections must surface as `fail`.
		if (!headerFields.some((f) => arcHeaderKind(f.name) !== null)) {
			return NONE;
		}
		sawChain = true;

		const chain = buildArcChain(headerFields);
		validateChainStructure(chain);
		await verifySealChain(chain, resolver);

		const outermost = chain[chain.length - 1];
		if (outermost === undefined) {
			return FAIL;
		}
		// Reuse the DKIM core for the outermost ARC-Message-Signature (RFC 8617
		// §4.1.2 — a DKIM signature minus `v=`), verified over the message body.
		const ams = await verifyMessageSignature(
			outermost.ams.raw,
			headerFields,
			body,
			resolver,
			nowSeconds,
			{
				requireVersion: false,
			}
		);
		if (ams.verdict !== 'pass') {
			// No valid outermost AMS — the sealed content is unauthenticated, so the
			// chain cannot be relied on (mailauth: `missing_valid_ams` -> fail).
			return FAIL;
		}

		const sealerDomain = normalizeDomain(outermost.sealTags.get('d'));
		return {
			cv: 'pass',
			...(sealerDomain !== '' ? { sealerDomain } : {}),
			attestsOriginalPass: aarAttestsPass(outermost.aar),
		};
	} catch {
		// I6: never throw. A recognized-but-broken chain is `fail`; anything that
		// blew up before a chain was recognized contributes no attestation (`none`).
		return sawChain ? FAIL : NONE;
	}
}

/** Default resolver: Node `dns/promises` resolveTxt (`string[][]`). */
const defaultResolver: DkimDnsResolver = (name) => resolveTxt(name);
