/**
 * THE WIZARD SURFACE for the per-stream subdomain layout (P4-7, gap G-14).
 *
 * `streamSubdomains.ts` decides the layout, `streamSubdomainRecords.ts` renders
 * every record in one pass and `bimi.ts` decides the BIMI offer — all pure. This
 * module is the thin Convex shell that loads what those decisions need (the
 * domain row, its DKIM identity, the deployment's pool IPs and mail host) and
 * hands the UI ONE object: the proposal, the record table, the BIMI offer and
 * the per-subdomain warming plans.
 *
 * WHY A QUERY AND NOT A MUTATION. Nothing here writes: the wizard's job is to
 * tell the operator which names to create and what to publish on each. The
 * domain rows themselves are still created through the shipped Add-Domain flow,
 * one per sending subdomain — this screen is what tells them that is the layout
 * to create in the first place, which is exactly the gap G-14 names.
 *
 * D2 — NOTHING HERE IS LOAD-BEARING ON A THIRD PARTY. No relay, no ESP, no
 * commercial anything: with zero external credentials the table renders in full
 * and the reference-arm DKIM row simply is not part of it. An unusable domain
 * (no registrable zone) renders an explanation in place of the table rather
 * than an error state.
 */

import { v } from 'convex/values';
import { authedQuery } from '../lib/authedFunctions';
import { getOptional } from '../lib/env';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { offerBimiRecord, type BimiOffer } from './bimi';
import { parsePoolIpsLenient, parseReturnPathRelaySpfTerms, resolveSpfQualifier } from './spf';
import {
	generateStreamSubdomainRecords,
	type StreamSubdomainRecord,
} from './streamSubdomainRecords';
import {
	SUBDOMAIN_ADVICE_COPY,
	deriveSubdomainDkimSelectors,
	planSubdomainWarming,
	type SubdomainAdviceKey,
	type SubdomainWarmingPlan,
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
			records: StreamSubdomainRecord[];
			warmingPlans: SubdomainWarmingPlan[];
			/** One offer per SENDING subdomain — BIMI is evaluated per From domain. */
			bimiOffers: { host: string; offer: BimiOffer }[];
	  };

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

		const identity = await ctx.db
			.query('sendingDomainMtaIdentities')
			.withIndex('by_domain', (q) => q.eq('domainId', args.domainId))
			.first();

		// A typo in MTA_IP_POOLS must not take the screen down, so the wizard reads
		// the pool leniently (the registration path keeps the strict parser).
		const { ips } = parsePoolIpsLenient(getOptional('MTA_IP_POOLS'));
		const relaySpfTerms = parseReturnPathRelaySpfTerms(getOptional('MTA_RETURN_PATH_RELAY_SPF'));
		const mailHost = getOptional('EHLO_HOSTNAME')?.trim();
		const rua = getOptional('MTA_DMARC_RUA')?.trim();

		const generated = generateStreamSubdomainRecords({
			domain: domain.domain,
			sendingIps: ips,
			dkimSelectors: deriveSubdomainDkimSelectors(identity?.dkimSelector ?? 'owlat'),
			dmarcPolicy: domain.dmarcPolicy ?? 'none',
			...(domain.dmarcSubdomainPolicy === undefined
				? {}
				: { dmarcSubdomainPolicy: domain.dmarcSubdomainPolicy }),
			...(domain.dmarcPct === undefined ? {} : { dmarcPct: domain.dmarcPct }),
			...(rua === undefined || rua === '' ? {} : { dmarcRua: rua }),
			spfQualifier: resolveSpfQualifier(getOptional('SPF_QUALIFIER')),
			relaySpfTerms,
			...(mailHost === undefined || mailHost === '' ? {} : { mailHost }),
			// The relay arm exists exactly when the operator authorised one on the
			// bounce host. No relay ⇒ no second DKIM row, and nothing else changes.
			referenceArmConfigured: relaySpfTerms.length > 0,
		});
		if (!generated.ok) return { ok: false, reason: 'invalid_domain' };

		const { layout, records } = generated.recordSet;
		const sending = layout.subdomains.filter((entry) => entry.sends);

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
			})),
			poolsCollapsed: layout.poolsCollapsed,
			advice: layout.advice.map((key) => ({ key, text: SUBDOMAIN_ADVICE_COPY[key] })),
			records,
			warmingPlans: planSubdomainWarming(layout),
			bimiOffers: sending.map((entry) => ({
				host: entry.host,
				offer: offerBimiRecord({
					domain: entry.host,
					...(domain.dmarcPolicy === undefined ? {} : { dmarcPolicy: domain.dmarcPolicy }),
					...(domain.dmarcPct === undefined ? {} : { dmarcPct: domain.dmarcPct }),
				}),
			})),
		};
	},
});
