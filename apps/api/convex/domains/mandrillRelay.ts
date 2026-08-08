'use node';

/**
 * The Mandrill sending-domain identity's two provider calls, as scheduled work.
 *
 * `provision` mirrors `sesRelay.provision`: a domain whose PRIMARY provider is
 * our own MTA also gets registered at Mandrill when the deployment's fallback
 * configuration names Mandrill as its relay, so the migration arm (plan D8) has
 * a verified identity to send under without the operator connecting the domain
 * twice.
 *
 * `refreshIdentity` is the per-domain half of the re-check sweep — one
 * `senders/check-domain` call, whose verdict is persisted by the mutation in
 * `mandrillRelayMutations.ts`. It is an ACTION because it talks to the network;
 * everything it decides is decided in the pure module it calls.
 *
 * There is no DNS crawl anywhere here, unlike the SES relay's refresher:
 * Mandrill resolves the records from its own view and reports them, so a second
 * opinion from our resolver would only add a way for the two to disagree.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalAction } from '../_generated/server';
import { checkSenderDomain } from './providers/mandrill/api';
import { buildMandrillIdentity } from './providers/mandrill/identity';
import { mandrillProvider } from './providers/mandrill';

/**
 * Provision a coexisting Mandrill relay identity without changing the primary
 * domain provider.
 *
 * Skipped when Mandrill IS the primary provider: that domain's identity is
 * owned by the ordinary lifecycle (`register_with_provider` → `writeIdentity`),
 * and registering it a second time here would race the same row.
 */
export const provision = internalAction({
	args: { domainId: v.id('domains') },
	handler: async (ctx, args): Promise<{ provisioned: boolean }> => {
		const domain = await ctx.runQuery(internal.domains.queries.getDomainForRegistration, args);
		if (!domain || domain.providerType === 'mandrill') return { provisioned: false };
		const { identity } = await mandrillProvider.registerDomain(domain.domain);
		await ctx.runMutation(internal.domains.mandrillRelayMutations.storeIdentity, {
			domainId: args.domainId,
			identity,
		});
		return { provisioned: true };
	},
});

/**
 * Re-ask Mandrill about one domain and persist what it says.
 *
 * Keyed by domain NAME rather than by `domainId` because the sweep that
 * schedules it walks identity ROWS (which carry the name, not an id) — and
 * because a relay identity may outlive, or never have had, a `domains` row of
 * its own kind.
 *
 * The three outcomes are forwarded intact: only `checked` is evidence, and the
 * mutation is what decides that a failure may not overwrite a verdict or
 * refresh the proof's age.
 */
export const refreshIdentity = internalAction({
	args: { domain: v.string() },
	handler: async (ctx, args): Promise<{ outcome: 'checked' | 'auth_failed' | 'unavailable' }> => {
		const result = await checkSenderDomain(args.domain);
		if (result.outcome === 'ok') {
			await ctx.runMutation(internal.domains.mandrillRelayMutations.recordCheck, {
				domain: args.domain,
				identity: buildMandrillIdentity(result.state, Date.now()),
			});
			return { outcome: 'checked' };
		}
		await ctx.runMutation(internal.domains.mandrillRelayMutations.recordCheckFailure, {
			domain: args.domain,
			isAuthFailure: result.outcome === 'auth_failed',
			error: result.error,
		});
		return { outcome: result.outcome };
	},
});
