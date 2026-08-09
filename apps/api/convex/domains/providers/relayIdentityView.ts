/**
 * ONE SHAPE FOR "WHAT DOES THIS RELAY SAY ABOUT THIS DOMAIN?" — the read half of
 * the relay-identity seam, and the default answer for any kind that keeps rows
 * in the shared table.
 *
 * WHY IT EXISTS. The write half of the relay-identity work is generic — every
 * kind after SES writes `sendingDomainRelayIdentities` through
 * `./relayIdentityPersistence.ts` — while the READ half was per vendor: a query
 * that point-read the frozen `sendingDomainSesIdentities` sibling and shaped its
 * row around SES's DNS bundle, a second query that filtered the generic table on
 * `providerKind === 'mandrill'`, and one Vue panel per vendor above them. A
 * bundled plugin relay wrote rows nothing could render, and there was no place
 * for the third kind's answer to go except a third panel.
 *
 * SO THE ROW SHAPE IS THE SEAM. {@link RelayDomainIdentityFacts} is what every
 * kind answers in, whatever it reads to answer: a status from one vocabulary,
 * the records to publish as a flat labelled list, the provider's own verdicts,
 * and the two numbers that date the evidence. What varies per kind — WHERE the
 * row lives, whether the records are remembered or derived, how long its proof
 * stays good — stays behind {@link RelayIdentityProviderModule.describeRelayIdentity}.
 *
 * AND THE DEFAULT IS THE GENERIC READ, not "nothing". A registered relay kind
 * that implements no describe seam is still answered for, by
 * {@link describeSharedRelayIdentity} below, because a kind that provisions
 * identities into the shared table and reports NOTHING to the operator is the
 * exact failure this file is undoing. Implementing the seam then only ever adds
 * detail — the records to publish, the kind's own freshness bound — it never
 * decides whether the kind is visible at all.
 */

import type { Doc } from '../../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../../_generated/server';
import { loadRelayIdentityForDomain } from './relayIdentityProof';

/**
 * One record an operator publishes, flattened out of whatever bundle the kind
 * keeps it in.
 *
 * `label` is what the record IS ('SPF', 'DKIM', 'MAIL FROM', 'Ownership'), and
 * it is the panel's only ordering/grouping vocabulary — SES remembers per-domain
 * tokens, Mandrill derives an account-wide pair, and a plugin tier may know only
 * the selector its provider signs with, so a shape keyed by record TYPE would
 * have to be widened for every kind that publishes a different mix.
 *
 * `type` / `host` are OPTIONAL because a relay can know what an operator must
 * arrange without knowing the exact RRset to publish (the plugin tier reports
 * DKIM selectors and SPF mechanisms, not zone rows). Absent means "we cannot
 * spell the record for you", which the panel renders as the fact it is rather
 * than as a half-filled DNS row an operator would paste.
 */
export type RelayDnsRecordView = {
	readonly label: string;
	readonly type?: string;
	readonly host?: string;
	readonly value: string;
	readonly priority?: number;
};

/** A provider's own verdict on one published record. */
export type RelayRecordVerdict = {
	readonly isValid: boolean;
	readonly error?: string;
};

/**
 * The identity lifecycle as the OPERATOR SURFACE states it — one vocabulary for
 * every kind.
 *
 * It is the shared table's `status` with `pending_dns` spelled `pending`, which
 * is also what SES's sibling reduces to (a registered identity that has not
 * verified yet). Two synthesised values the QUERY adds — `provisioning` for a
 * domain with no row at a configured relay, `awaiting_primary_verification` for
 * a domain whose own verification has not landed — are deliberately NOT here:
 * they are facts about the domain, not answers from a provider, and a provider
 * that could return them would be able to claim a row it does not have.
 */
export type RelayIdentityViewStatus = 'unverified' | 'pending' | 'verified' | 'failed';

/**
 * Everything one relay kind can say about one sending domain.
 *
 * Every field except `status` and `records` is optional, and absence is a real
 * answer throughout: a kind that keeps no record verdicts omits them rather than
 * reporting `{ isValid: false }` for evidence it never collected.
 */
export type RelayDomainIdentityFacts = {
	readonly status: RelayIdentityViewStatus;
	/** The DNS to publish, empty when this relay cannot describe any. */
	readonly records: readonly RelayDnsRecordView[];
	/** The provider's own verdicts, rendered verbatim — it is the authority. */
	readonly spf?: RelayRecordVerdict;
	readonly dkim?: RelayRecordVerdict;
	/** Why the last call produced no verdict (a rejected credential, typically). */
	readonly lastError?: string;
	/**
	 * When the evidence behind `status` was collected — NOT when the row was
	 * written. The panel measures the proof's age from it, so a writer that
	 * advanced it on a call that told us nothing would keep a stale proof alive
	 * by failing.
	 */
	readonly lastCheckedAt?: number;
	/** When the sweep asks again, when this kind is on a sweep. */
	readonly nextCheckDueAt?: number;
	/**
	 * How long this kind's evidence licenses relaying, so the surface can say
	 * "verified, re-checking" under the SAME bound routing applies rather than a
	 * second copy of it that drifts. Absent ⇒ the surface never ages the proof.
	 */
	readonly proofMaxAgeMs?: number;
	/**
	 * OWNERSHIP AS A SEPARATE CEREMONY, and only for the kinds that have one.
	 *
	 * `false` means the operator has a step to complete at the provider beyond
	 * publishing DNS (Mandrill rejects mail from a domain it has not verified,
	 * however good the records are). `undefined` means this relay has no such
	 * step to report — SES verifies from the records themselves — and the panel
	 * then says nothing about ownership, rather than inventing an outstanding
	 * item for a ceremony that does not exist.
	 */
	readonly isOwnershipVerified?: boolean;
	/**
	 * Whether an apex SPF row is part of THIS relay's proof. The owned-MTA
	 * deployments that publish a reviewed manual SPF policy get
	 * `not_applicable_manual_primary` from the kinds that can authenticate
	 * without one, which is the difference between "publish this" and "do not
	 * touch your SPF record".
	 */
	readonly spfProof?: 'dns_required' | 'not_applicable_manual_primary';
};

/**
 * The DEFAULT answer for a kind whose rows live in `sendingDomainRelayIdentities`
 * — one indexed point read, normalized, with no per-kind knowledge at all.
 *
 * Every registered relay kind gets this whether or not it implements the describe
 * seam, so registering a kind is what makes it visible and implementing the seam
 * only adds detail. What it CANNOT produce is the records to publish: those are
 * either remembered in a per-kind blob or derived from a per-kind helper, and
 * guessing them here would put DNS on an operator's screen that no provider ever
 * asked for.
 */
export async function describeSharedRelayIdentity(
	ctx: QueryCtx | MutationCtx,
	kind: string,
	domainName: string,
	extras?: Partial<RelayDomainIdentityFacts>
): Promise<RelayDomainIdentityFacts | null> {
	const row = await loadRelayIdentityForDomain(ctx, kind, domainName);
	return row === null ? null : relayIdentityFactsFromRow(row, extras);
}

/**
 * One shared-table row as facts, with whatever the kind knows on top.
 *
 * Split out of the read so an adapter that has ALREADY loaded the row (to read
 * its own `providerDetails` blob) normalizes it through the same statement
 * instead of re-reading it — two normalizations of one row is how a status
 * vocabulary drifts between the panel and the sweep.
 */
export function relayIdentityFactsFromRow(
	row: Doc<'sendingDomainRelayIdentities'>,
	extras?: Partial<RelayDomainIdentityFacts>
): RelayDomainIdentityFacts {
	return {
		status: row.status === 'pending_dns' ? 'pending' : row.status,
		records: extras?.records ?? [],
		...(row.spf ? { spf: row.spf } : {}),
		...(row.dkim ? { dkim: row.dkim } : {}),
		lastCheckedAt: row.lastCheckedAt,
		...(row.nextCheckDueAt !== undefined ? { nextCheckDueAt: row.nextCheckDueAt } : {}),
		...(extras?.lastError !== undefined ? { lastError: extras.lastError } : {}),
		...(extras?.proofMaxAgeMs !== undefined ? { proofMaxAgeMs: extras.proofMaxAgeMs } : {}),
		...(extras?.isOwnershipVerified !== undefined
			? { isOwnershipVerified: extras.isOwnershipVerified }
			: {}),
		...(extras?.spfProof !== undefined ? { spfProof: extras.spfProof } : {}),
	};
}
