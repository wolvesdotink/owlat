'use node';

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalAction } from '../_generated/server';
import { sesProvider } from './providers/ses';
import { mergeSpfRecords } from './spf';
import type { DnsRecords } from './domains';

/** One publishable DNS plan for an MTA domain with an SES escape hatch. */
export function buildHybridSesRelayDnsRecords(primary: DnsRecords, ses: DnsRecords): DnsRecords {
	// An SES-only apex value is not an authoritative replacement for an
	// existing/manual SPF policy. Publish a merged value only when the primary
	// provider supplied the policy we are extending; otherwise omit it and let
	// the UI require an explicit reviewed merge.
	const spf =
		primary.spf && ses.spf
			? {
					...ses.spf,
					value: mergeSpfRecords(primary.spf.value, ses.spf.value),
				}
			: primary.spf;
	return {
		...(spf ? { spf } : {}),
		...(ses.dkim ? { dkim: ses.dkim } : {}),
		...(ses.mailFrom ? { mailFrom: ses.mailFrom } : {}),
	};
}

/** Provision a coexisting SES relay identity without changing the primary domain provider. */
export const provision = internalAction({
	args: { domainId: v.id('domains') },
	handler: async (ctx, args) => {
		const domain = await ctx.runQuery(internal.domains.queries.getDomainForRegistration, args);
		if (!domain || domain.providerType !== 'mta') return { provisioned: false };
		const { dnsRecords: sesDnsRecords, identity } = await sesProvider.registerDomain(
			domain.domain,
			{
				// Never collide with the owned MTA's bounce MX/SPF host.
				returnPathHost: `ses-mail.${domain.domain}`,
			}
		);
		const dnsRecords = buildHybridSesRelayDnsRecords(
			domain.dnsRecords as DnsRecords,
			sesDnsRecords
		);
		await ctx.runMutation(internal.domains.sesRelayMutations.storeProvisioning, {
			domainId: args.domainId,
			dkimTokens: identity.dkimTokens,
			verificationToken: identity.verificationToken,
			dnsRecords,
			spfProofState: dnsRecords.spf ? 'dns_required' : 'not_applicable_manual_primary',
		});
		return { provisioned: true };
	},
});
