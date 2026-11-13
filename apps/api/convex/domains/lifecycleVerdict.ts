/**
 * Sending domain lifecycle — the verification verdict, pure.
 *
 * What a DNS pass proves about a sending domain, and which transition that
 * earns it. Split from `lifecycleReducer.ts`, which re-exports it; nothing
 * here reads or writes the database.
 */

import type { Doc } from '../_generated/dataModel';
import type { SendingDomainTransitionInput, VerificationResults } from './lifecycleReducer';

type ProviderCheckResult = { verified: boolean; lastError?: string };

export type VerificationVerdict = 'verified' | 'failed' | 'pending' | 'inconclusive';

/**
 * The verification verdict, pure. Combines DNS results + the per-provider
 * check into the decision `recordVerification` lands as a transition.
 *
 * Rules:
 *   - DKIM: every selector the MTA signs with must verify. A selector a key
 *     rotation added (`rotationPending`) is left out: the MTA switches to it
 *     only once its record is in DNS, so it cannot break signing.
 *   - MAIL FROM: when present, every record must verify (absent ⇒ satisfied).
 *   - SPF: optional — an absent SPF record counts as verified; a present one
 *     must report `verified === true`.
 *   - DMARC: must report `verified === true`.
 *   - TLS-RPT / TLSA are deliberately NOT part of the verdict (advisory
 *     reporting / operator-owned cert lifecycle); their results are recorded
 *     for the builder UI but never gate or fail the domain.
 *
 * `verified` needs DNS fully aligned AND the provider check passing. `failed`
 * needs evidence: a record the resolver reported absent or wrong, or a provider
 * error. A lookup the resolver did not answer (`inconclusive`) is no evidence,
 * so with nothing else failing the verdict is `inconclusive` and the status
 * stays. Otherwise `pending` (records still propagating, none failed).
 */
export function deriveVerificationVerdict(
	dns: VerificationResults,
	providerCheck: ProviderCheckResult
): VerificationVerdict {
	const signingDkim = dns.dkim?.filter((r) => r.rotationPending !== true);
	const gating = [
		...(dns.spf ? [dns.spf] : []),
		...(signingDkim ?? []),
		...(dns.dmarc ? [dns.dmarc] : []),
		...(dns.mailFrom ?? []),
	];

	const dnsAllVerified =
		signingDkim !== undefined && dns.dmarc !== undefined && gating.every((r) => r.verified);
	const dnsAnyFailed = gating.some((r) => !r.verified && r.inconclusive !== true);
	const dnsAnyUnanswered = gating.some((r) => !r.verified && r.inconclusive === true);

	if (dnsAllVerified && providerCheck.verified) return 'verified';
	if (dnsAnyFailed || providerCheck.lastError !== undefined) return 'failed';
	if (dnsAnyUnanswered) return 'inconclusive';
	return 'pending';
}

/**
 * How long a verified domain's first authoritative failure waits for its
 * confirming check. Leaving `verified` blocks every send from the domain, so
 * one answer is not enough; and a resolver caches a negative answer for up to
 * the zone's SOA minimum (commonly an hour or less), so a check sooner than
 * this could only repeat the first one.
 */
export const REGRESSION_CONFIRM_DELAY_MS = 60 * 60 * 1000;

/**
 * Turn a conclusive verdict into the transition `recordVerification` lands.
 *
 * A verified domain leaves `verified` only on the second failing check, made at
 * least {@link REGRESSION_CONFIRM_DELAY_MS} after the first. The first one
 * stays `verified`, records its results (so the Domains page shows which
 * record failed) and stamps `regressionSuspectedAt`, which schedules the
 * confirming check. A failure inside the window keeps the first timestamp. A
 * passing check clears it.
 */
export function planVerificationTransition(
	domain: Pick<Doc<'domains'>, 'status' | 'regressionSuspectedAt'>,
	verdict: Exclude<VerificationVerdict, 'inconclusive'>,
	verificationResults: VerificationResults,
	at: number
): SendingDomainTransitionInput {
	if (verdict === 'verified') return { to: 'verified', at, verificationResults };
	if (domain.status === 'verified') {
		const suspectedAt = domain.regressionSuspectedAt;
		if (suspectedAt === undefined || at - suspectedAt < REGRESSION_CONFIRM_DELAY_MS) {
			return {
				to: 'verified',
				at,
				verificationResults,
				regressionSuspectedAt: suspectedAt ?? at,
			};
		}
	}
	return { to: verdict, at, verificationResults };
}
