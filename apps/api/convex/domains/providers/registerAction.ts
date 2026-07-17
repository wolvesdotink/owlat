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
import { createMtaIdentityManager } from '../../lib/emailProviders/mtaIdentity';
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
			// Thread the domain's per-domain VERP return-path host (D1/D2) so the
			// adapter reflects it to the provider and builds the `mailFrom` SPF
			// record on that host. Absent ⇒ the adapter falls back to the global
			// `MTA_RETURN_PATH_DOMAIN` (historic behavior).
			const { dnsRecords, identity } = await adapter.registerDomain(domain.domain, {
				returnPathHost: domain.returnPathHost,
			});

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
				`[${tag}] Domain ${domain.domain} registered successfully with ${adapter.describeIdentity(identity)}`
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

/**
 * Reflect a domain's changed per-domain VERP return-path host (D1/D2) to the
 * MTA, out-of-band from the `setReturnPathHost` mutation that regenerated the
 * Convex-side `mailFrom` record. POSTs the host to the D1 register endpoint,
 * which is idempotent for the DKIM key — so this sets ONLY the return-path host
 * and never disturbs the signing key. MTA-only: SES has no return-path host.
 *
 * Best-effort (no lifecycle transition): the Convex-side record + status were
 * already committed by the mutation; a transient MTA failure is logged and left
 * for the next re-registration to reconcile, rather than rolling back the edit.
 */
export const pushReturnPathHost = internalAction({
	args: {
		domainId: v.id('domains'),
		returnPathHost: v.string(),
	},
	handler: async (ctx, args) => {
		const domain = await ctx.runQuery(internal.domains.queries.getDomainForRegistration, {
			domainId: args.domainId,
		});
		if (!domain) {
			logError(`[MTA] Domain ${args.domainId} not found, skipping return-path host push`);
			return;
		}
		if (domain.providerType !== 'mta') {
			// Should not happen — the mutation gates on providerType — but stay safe.
			logError(`[MTA] Domain ${domain.domain} is not MTA-provider; skipping return-path host push`);
			return;
		}

		try {
			const mta = createMtaIdentityManager();
			await mta.registerDomain(domain.domain, args.returnPathHost);
			logInfo(
				`[MTA] Return-path host for ${domain.domain} set to ${args.returnPathHost} on the MTA`
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown MTA error';
			logError(
				`[MTA] Failed to push return-path host ${args.returnPathHost} for ${domain.domain}:`,
				message
			);
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
