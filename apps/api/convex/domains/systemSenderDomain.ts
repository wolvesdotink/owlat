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
 * Registered by migration 0075: the admin seed runs it for a new install
 * (`auth/seedAdminCommit.ts`), its cron for an existing one. After that the
 * same hourly cron follows the sender: when `DEFAULT_FROM_*` moves to another
 * domain, that domain is registered once ({@link followSystemSenderDomain}).
 * Every domain this path has handled is recorded in `systemSenderDomains` and
 * never added again, so a domain the operator removes stays removed. The
 * instance default sender set in Settings registers its domain when it is
 * changed ({@link registerDefaultSenderDomain}).
 */

import { extractDomainOrNull } from '@owlat/shared';
import { internal } from '../_generated/api';
import { internalQuery, type MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
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
	return builtInMtaSends() ? null : 'not_built_in_mta';
}

function builtInMtaSends(): boolean {
	return newDomainProviderKind() === OWN_SENDING_DOMAIN_PROVIDER_KIND && getMtaConfig() !== null;
}

/** Add a domain through the domain lifecycle, or find it already there. */
async function createSendingDomain(
	ctx: MutationCtx,
	domain: string,
	userId: string
): Promise<'registered' | 'already_registered' | 'invalid_domain'> {
	const outcome = await ctx.runMutation(internal.domains.lifecycle.create, { domain, userId });
	if (outcome.ok) return 'registered';
	return outcome.reason === 'already_exists' ? 'already_registered' : 'invalid_domain';
}

async function isRecorded(ctx: MutationCtx, domain: string): Promise<boolean> {
	const row = await ctx.db
		.query('systemSenderDomains')
		.withIndex('by_domain', (q) => q.eq('domain', domain))
		.first();
	return row !== null;
}

async function recordHandled(ctx: MutationCtx, domain: string): Promise<void> {
	if (!(await isRecorded(ctx, domain))) {
		await ctx.db.insert('systemSenderDomains', { domain, recordedAt: Date.now() });
	}
}

/**
 * Add the system sender's domain as a sending domain unless it is there
 * already, and record it as handled.
 */
export async function registerSystemSenderDomain(
	ctx: MutationCtx
): Promise<SystemSenderDomainOutcome> {
	const blocker = systemSenderDomainBlocker();
	const domain = systemSenderDomainName();
	if (blocker || !domain) return blocker ?? 'not_configured';
	const outcome = await createSendingDomain(ctx, domain, SYSTEM_SENDER_DOMAIN_USER);
	await recordHandled(ctx, domain);
	return outcome;
}

/**
 * - `already_handled`: this path registered the domain before, or found it;
 * - `baseline`: the first look on an install whose migration 0075 completed
 *   before domains were recorded. Its sender's domain was 0075's to handle and
 *   may have been removed since, so it is recorded and left as it is.
 */
export type FollowedSenderDomainOutcome =
	| SystemSenderDomainOutcome
	| 'already_handled'
	| 'baseline';

/**
 * After migration 0075 completed: register the system sender's domain if the
 * sender moved to a domain this path has not handled yet. Idempotent; one or
 * two indexed reads when nothing changed.
 */
export async function followSystemSenderDomain(
	ctx: MutationCtx
): Promise<FollowedSenderDomainOutcome> {
	const blocker = systemSenderDomainBlocker();
	const domain = systemSenderDomainName();
	if (blocker || !domain) return blocker ?? 'not_configured';
	if (await isRecorded(ctx, domain)) return 'already_handled';
	const anyRecorded = await ctx.db.query('systemSenderDomains').first();
	if (anyRecorded === null) {
		await recordHandled(ctx, domain);
		return 'baseline';
	}
	return await registerSystemSenderDomain(ctx);
}

/**
 * The instance default sender's domain, when an owner or admin changes the
 * address to one on another domain and the built-in MTA sends: registered
 * through the domain lifecycle under their name, so its mail is signed once
 * the records are published. Mail from an unregistered domain is refused, so
 * without this the new address sends nothing until the domain is added. Only
 * a change registers, so saving other settings never adds back a domain the
 * operator removed.
 */
export async function registerDefaultSenderDomain(
	ctx: MutationCtx,
	change: { from: string | undefined; to: string; userId: string }
): Promise<SystemSenderDomainOutcome | 'unchanged'> {
	const next = extractDomainOrNull(change.to.trim())?.toLowerCase() ?? null;
	const previous = change.from ? (extractDomainOrNull(change.from)?.toLowerCase() ?? null) : null;
	if (!next) return 'invalid_domain';
	if (next === previous) return 'unchanged';
	if (!builtInMtaSends()) return 'not_built_in_mta';
	return await createSendingDomain(ctx, next, change.userId);
}

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
