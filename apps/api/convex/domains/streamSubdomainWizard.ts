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
 * selector, DKIM value AND DMARC KNOBS are what the table shows — the wizard
 * republishes the shipped row rather than composing a rival one for the same
 * host. `_dmarc` in particular is a PER-FQDN record: a `news.` staged at
 * `p=none` keeps `p=none` here even when the operator opened an enforcing
 * `mail.`, and BIMI eligibility is judged on the same per-host policy. A host
 * that has not been added yet has no selector and no key, and the table says so
 * instead of filling the gap with a name nothing signs with.
 *
 * D2 — NOTHING HERE IS LOAD-BEARING ON A THIRD PARTY. No relay, no ESP, no
 * commercial anything: with zero external credentials the table renders in full
 * and the reference-arm DKIM row simply is not part of it. An unusable domain
 * (no registrable zone) renders an explanation in place of the table rather
 * than an error state.
 */

import { v } from 'convex/values';
import type { GovernedIpPool } from '@owlat/shared';
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { authedQuery } from '../lib/authedFunctions';
import { getOptional } from '../lib/env';
import { isSendProviderReady } from '../lib/sendProviders/capability';
import { listSendTransports } from '../lib/sendProviders/transports';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { offerBimiRecord, type BimiOffer } from './bimi';
import { DEFAULT_DMARC_POLICY } from './dmarc';
import { parsePoolIpsLenient, parseReturnPathRelaySpfTerms, resolveSpfQualifier } from './spf';
import {
	buildStreamSubdomainRecords,
	streamSubdomainRecordValue,
	type StreamSubdomainRecord,
	type SubdomainDmarcSettings,
	type SubdomainSigningIdentity,
} from './streamSubdomainRecords';
import {
	SIGNING_SUBDOMAIN_ROLES,
	SUBDOMAIN_ADVICE_COPY,
	planStreamSubdomains,
	planSubdomainWarming,
	type SendingStream,
	type SendingSubdomainRole,
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
	/** The layout's own union, kept on the wire so the UI's labels are TOTAL. */
	role: SendingSubdomainRole;
	host: string;
	relativeHost: string;
	streams: SendingStream[];
	pool: GovernedIpPool | null;
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
interface StreamSubdomainRecordRowBase {
	subdomain: string;
	host: string;
	relativeHost: string;
}

/**
 * The generated rows STAY A DISCRIMINATED UNION on the wire. Flattening them
 * into `arm?` / `priority?` would hand the UI a bag of optionals it has to
 * re-narrow by hand, and widening `purpose`/`type` to `string` would turn every
 * label map into a partial one with a `??` fallback that can never fire.
 */
export type StreamSubdomainRecordRow =
	| (StreamSubdomainRecordRowBase & { purpose: 'spf'; type: 'TXT'; value: string })
	| (StreamSubdomainRecordRowBase & { purpose: 'dmarc'; type: 'TXT'; value: string })
	| (StreamSubdomainRecordRowBase & {
			purpose: 'dkim';
			type: 'TXT';
			/** `null` when there is nothing to publish yet — never an empty `p=`. */
			value: string | null;
			arm: TransportArm;
	  })
	| (StreamSubdomainRecordRowBase & {
			purpose: 'mx';
			type: 'MX';
			value: string;
			priority: number;
	  });

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
 * deployment can ACTUALLY DISPATCH THROUGH is ready.
 *
 * D4 — the plugin/transport catalog is the single source of truth for "which
 * transports exist here". The return-path relay SPF env var is not: it
 * authorises a relay on the BOUNCE HOST and says nothing about whether a
 * transport is registered, so inferring one from the other gets both directions
 * wrong.
 *
 * READINESS, NOT ENV PRESENCE. A plugin-contributed kind also needs its bundled
 * capability grant before the worker will send through it, so credentials alone
 * would let the wizard state something untrue — a connected relay arm, and a
 * DKIM row for a transport that cannot dispatch. `isSendProviderReady` is the
 * shipped check both the route resolver and the worker use.
 *
 * Absence stays entirely non-blocking (D2): it removes one DKIM row from the
 * table and changes nothing else.
 */
async function referenceTransportConfigured(ctx: QueryCtx): Promise<boolean> {
	for (const transport of listSendTransports()) {
		if (transport.kind === 'mta') continue;
		if (await isSendProviderReady(ctx, transport.kind)) return true;
	}
	return false;
}

/**
 * One proposed host's DMARC knobs, from ITS OWN domain row.
 *
 * A host that has not been added yet falls back to `DEFAULT_DMARC_POLICY` —
 * monitor-only, which is exactly what registration will publish for it — rather
 * than to the knobs of the domain the operator happens to be viewing.
 */
function dmarcSettingsForHost(registered: Doc<'domains'> | undefined): SubdomainDmarcSettings {
	if (registered === undefined) return { policy: DEFAULT_DMARC_POLICY };
	return {
		policy: registered.dmarcPolicy ?? DEFAULT_DMARC_POLICY,
		...(registered.dmarcSubdomainPolicy === undefined
			? {}
			: { subdomainPolicy: registered.dmarcSubdomainPolicy }),
		...(registered.dmarcPct === undefined ? {} : { pct: registered.dmarcPct }),
	};
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
		for (const role of SIGNING_SUBDOMAIN_ROLES) {
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

		// PER-FQDN, from each proposed host's own row — see dmarcSettingsForHost.
		const dmarcByRole: Record<SigningSubdomainRole, SubdomainDmarcSettings> =
			SIGNING_SUBDOMAIN_ROLES.reduce<Record<SigningSubdomainRole, SubdomainDmarcSettings>>(
				(byRole, role) => {
					byRole[role] = dmarcSettingsForHost(
						registeredByHost.get(layout.subdomainsByRole[role].host)
					);
					return byRole;
				},
				// Seeded total so the Record stays total for every role, not a cast
				// over a map that a future role could silently leave a hole in.
				{ transactional: { policy: DEFAULT_DMARC_POLICY }, bulk: { policy: DEFAULT_DMARC_POLICY } }
			);

		const { records } = buildStreamSubdomainRecords(layout, {
			dmarcByRole,
			...(rua === undefined || rua === '' ? {} : { dmarcRua: rua }),
			spfQualifier: resolveSpfQualifier(getOptional('SPF_QUALIFIER')),
			// The From-domain SPF comes from the SAME variable the shipped provider
			// adapter uses, and is omitted with it — see streamSubdomainRecords.
			...(spfInclude === undefined || spfInclude === '' ? {} : { spfInclude }),
			// The relay terms authorise the BOUNCE host, and only it.
			returnPathRelaySpfTerms: relaySpfTerms,
			...(mailHost === undefined || mailHost === '' ? {} : { mailHost }),
			signingIdentities,
			referenceArmConfigured: await referenceTransportConfigured(ctx),
		});

		const bimiLogoUrl = getOptional('MTA_BIMI_LOGO_URL')?.trim();
		const bimiVmcUrl = getOptional('MTA_BIMI_VMC_URL')?.trim();
		const bimiSelector = getOptional('MTA_BIMI_SELECTOR')?.trim();

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
			// BIMI is evaluated against the DMARC of THE HOST THE RECORD IS PUBLISHED
			// ON — the same knobs its `_dmarc` row carries. Reading another host's
			// `p=` would offer a logo on a name at `p=none` (or withhold one from an
			// enforcing name) purely because of which domain the operator opened.
			bimiOffers: SIGNING_SUBDOMAIN_ROLES.map((role) => {
				const host = layout.subdomainsByRole[role].host;
				const dmarc = dmarcByRole[role];
				return {
					host,
					offer: offerBimiRecord({
						domain: host,
						dmarcPolicy: dmarc.policy,
						...(dmarc.pct === undefined ? {} : { dmarcPct: dmarc.pct }),
						...(bimiLogoUrl === undefined || bimiLogoUrl === '' ? {} : { logoUrl: bimiLogoUrl }),
						...(bimiVmcUrl === undefined || bimiVmcUrl === '' ? {} : { vmcUrl: bimiVmcUrl }),
						...(bimiSelector === undefined || bimiSelector === ''
							? {}
							: { selector: bimiSelector }),
					}),
				};
			}),
		};
	},
});

/** Put one generated record on the wire, value already resolved, union intact. */
function toRecordRow(record: StreamSubdomainRecord): StreamSubdomainRecordRow {
	const base = {
		subdomain: record.subdomain,
		host: record.host,
		relativeHost: record.relativeHost,
	};
	switch (record.purpose) {
		case 'dkim':
			return {
				...base,
				purpose: 'dkim',
				type: 'TXT',
				value: streamSubdomainRecordValue(record),
				arm: record.arm,
			};
		case 'mx':
			return { ...base, purpose: 'mx', type: 'MX', value: record.value, priority: record.priority };
		case 'spf':
			return { ...base, purpose: 'spf', type: 'TXT', value: record.value };
		case 'dmarc':
			return { ...base, purpose: 'dmarc', type: 'TXT', value: record.value };
	}
}
