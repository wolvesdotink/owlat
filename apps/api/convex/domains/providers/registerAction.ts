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
import { createSESIdentityManager } from '../../lib/emailProviders/sesIdentity';
import { providerFor } from './index';
import { resolveSesMailFrom } from './ses/mailFrom';
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

// Bounded retry budget for reflecting a changed return-path host to the MTA.
// 5 attempts over exponential backoff (30s, 60s, 120s, 240s → ~8min total)
// rides out a transient MTA outage; exhausting it is a permanent failure that
// is surfaced (audit + `returnPathHostSyncError` marker), never swallowed.
const RETURN_PATH_PUSH_MAX_ATTEMPTS = 5;
const RETURN_PATH_PUSH_BASE_DELAY_MS = 30_000;
const LIFECYCLE_USER_RETURN_PATH_PUSH = 'system:return_path_push';

/**
 * Reflect a domain's changed per-domain VERP return-path host (D1/D2) to the
 * MTA, out-of-band from the `setReturnPathHost` mutation that regenerated the
 * Convex-side `mailFrom` record. POSTs the host to the D1 register endpoint,
 * which is idempotent for the DKIM key — so this sets ONLY the return-path host
 * and never disturbs the signing key. MTA-only: SES has no return-path host.
 *
 * Recovery: on failure it self-reschedules with exponential backoff up to
 * `RETURN_PATH_PUSH_MAX_ATTEMPTS`. If the budget is exhausted the divergence is
 * PERMANENT (Convex committed the new host; the MTA still stamps the old one),
 * so it records a give-up via `recordReturnPathPushResult` — an audit row plus
 * the `returnPathHostSyncError` marker on the domain — rather than failing
 * silently.
 *
 * Concurrency: the MTA push itself is best-effort last-writer-wins — two edits
 * racing can POST to the MTA in either order, and there is no generation token
 * (return-path edits are rare, so one was deemed not worth the ceremony). The
 * best-effort `returnPathHost` re-read below skips a chain whose target host has
 * already been superseded, which collapses the common case, but a narrow
 * double-interleaving can still leave the MTA on a superseded host; that is
 * reconciled by the NEXT edit's push (which POSTs the then-current host). Only
 * the marker/audit path is strongly race-safe: `recordReturnPathPushResult` is a
 * serializable mutation that re-checks the host, so a stale give-up can never
 * mark a domain that has already moved on.
 */
export const pushReturnPathHost = internalAction({
	args: {
		domainId: v.id('domains'),
		returnPathHost: v.string(),
		attempt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const attempt = args.attempt ?? 0;
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
		// Best-effort supersession: if a newer edit already changed the target host,
		// abandon this chain — its own push is reflecting the current host. This is
		// a narrowing check, not a guarantee: without a generation token a push that
		// reads the host before a concurrent edit commits can still POST a
		// superseded host (last-writer-wins), reconciled by that edit's own push.
		if (domain.returnPathHost !== args.returnPathHost) {
			logInfo(
				`[MTA] Return-path host for ${domain.domain} changed since this push was queued; abandoning stale attempt`
			);
			return;
		}

		try {
			const mta = createMtaIdentityManager();
			await mta.registerDomain(domain.domain, args.returnPathHost);
			logInfo(
				`[MTA] Return-path host for ${domain.domain} set to ${args.returnPathHost} on the MTA`
			);
			// Success — clear any prior sync-failure marker.
			await ctx.runMutation(internal.domains.lifecycle.recordReturnPathPushResult, {
				domainId: args.domainId,
				returnPathHost: args.returnPathHost,
				userId: LIFECYCLE_USER_RETURN_PATH_PUSH,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown MTA error';
			const nextAttempt = attempt + 1;
			if (nextAttempt < RETURN_PATH_PUSH_MAX_ATTEMPTS) {
				const delayMs = RETURN_PATH_PUSH_BASE_DELAY_MS * 2 ** attempt;
				logError(
					`[MTA] Failed to push return-path host ${args.returnPathHost} for ${domain.domain} (attempt ${nextAttempt}/${RETURN_PATH_PUSH_MAX_ATTEMPTS}), retrying in ${delayMs}ms:`,
					message
				);
				await ctx.scheduler.runAfter(
					delayMs,
					internal.domains.providers.registerAction.pushReturnPathHost,
					{ domainId: args.domainId, returnPathHost: args.returnPathHost, attempt: nextAttempt }
				);
				return;
			}

			// Budget exhausted — permanent divergence. Surface it.
			logError(
				`[MTA] Giving up on return-path host push ${args.returnPathHost} for ${domain.domain} after ${RETURN_PATH_PUSH_MAX_ATTEMPTS} attempts:`,
				message
			);
			await ctx.runMutation(internal.domains.lifecycle.recordReturnPathPushResult, {
				domainId: args.domainId,
				returnPathHost: args.returnPathHost,
				error: message,
				attempts: RETURN_PATH_PUSH_MAX_ATTEMPTS,
				userId: LIFECYCLE_USER_RETURN_PATH_PUSH,
			});
		}
	},
});

const LIFECYCLE_USER_SES_MAILFROM_REFLECT = 'system:ses_mailfrom_reflect';

/**
 * Reflect a domain's changed per-domain return-path host to SES (X1), out-of-band
 * from the `setReturnPathHost` mutation that regenerated the Convex-side SES MAIL
 * FROM records. Calls SES `SetIdentityMailFromDomain` with the MAIL FROM subdomain
 * derived from the host. Idempotent at SES. SES-only.
 *
 * Structurally identical to `pushReturnPathHost`: bounded self-rescheduling retry
 * on failure, a permanent give-up recorded via `recordReturnPathPushResult`
 * (audit + `returnPathHostSyncError` marker) so a permanent divergence is never
 * silent, and the same best-effort last-writer-wins supersession check (no
 * generation token — return-path edits are rare; a narrow interleaving reconciles
 * on the next edit, and only the marker/audit path is strongly race-safe).
 */
export const reflectSesMailFrom = internalAction({
	args: {
		domainId: v.id('domains'),
		returnPathHost: v.string(),
		attempt: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const attempt = args.attempt ?? 0;
		const domain = await ctx.runQuery(internal.domains.queries.getDomainForRegistration, {
			domainId: args.domainId,
		});
		if (!domain) {
			logError(`[SES] Domain ${args.domainId} not found, skipping MAIL FROM reflection`);
			return;
		}
		if (domain.providerType !== 'ses') {
			logError(`[SES] Domain ${domain.domain} is not SES-provider; skipping MAIL FROM reflection`);
			return;
		}
		// Best-effort supersession (see pushReturnPathHost): a newer edit changed
		// the target host, so this chain is stale.
		if (domain.returnPathHost !== args.returnPathHost) {
			logInfo(
				`[SES] MAIL FROM host for ${domain.domain} changed since this reflection was queued; abandoning stale attempt`
			);
			return;
		}

		const mailFrom = resolveSesMailFrom(domain.domain, args.returnPathHost);
		if (!mailFrom) {
			// The mutation validated the subdomain constraint, so this is a permanent
			// config error rather than transient — record it and stop (no retry).
			const message = `Return-path host ${args.returnPathHost} is not a subdomain of ${domain.domain}`;
			logError(`[SES] ${message}; cannot set MAIL FROM`);
			await ctx.runMutation(internal.domains.lifecycle.recordReturnPathPushResult, {
				domainId: args.domainId,
				returnPathHost: args.returnPathHost,
				error: message,
				attempts: attempt,
				userId: LIFECYCLE_USER_SES_MAILFROM_REFLECT,
			});
			return;
		}

		try {
			const ses = createSESIdentityManager();
			await ses.setupMailFromDomain(domain.domain, mailFrom.host);
			logInfo(`[SES] Custom MAIL FROM for ${domain.domain} set to ${mailFrom.mailFromDomain}`);
			await ctx.runMutation(internal.domains.lifecycle.recordReturnPathPushResult, {
				domainId: args.domainId,
				returnPathHost: args.returnPathHost,
				userId: LIFECYCLE_USER_SES_MAILFROM_REFLECT,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown SES error';
			const nextAttempt = attempt + 1;
			if (nextAttempt < RETURN_PATH_PUSH_MAX_ATTEMPTS) {
				const delayMs = RETURN_PATH_PUSH_BASE_DELAY_MS * 2 ** attempt;
				logError(
					`[SES] Failed to set MAIL FROM ${mailFrom.mailFromDomain} for ${domain.domain} (attempt ${nextAttempt}/${RETURN_PATH_PUSH_MAX_ATTEMPTS}), retrying in ${delayMs}ms:`,
					message
				);
				await ctx.scheduler.runAfter(
					delayMs,
					internal.domains.providers.registerAction.reflectSesMailFrom,
					{ domainId: args.domainId, returnPathHost: args.returnPathHost, attempt: nextAttempt }
				);
				return;
			}

			logError(
				`[SES] Giving up on MAIL FROM ${mailFrom.mailFromDomain} for ${domain.domain} after ${RETURN_PATH_PUSH_MAX_ATTEMPTS} attempts:`,
				message
			);
			await ctx.runMutation(internal.domains.lifecycle.recordReturnPathPushResult, {
				domainId: args.domainId,
				returnPathHost: args.returnPathHost,
				error: message,
				attempts: RETURN_PATH_PUSH_MAX_ATTEMPTS,
				userId: LIFECYCLE_USER_SES_MAILFROM_REFLECT,
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
