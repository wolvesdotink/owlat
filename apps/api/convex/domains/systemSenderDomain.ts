/**
 * The system sender's domain as a sending domain.
 *
 * System mail (account verification, password reset, invitations, alerts) is
 * sent from the address `lib/systemSender.ts` resolves. The MTA signs only
 * domains registered in the app, so until an operator added that domain by
 * hand every account mail left unsigned, the first mail of a fresh install
 * among them. Registering it through the ordinary domain lifecycle gives it a
 * key, puts its DKIM, SPF and DMARC records on the Domains page and in the
 * Deliverability Center, and puts it under the daily re-verification.
 *
 * System mail never requires the signature (`delivery/dkimSignatureRequirement.ts`):
 * the MTA signs it whenever a key exists, its record published or not, and
 * sends it unsigned when there is none. A signature whose selector is not in
 * DNS yet fails at the receiver, and RFC 6376 §6.1 has a failed signature
 * treated as no signature, so account mail loses nothing while the operator
 * publishes the record and passes from the first mail after.
 *
 * New installs register it when the first admin is seeded
 * (`auth/seedAdminCommit.ts`); existing ones once, through migration 0075.
 * Neither adds a domain the operator has removed since.
 */

import { extractDomainOrNull } from '@owlat/shared';
import { internal } from '../_generated/api';
import { internalQuery, type MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { internalMutation } from '../lib/writeFence';
import { systemSenderAddress } from '../lib/systemSender';
import { getMtaConfig } from '../mail/mtaClient';
import { newDomainProviderKind } from './lifecycle';
import { OWN_SENDING_DOMAIN_PROVIDER_KIND } from './providers';

/** The `userId` the lifecycle's audit entry carries for this registration. */
const SYSTEM_SENDER_DOMAIN_USER = 'system:system_sender';

/** The domain of the configured system sender, or null when none is configured. */
export function systemSenderDomainName(): string | null {
	const address = systemSenderAddress();
	return address ? (extractDomainOrNull(address)?.toLowerCase() ?? null) : null;
}

/**
 * - `registered`: the domain was added and its key is being generated;
 * - `already_registered`: a domain row exists, whoever added it;
 * - `not_configured`: no system sender is configured;
 * - `not_built_in_mta`: sending goes through a relay, which signs on its own,
 *   or no MTA is configured to register the domain with;
 * - `invalid_domain`: the sender's domain is not a valid domain name.
 */
export type SystemSenderDomainOutcome =
	| 'registered'
	| 'already_registered'
	| 'not_configured'
	| 'not_built_in_mta'
	| 'invalid_domain';

/** What keeps the system sender's domain from being registered now, or null. */
export function systemSenderDomainBlocker(): 'not_configured' | 'not_built_in_mta' | null {
	if (!systemSenderDomainName()) return 'not_configured';
	if (newDomainProviderKind() !== OWN_SENDING_DOMAIN_PROVIDER_KIND || getMtaConfig() === null) {
		return 'not_built_in_mta';
	}
	return null;
}

/** Add the system sender's domain as a sending domain unless it is there already. */
export async function registerSystemSenderDomain(
	ctx: MutationCtx
): Promise<SystemSenderDomainOutcome> {
	const blocker = systemSenderDomainBlocker();
	const domain = systemSenderDomainName();
	if (blocker || !domain) return blocker ?? 'not_configured';
	const outcome = await ctx.runMutation(internal.domains.lifecycle.create, {
		domain,
		userId: SYSTEM_SENDER_DOMAIN_USER,
	});
	if (outcome.ok) return 'registered';
	return outcome.reason === 'already_exists' ? 'already_registered' : 'invalid_domain';
}

/** {@link registerSystemSenderDomain} as its own transaction, for the admin seed. */
export const register = internalMutation({
	args: {},
	handler: (ctx): Promise<SystemSenderDomainOutcome> => registerSystemSenderDomain(ctx),
});

/** One record the operator publishes for the system sender's domain. */
export interface SystemSenderDnsRecord {
	label: string;
	type: string;
	name: string;
	value: string;
	/** null until the first DNS check has looked at it. */
	verified: boolean | null;
}

export type SystemSenderDnsStatus =
	| { state: 'not_configured' }
	| { state: 'not_registered'; domain: string }
	| {
			state: Doc<'domains'>['status'];
			domain: string;
			records: SystemSenderDnsRecord[];
			error?: string;
	  };

type StoredRecord = NonNullable<Doc<'domains'>['dnsRecords']['spf']>;
type StoredResult = { verified: boolean } | undefined;

function record(
	label: string,
	fallbackType: string,
	stored: StoredRecord | undefined,
	result: StoredResult
): SystemSenderDnsRecord[] {
	if (!stored?.value) return [];
	return [
		{
			label,
			type: stored.type ?? fallbackType,
			name: stored.hostname ?? stored.host ?? '@',
			value: stored.value,
			verified: result ? result.verified : null,
		},
	];
}

/**
 * The records the Domains page lists for this domain, with what the last DNS
 * check found, flattened for a terminal. Read by `owlat doctor` and the
 * installer's closing summary through `convex run`.
 */
export function systemSenderDnsRecords(row: Doc<'domains'>): SystemSenderDnsRecord[] {
	const records = row.dnsRecords;
	const results = row.verificationResults;
	const dkim = records.dkim ?? [];
	return [
		...record('SPF', 'TXT', records.spf, results?.spf),
		...dkim.flatMap((stored, i) =>
			record(dkim.length > 1 ? `DKIM ${i + 1}` : 'DKIM', 'CNAME', stored, results?.dkim?.[i])
		),
		...record('DMARC', 'TXT', records.dmarc, results?.dmarc),
		...(records.mailFrom ?? []).flatMap((stored, i) =>
			record(
				stored.type === 'MX' ? 'MAIL FROM MX' : 'MAIL FROM SPF',
				'TXT',
				stored,
				results?.mailFrom?.[i]
			)
		),
	];
}

/** Where the system sender's domain stands, and the records it still needs. */
export const dnsStatus = internalQuery({
	args: {},
	handler: async (ctx): Promise<SystemSenderDnsStatus> => {
		const domain = systemSenderDomainName();
		if (!domain) return { state: 'not_configured' };
		const row = await ctx.db
			.query('domains')
			.withIndex('by_domain', (q) => q.eq('domain', domain))
			.first();
		if (!row) return { state: 'not_registered', domain };
		return {
			state: row.status,
			domain,
			records: systemSenderDnsRecords(row),
			...(row.lastRegistrationError ? { error: row.lastRegistrationError } : {}),
		};
	},
});
