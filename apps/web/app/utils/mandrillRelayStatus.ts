/**
 * The Mandrill sending-domain identity, as a sentence.
 *
 * Pure derivation over `api.domains.mandrillRelayQueries.listIdentities`, kept
 * out of the component so the judgements — and one of them is genuinely
 * surprising — can be pinned by tests without a DOM.
 *
 * THE SURPRISING ONE: a `verified` row whose proof has aged past
 * `MANDRILL_RELAY_PROOF_MAX_AGE_MS` does NOT read "verified". Routing stops
 * trusting a proof that old (`providers/mandrill/relayVerification.ts` applies
 * the identical bound), so a screen still saying "verified" would be telling the
 * operator their relay is usable at the moment it stopped being usable. It reads
 * "re-checking" instead — not an error, because nothing is wrong and nothing is
 * required of them: the hourly sweep is already asking Mandrill again. Only a
 * multi-day outage keeps it there, and that is exactly when an operator should
 * see it.
 */

export type MandrillRelayTone = 'success' | 'warning' | 'error' | 'neutral';

export interface MandrillRelayIdentityInput {
	readonly domain: string;
	readonly status: 'unverified' | 'pending_dns' | 'verified' | 'failed';
	readonly spf: { isValid: boolean; error?: string } | null;
	readonly dkim: { isValid: boolean; error?: string } | null;
	readonly verifiedAt: number | null;
	readonly lastError: string | null;
	readonly lastCheckedAt: number;
	readonly nextCheckDueAt: number | null;
	readonly proofMaxAgeMs: number;
}

export interface MandrillRelayDisplay {
	readonly tone: MandrillRelayTone;
	readonly label: string;
	/** One plain-language line: what this state means for sending. */
	readonly summary: string;
	/** True when the proof is verified but too old for routing to rely on. */
	readonly isProofStale: boolean;
	/** True when ownership is still outstanding — Mandrill's `unsigned` reject. */
	readonly needsOwnership: boolean;
}

/**
 * Whether the last successful check is recent enough for routing to lean on.
 * A `lastCheckedAt` in the future is treated as stale rather than fresh: a clock
 * we cannot explain is not evidence.
 */
export function isMandrillProofFresh(
	identity: Pick<MandrillRelayIdentityInput, 'lastCheckedAt' | 'proofMaxAgeMs'>,
	now: number
): boolean {
	const age = now - identity.lastCheckedAt;
	return age >= 0 && age <= identity.proofMaxAgeMs;
}

export function mandrillRelayDisplay(
	identity: MandrillRelayIdentityInput,
	now: number
): MandrillRelayDisplay {
	const needsOwnership = identity.verifiedAt === null;
	switch (identity.status) {
		case 'verified': {
			if (!isMandrillProofFresh(identity, now)) {
				return {
					tone: 'warning',
					label: 'Re-checking',
					summary:
						'This domain verified, but the confirmation is older than Owlat will rely on. Sending through Mailchimp Transactional holds until the next check confirms it — nothing for you to do.',
					isProofStale: true,
					needsOwnership: false,
				};
			}
			return {
				tone: 'success',
				label: 'Verified',
				summary: 'Mailchimp Transactional can sign and send as this domain. Nothing to publish.',
				isProofStale: false,
				needsOwnership: false,
			};
		}
		case 'pending_dns':
			return {
				tone: 'warning',
				label: 'Waiting on DNS',
				summary:
					'Publish the records below. Mailchimp Transactional re-checks hourly and this page follows.',
				isProofStale: false,
				needsOwnership,
			};
		case 'unverified':
			return {
				tone: 'neutral',
				label: 'Not published yet',
				summary:
					'Mailchimp Transactional has no record of either record for this domain yet. Publish them below to start.',
				isProofStale: false,
				needsOwnership,
			};
		case 'failed':
			return {
				tone: 'error',
				label: 'Cannot check',
				summary:
					'Mailchimp Transactional rejected the API key, so this domain cannot be confirmed. Your published DNS is untouched — fix the key and the check resumes.',
				isProofStale: false,
				needsOwnership,
			};
	}
}

/** The outstanding DNS/ownership items, in the order an operator works them. */
export function mandrillOutstanding(identity: MandrillRelayIdentityInput): string[] {
	return [
		...(identity.spf?.isValid ? [] : ['SPF']),
		...(identity.dkim?.isValid ? [] : ['DKIM']),
		...(identity.verifiedAt === null ? ['domain ownership'] : []),
	];
}
