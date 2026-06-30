'use node';

/**
 * Generic `register_with_provider` and `delete_with_provider` effect handlers.
 *
 * Scheduled by the **Sending domain lifecycle (module)** at
 * `convex/domains/lifecycle.ts`. The lifecycle passes the domain's
 * `providerType`; this action resolves the adapter via `providerFor(kind)`
 * and runs the provider API call, then calls back into the lifecycle's
 * `transition` to land the `registering → pending` / `registering → failed`
 * outcome atomically. The lifecycle never branches on `providerType` — the
 * provider variation lives entirely behind the `providerFor` seam.
 *
 * Per ADR-0018.
 */

import { v } from 'convex/values';
import { internalAction } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { logError, logInfo } from '../../lib/runtimeLog';
import { providerFor } from './index';
import type { SendingDomainProviderKind } from './types';

const LIFECYCLE_USER_PROVIDER_REGISTER = 'system:provider_register';

const providerKind = v.union(v.literal('mta'), v.literal('ses'));

export const run = internalAction({
	args: {
		providerType: providerKind,
		domainId: v.id('domains'),
	},
	handler: async (ctx, args) => {
		const kind = args.providerType as SendingDomainProviderKind;
		const tag = kind.toUpperCase();
		const adapter = providerFor(kind);

		const domain = await ctx.runQuery(internal.domains.queries.getDomainForRegistration, {
			domainId: args.domainId,
		});
		if (!domain) {
			logError(`[${tag}] Domain ${args.domainId} not found, skipping registration`);
			return;
		}

		const at = Date.now();
		try {
			const { dnsRecords, identity } = await adapter.registerDomain(domain.domain);

			await ctx.runMutation(internal.domains.lifecycle.transition, {
				domainId: args.domainId,
				input: {
					to: 'pending',
					at,
					dnsRecords,
					identity,
				},
				userId: LIFECYCLE_USER_PROVIDER_REGISTER,
			});

			logInfo(
				`[${tag}] Domain ${domain.domain} registered successfully with ${adapter.describeIdentity(identity)}`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : `Unknown ${tag} error`;
			logError(`[${tag}] Failed to register domain ${domain.domain}:`, message);

			await ctx.runMutation(internal.domains.lifecycle.transition, {
				domainId: args.domainId,
				input: {
					to: 'failed',
					at,
					error: message,
				},
				userId: LIFECYCLE_USER_PROVIDER_REGISTER,
			});
		}
	},
});

export const deleteDomainAction = internalAction({
	args: {
		providerType: providerKind,
		domain: v.string(),
	},
	handler: async (_ctx, args) => {
		const kind = args.providerType as SendingDomainProviderKind;
		const tag = kind.toUpperCase();
		const adapter = providerFor(kind);
		try {
			await adapter.deleteFromProvider(args.domain);
			logInfo(`[${tag}] Domain ${args.domain} deleted from provider`);
		} catch (error) {
			const message = error instanceof Error ? error.message : `Unknown ${tag} error`;
			logError(`[${tag}] Failed to delete domain ${args.domain} from provider:`, message);
			// Best-effort — the domain row is already gone.
		}
	},
});
