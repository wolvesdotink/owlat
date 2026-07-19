/**
 * Inbound DKIM verification — RFC 6376 + RFC 8601 — the `mailauth` DIFFERENTIAL
 * ORACLE.
 *
 * PRODUCTION HAS CUT OVER: `bounce/server.ts` no longer calls this module — the
 * inbound path now verifies DKIM with the in-house `@owlat/mail-auth` `verifyDkim`
 * (piece CI3). This module survives ONLY as the pinned `mailauth`-backed oracle
 * for the shadow-replay differential (`tools/__tests__/replay.corpus.test.ts`)
 * and the `inboundAuth.dkim` suite: per locked decision I1, `mailauth` stays a
 * test/operator differential oracle so the in-house verifier is never allowed to
 * verify itself. It lives under `__tests__/` — never in a shipped MTA path — and
 * `mailauth` survives only as a devDependency of these differential suites.
 *
 * It verifies a message's DKIM signature(s) against the signer's published
 * public key and returns a single normalized verdict suitable for
 * `Authentication-Results` (RFC 8601) and for the `dkimResult` field on the
 * personal-mailbox inbound payload.
 *
 * We delegate the cryptographic + canonicalization work to `mailauth` and
 * normalize its per-signature output into the small RFC-8601 vocabulary the rest
 * of Owlat consumes (`mailMessages.dkimResult`).
 *
 * Normalization rules (RFC 6376 §3.9 + §6.1):
 *   - No DKIM-Signature header at all            -> 'none'
 *   - Signature verifies                          -> 'pass'
 *   - Signature present but bytes don't verify     -> 'fail'
 *     (bad signature OR mutated body / body-hash mismatch)
 *   - Signature present, public key unretrievable  -> 'permerror'
 *     (NXDOMAIN / NODATA / malformed key record — a permanent failure
 *      per RFC 6376 §6.1.2; mailauth surfaces these as 'neutral'/'no key')
 *   - Transient DNS failure                        -> 'temperror'
 *
 * When several signatures are present, the strongest passing verdict wins:
 * if any signature passes the message is `pass` (RFC 6376 §6.1 — a verifier
 * may stop at the first valid signature).
 */

import { dkimVerify } from 'mailauth/lib/dkim/verify.js';
import { logger } from '../../../monitoring/logger.js';

/** The RFC 8601 DKIM result vocabulary we record. */
export type DkimVerdict = 'pass' | 'fail' | 'neutral' | 'none' | 'temperror' | 'permerror';

export interface DkimVerifyOutcome {
	/** Normalized RFC 8601 result. */
	readonly result: DkimVerdict;
	/** The signing domain (`d=`) of the verdict-deciding signature, if any. */
	readonly domain?: string;
	/**
	 * The parsed ARC chain mailauth threaded onto its result (`dkimResult.arc`),
	 * passed opaquely so the inbound path can verify the ARC seals via
	 * `verifyArcChain` WITHOUT re-parsing the raw bytes. `undefined` when the
	 * message carries no ARC headers or DKIM verification crashed.
	 */
	readonly arcSeed?: unknown;
}

/**
 * Optional injection seam so tests (and forwarding ARC code) can supply a
 * mocked DNS TXT resolver. Mirrors `mailauth`'s `DNSResolver` shape:
 * `(name, rrtype) => Promise<string[][] | string[]>`.
 */
export type DkimDnsResolver = (name: string, rrtype: string) => Promise<string[][] | string[]>;

export interface VerifyDkimOptions {
	readonly resolver?: DkimDnsResolver;
}

/** Shape of a single per-signature result we read off mailauth. */
interface MailauthDkimResult {
	readonly signingDomain?: string;
	readonly status?: {
		readonly result?: string;
		readonly comment?: string;
	};
}

/**
 * Verify the DKIM signature(s) on a raw inbound MIME message.
 *
 * Never throws: any unexpected failure is logged and reported as
 * `temperror` so the SMTP transaction is still ACK-ed (we never NACK
 * accepted bytes just because verification crashed).
 */
export async function verifyDkim(
	rawBuffer: Buffer,
	options: VerifyDkimOptions = {}
): Promise<DkimVerifyOutcome> {
	try {
		const verifyResult = await dkimVerify(
			rawBuffer,
			options.resolver ? { resolver: options.resolver } : undefined
		);

		// mailauth threads the parsed ARC chain here; carry it opaquely so the
		// inbound path can verify the ARC seals without a second parse.
		const arcSeed = (verifyResult as { arc?: unknown } | undefined)?.arc;
		const results = (verifyResult?.results ?? []) as MailauthDkimResult[];
		if (results.length === 0) {
			// No DKIM-Signature header present.
			return { result: 'none', arcSeed };
		}

		return { ...pickVerdict(results), arcSeed };
	} catch (err) {
		logger.warn({ err }, 'Inbound DKIM verification failed — recording temperror');
		return { result: 'temperror' };
	}
}

/**
 * Reduce a list of per-signature results to one verdict, preferring the
 * strongest (a single passing signature authenticates the message —
 * RFC 6376 §6.1).
 */
function pickVerdict(results: ReadonlyArray<MailauthDkimResult>): DkimVerifyOutcome {
	// Precedence: pass > fail > permerror > temperror > neutral > none.
	const rank: Record<DkimVerdict, number> = {
		pass: 6,
		fail: 5,
		permerror: 4,
		temperror: 3,
		neutral: 2,
		none: 1,
	};

	let best: DkimVerifyOutcome = { result: 'none' };
	for (const sig of results) {
		const verdict = normalizeStatus(sig);
		if (rank[verdict.result] > rank[best.result]) {
			best = verdict;
		}
	}
	return best;
}

/**
 * Map a single mailauth per-signature status to our RFC 8601 vocabulary.
 *
 * mailauth reports an unretrievable / malformed key as `neutral` with a
 * `no key` / `invalid public key` comment, and a body-hash mismatch as
 * `neutral` with a `body hash did not verify` comment. Per RFC 6376 these
 * are, respectively, a permanent key failure (PERMFAIL) and a signature
 * failure — so we re-map them rather than passing `neutral` through.
 */
function normalizeStatus(sig: MailauthDkimResult): DkimVerifyOutcome {
	const domain = sig.signingDomain;
	const withDomain = (result: DkimVerdict): DkimVerifyOutcome =>
		domain ? { result, domain } : { result };

	const raw = (sig.status?.result ?? '').toLowerCase();
	const comment = (sig.status?.comment ?? '').toLowerCase();

	switch (raw) {
		case 'pass':
			return withDomain('pass');
		case 'fail':
			return withDomain('fail');
		case 'none':
		case 'skipped':
		case '':
			// mailauth reports an unsigned message as a single `none` result.
			return { result: 'none' };
		case 'temperror':
		case 'temperr':
			return withDomain('temperror');
		case 'permerror':
			return withDomain('permerror');
		case 'neutral': {
			// Body bytes changed after signing -> signature failure.
			if (comment.includes('body hash')) {
				return withDomain('fail');
			}
			// Public key could not be retrieved or was malformed -> PERMFAIL.
			if (
				comment.includes('no key') ||
				comment.includes('invalid public key') ||
				comment.includes('missing key') ||
				comment.includes('unknown key')
			) {
				return withDomain('permerror');
			}
			return withDomain('neutral');
		}
		default:
			return withDomain('neutral');
	}
}
