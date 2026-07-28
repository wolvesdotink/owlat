/**
 * THE WIZARD SURFACE for the per-stream subdomain layout (P4-7, gap G-14).
 *
 * `streamSubdomains.ts` decides the layout, `streamSubdomainRecords.ts` renders
 * every record in one pass and `bimi.ts` decides the BIMI offer — all pure. This
 * module is the thin Convex shell that loads what those decisions need (the
 * proposed hosts' domain rows and DKIM identities, the deployment's pool IPs and
 * mail host) and hands the UI ONE object: the proposal, the record table, the
 * BIMI offer and the per-subdomain warming plans.
 *
 * WHY A QUERY AND NOT A MUTATION. Nothing here writes: the wizard's job is to
 * tell the operator which names to create and what to publish on each. The
 * domain rows themselves are still created through the shipped Add-Domain flow,
 * one per sending subdomain — this screen is what tells them that is the layout
 * to create in the first place, which is exactly the gap G-14 names.
 *
 * IT NEVER INVENTS A RECORD VALUE. The proposed hosts are ordinary sending
 * domains, so the ones that already exist are LOOKED UP and their shipped
 * selector and DKIM value are what the table shows — the wizard republishes the
 * shipped row rather than composing a rival one for the same host. A host that
 * has not been added yet has no selector and no key, and the table says so
 * instead of filling the gap with a name nothing signs with.
 *
 * D2 — NOTHING HERE IS LOAD-BEARING ON A THIRD PARTY. No relay, no ESP, no
 * commercial anything: with zero external credentials the table renders in full
 * and the reference-arm DKIM row simply is not part of it. An unusable domain
 * (no registrable zone) renders an explanation in place of the table rather
 * than an error state.
 */

import { v } from 'convex/values';
import type { Doc } from '../_generated/dataModel';
import { authedQuery } from '../lib/authedFunctions';
import { getOptional } from '../lib/env';
import { providerKindConfigured } from '../lib/sendProviders/capability';
import { listSendTransports } from '../lib/sendProviders/transports';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { offerBimiRecord, type BimiOffer } from './bimi';
import { parsePoolIpsLenient, parseReturnPathRelaySpfTerms, resolveSpfQualifier } from './spf';
import {
	buildStreamSubdomainRecords,
	streamSubdomainRecordValue,
	type StreamSubdomainRecord,
	type StreamSubdomainRecordPurpose,
	type SubdomainSigningIdentity,
} from './streamSubdomainRecords';
import {
	SUBDOMAIN_ADVICE_COPY,
	planStreamSubdomains,
	planSubdomainWarming,
	type SigningSubdomainRole,
	type SubdomainAdviceKey,
	type SubdomainWarmingPlan,
	type TransportArm,
} from './streamSubdomains';

/** One line of wizard advice, resolved to its copy so the UI owns no wording. */
export interface StreamSubdomainAdvice {
	key: SubdomainAdviceKey;
	text: string;
}

/** One proposed sending name, flattened for the table. */
export interface StreamSubdomainProposalRow {
	role: string;
	host: string;
	relativeHost: string;
	streams: string[];
	pool: string | null;
	sends: boolean;
	/**
	 * The name already exists as a sending domain on this deployment. The panel
	 * renders those rows as DONE rather than as work: telling an operator to
	 * create a name they created (and verified) months ago is how a wizard
	 * teaches people to ignore it.
	 */
	alreadyRegistered: boolean;
}

/**
 * A generated row ON THE WIRE.
 *
 * `value` is resolved HERE, through {@link streamSubdomainRecordValue}, so the
 * decision "what, if anything, is copyable for this row" has exactly one home.
 * A component that re-derived it would be a second renderer of one DNS value,
 * and two renderers of one value drift.
 */
export interface StreamSubdomainRecordRow {
	subdomain: string;
	host: string;
	relativeHost: string;
	purpose: StreamSubdomainRecordPurpose;
	type: string;
	/** `null` when there is nothing to publish yet — never an empty `p=`. */
	value: string | null;
	/** DKIM rows only. */
	arm?: TransportArm;
	/** MX rows only. */
	priority?: number;
}

export type StreamSubdomainWizardResult =
	| { ok: false; reason: 'unknown_domain' | 'invalid_domain' }
	| {
			ok: true;
			domain: string;
			subdomains: StreamSubdomainProposalRow[];
			/** True when the deployment has fewer than two distinct sending IPs. */
			poolsCollapsed: boolean;
			advice: StreamSubdomainAdvice[];
			records: StreamSubdomainRecordRow[];
			warmingPlans: SubdomainWarmingPlan[];
			/** One offer per SENDING subdomain — BIMI is evaluated per From domain. */
			bimiOffers: { host: string; offer: BimiOffer }[];
	  };

/**
 * A reference transport is connected iff some NON-MTA send transport this
 * deployment can dispatch through has its credentials present.
 *
 * D4 — the plugin/transport catalog is the single source of truth for "which
 * transports exist here". The return-path relay SPF env var is not: it
 * authorises a relay on the BOUNCE HOST and says nothing about whether a
 * transport is registered, so inferring one from the other gets both directions
 * wrong. Env-only, zero document reads. Absence stays entirely non-blocking
 * (D2): it removes one DKIM row from the table and changes nothing else.
 */
function referenceTransportConfigured(): boolean {
	return listSendTransports().some(
		(transport) => transport.kind !== 'mta' && providerKindConfigured(transport.kind)
	);
}

/** The DKIM identity the shipped registration path already minted for a host. */
function shippedSigningIdentity(
	domain: Doc<'domains'> | null,
	identityRow: Doc<'sendingDomainMtaIdentities'> | null
): SubdomainSigningIdentity | undefined {
	if (domain === null || identityRow === null) return undefined;
	// The shipped adapter publishes ONE `<selector>._domainkey` row carrying the
	// key it signs with; the wizard echoes that row rather than composing another.
	const published = domain.dnsRecords.dkim?.find(
		(record) => record.host === `${identityRow.dkimSelector}._domainkey`
	);
	if (published === undefined) return undefined;
	return { selector: identityRow.dkimSelector, recordValue: published.value };
}

/**
 * The whole wizard payload for one domain.
 *
 * Admin-gated by `authedQuery` exactly like the rest of the domain-management
 * surface: these values become public DNS, but choosing the sending layout is
 * an operator task.
 */
export const getStreamSubdomainPlan = authedQuery({
	args: { domainId: v.id('domains') },
	handler: async (ctx, args): Promise<StreamSubdomainWizardResult> => {
		// Domain-level sending configuration, the same gate as every other read and
		// write on this wizard: only owners/admins see or change it.
		await requireOrgPermission(ctx, 'organization:manage');
		const domain = await ctx.db.get(args.domainId);
		if (domain === null) return { ok: false, reason: 'unknown_domain' };

		// A typo in MTA_IP_POOLS must not take the screen down, so the wizard reads
		// the pool leniently (the registration path keeps the strict parser).
		const { ips } = parsePoolIpsLenient(getOptional('MTA_IP_POOLS'));
		const planned = planStreamSubdomains({ domain: domain.domain, sendingIps: ips });
		if (!planned.ok) return { ok: false, reason: 'invalid_domain' };
		const layout = planned.proposal;

		// Which of the three proposed names already exist. Three point reads on the
		// shipped `by_domain` index — the wizard has to know this to avoid telling
		// an operator to create a name they already run, and it is also where the
		// REAL selector and DKIM value for those names come from.
		const registeredByHost = new Map<string, Doc<'domains'>>();
		for (const entry of layout.subdomains) {
			const existing = await ctx.db
				.query('domains')
				.withIndex('by_domain', (q) => q.eq('domain', entry.host))
				.first();
			if (existing !== null) registeredByHost.set(entry.host, existing);
		}

		const signingIdentities: Partial<Record<SigningSubdomainRole, SubdomainSigningIdentity>> = {};
		for (const role of ['transactional', 'bulk'] as const) {
			const registered = registeredByHost.get(layout.subdomainsByRole[role].host) ?? null;
			const identityRow =
				registered === null
					? null
					: await ctx.db
							.query('sendingDomainMtaIdentities')
							.withIndex('by_domain', (q) => q.eq('domainId', registered._id))
							.first();
			const identity = shippedSigningIdentity(registered, identityRow);
			if (identity !== undefined) signingIdentities[role] = identity;
		}

		const relaySpfTerms = parseReturnPathRelaySpfTerms(getOptional('MTA_RETURN_PATH_RELAY_SPF'));
		const mailHost = getOptional('EHLO_HOSTNAME')?.trim();
		const rua = getOptional('MTA_DMARC_RUA')?.trim();
		const spfInclude = getOptional('MTA_SPF_INCLUDE');

		const { records } = buildStreamSubdomainRecords(layout, {
			dmarcPolicy: domain.dmarcPolicy ?? 'none',
			...(domain.dmarcSubdomainPolicy === undefined
				? {}
				: { dmarcSubdomainPolicy: domain.dmarcSubdomainPolicy }),
			...(domain.dmarcPct === undefined ? {} : { dmarcPct: domain.dmarcPct }),
			...(rua === undefined || rua === '' ? {} : { dmarcRua: rua }),
			spfQualifier: resolveSpfQualifier(getOptional('SPF_QUALIFIER')),
			// The From-domain SPF comes from the SAME variable the shipped provider
			// adapter uses, and is omitted with it — see streamSubdomainRecords.
			...(spfInclude === undefined || spfInclude === '' ? {} : { spfInclude }),
			// The relay terms authorise the BOUNCE host, and only it.
			returnPathRelaySpfTerms: relaySpfTerms,
			...(mailHost === undefined || mailHost === '' ? {} : { mailHost }),
			signingIdentities,
			referenceArmConfigured: referenceTransportConfigured(),
		});

		const bimiLogoUrl = getOptional('MTA_BIMI_LOGO_URL')?.trim();
		const bimiVmcUrl = getOptional('MTA_BIMI_VMC_URL')?.trim();
		const bimiSelector = getOptional('MTA_BIMI_SELECTOR')?.trim();
		const sending = [layout.subdomainsByRole.transactional, layout.subdomainsByRole.bulk];

		return {
			ok: true,
			domain: domain.domain,
			subdomains: layout.subdomains.map((entry) => ({
				role: entry.role,
				host: entry.host,
				relativeHost: entry.relativeHost,
				streams: [...entry.streams],
				pool: entry.pool,
				sends: entry.sends,
				alreadyRegistered: registeredByHost.has(entry.host),
			})),
			poolsCollapsed: layout.poolsCollapsed,
			advice: layout.advice.map((key) => ({ key, text: SUBDOMAIN_ADVICE_COPY[key] })),
			records: records.map(toRecordRow),
			warmingPlans: planSubdomainWarming(layout),
			bimiOffers: sending.map((entry) => ({
				host: entry.host,
				offer: offerBimiRecord({
					domain: entry.host,
					...(domain.dmarcPolicy === undefined ? {} : { dmarcPolicy: domain.dmarcPolicy }),
					...(domain.dmarcPct === undefined ? {} : { dmarcPct: domain.dmarcPct }),
					...(bimiLogoUrl === undefined || bimiLogoUrl === '' ? {} : { logoUrl: bimiLogoUrl }),
					...(bimiVmcUrl === undefined || bimiVmcUrl === '' ? {} : { vmcUrl: bimiVmcUrl }),
					...(bimiSelector === undefined || bimiSelector === '' ? {} : { selector: bimiSelector }),
				}),
			})),
		};
	},
});

/** Flatten one generated record onto the wire, value already resolved. */
function toRecordRow(record: StreamSubdomainRecord): StreamSubdomainRecordRow {
	return {
		subdomain: record.subdomain,
		host: record.host,
		relativeHost: record.relativeHost,
		purpose: record.purpose,
		type: record.type,
		value: streamSubdomainRecordValue(record),
		...(record.purpose === 'dkim' ? { arm: record.arm } : {}),
		...(record.purpose === 'mx' ? { priority: record.priority } : {}),
	};
}
