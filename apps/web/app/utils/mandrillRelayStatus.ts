/**
 * READINESS OF A MANDRILL SENDING DOMAIN, for the migration flow that asks about
 * exactly that provider.
 *
 * WHAT LEFT THIS FILE, and why what is left belongs here. The DISPLAY half — the
 * tone, the label and the sentence a panel renders — was Mandrill-worded because
 * the read behind it was: one query per vendor, one panel per vendor. Both are
 * gone. `providerRoutes.listRelayDomainIdentities` answers for every kind the
 * domain-provider registry proves, and `~/utils/relayDomainDisplay` words the
 * result from the row's own catalog label, including the surprising judgement
 * this file used to own (a `verified` row whose evidence has aged past its
 * kind's bound reads "re-checking", because routing has already stopped trusting
 * it).
 *
 * WHAT IS LEFT IS NOT THAT QUESTION. "Migrate from Mailchimp/Mandrill"
 * (`~/utils/mandrillMigration`) is a flow ABOUT one vendor: its domain step has
 * to know whether THIS deployment's Mandrill identities are ready before it
 * writes a preset naming Mandrill as the fallback relay. Reading that from
 * `mandrillRelayQueries.listIdentities` is a vendor question asked by a vendor
 * flow, not a general surface wearing a vendor's name.
 */

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

/**
 * The outstanding DNS/ownership items, in the order an operator works them, as
 * the catalog keys that name them — this module is module scope and never calls
 * `useI18n`, so the migration screen words them through `t()`.
 */
export function mandrillOutstanding(identity: MandrillRelayIdentityInput): string[] {
	return [
		...(identity.spf?.isValid ? [] : ['shared.mandrillRelayStatus.outstanding.spf']),
		...(identity.dkim?.isValid ? [] : ['shared.mandrillRelayStatus.outstanding.dkim']),
		...(identity.verifiedAt === null ? ['shared.mandrillRelayStatus.outstanding.ownership'] : []),
	];
}
