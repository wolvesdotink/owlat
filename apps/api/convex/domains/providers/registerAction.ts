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
import { internalAction, type ActionCtx } from '../../_generated/server';
import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { logError, logInfo, logWarn } from '../../lib/runtimeLog';
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
		let registered = false;
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
			registered = true;

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

		// Reconcile a return-path edit that committed while our (slow) provider I/O
		// ran: the `registering` guard in `setReturnPathHost` deferred its records to
		// us, but we built `dnsRecords`/reflected for the host as read at the top. This
		// serializable mutation regenerates the records + reflects the CURRENT host
		// when it moved, closing the register-vs-edit window (a same-host re-save would
		// otherwise short-circuit and never self-heal). Run OUTSIDE the try and only on
		// success: registration itself is already committed, so an exotic reconcile
		// throw (e.g. SES with a missing region) must not poison a registered domain
		// back to `failed`; and on a failed registration there is nothing to reconcile.
		if (registered) {
			await ctx.runMutation(internal.domains.lifecycle.reconcileReturnPathAfterRegistration, {
				domainId: args.domainId,
				registeredReturnPathHost: domain.returnPathHost,
				userId: LIFECYCLE_USER_PROVIDER_REGISTER,
			});
		}
	},
});

// Bounded retry budget for reflecting a changed return-path host to a provider.
// 5 attempts over exponential backoff (30s, 60s, 120s, 240s → ~8min total)
// rides out a transient provider outage; exhausting it is a permanent failure
// that is surfaced (audit + `returnPathHostSyncError` marker), never swallowed.
const RETURN_PATH_REFLECT_MAX_ATTEMPTS = 5;
const RETURN_PATH_REFLECT_BASE_DELAY_MS = 30_000;
const LIFECYCLE_USER_RETURN_PATH_PUSH = 'system:return_path_push';
const LIFECYCLE_USER_SES_MAILFROM_REFLECT = 'system:ses_mailfrom_reflect';

/** Args shared by every return-path reflection action. */
interface ReflectArgs {
	domainId: Id<'domains'>;
	returnPathHost: string;
	attempt?: number;
}

/**
 * The provider-specific outcome of a single reflection attempt:
 *   - `done`      — the provider call succeeded; `describe` is a log-friendly
 *                   name for the reflected target.
 *   - `permanent` — a non-transient failure (e.g. a host that is not a valid SES
 *                   MAIL FROM subdomain): do NOT retry, record the give-up now.
 * A thrown error is treated as transient (retry within the budget).
 */
type ReflectionOutcome =
	| { kind: 'done'; describe: string }
	| { kind: 'permanent'; message: string };

/** Per-provider configuration for {@link runReturnPathReflection}. */
interface ReflectionConfig {
	/** Short tag for log lines (`MTA` / `SES`). */
	readonly tag: string;
	/** The provider this reflection is for; a mismatched domain is skipped. */
	readonly providerType: SendingDomainProviderKind;
	/** `userId` tag threaded into `recordReturnPathPushResult`. */
	readonly userId: string;
	/**
	 * Re-enqueue this same action — for the next retry attempt of the same host,
	 * or (finding 4) to converge the provider onto a host that superseded ours
	 * mid-reflection. A closure (rather than a typed `FunctionReference`
	 * self-reference) on purpose: naming the action's own generated reference in a
	 * field type is circular and collapses Convex's whole `internal`/`DataModel`
	 * inference — using it only as a `scheduler.runAfter` argument inside the
	 * closure is safe.
	 */
	readonly reschedule: (delayMs: number, nextAttempt: number, host: string) => Promise<unknown>;
	/** Perform the provider-specific reflection (may throw for transient errors). */
	readonly perform: (domain: Doc<'domains'>) => Promise<ReflectionOutcome>;
}

/**
 * Shared retry/supersession/give-up machinery for reflecting a changed
 * per-domain return-path host to a provider (MTA push, SES MAIL FROM). Extracted
 * so the concurrency-sensitive loop lives in ONE place — `pushReturnPathHost`
 * (MTA) and `reflectSesMailFrom` (SES) differ only in `config.perform` (the
 * actual provider API call) and their identity/logging.
 *
 * Recovery: on a thrown (transient) failure it self-reschedules with exponential
 * backoff up to `RETURN_PATH_REFLECT_MAX_ATTEMPTS`; on exhaustion — or a
 * `permanent` outcome — it records a give-up via `recordReturnPathPushResult`
 * (an audit row + the `returnPathHostSyncError` marker), so a permanent
 * divergence is never silent.
 *
 * Concurrency (finding 4): two edits racing can reflect out of order. Two guards
 * keep the provider from silently diverging, without a generation token:
 *   - BEFORE the provider call, we re-read `returnPathHost` and skip a chain
 *     whose host was already superseded (the common case).
 *   - AFTER a successful provider call, we re-read again: if the host changed
 *     under us (a newer edit committed while our slow I/O ran, and we may have
 *     finished LAST — leaving the provider on our now-stale host), we do NOT
 *     clear the marker for the stale host; we requeue a fresh reflection for the
 *     CURRENT host so the provider CONVERGES to the last edit rather than being
 *     stuck on an earlier one.
 * The marker/audit path is additionally serializable: `recordReturnPathPushResult`
 * re-checks the host, so a stale give-up can never mark a domain that moved on.
 */
async function runReturnPathReflection(
	ctx: ActionCtx,
	args: ReflectArgs,
	config: ReflectionConfig
): Promise<void> {
	const attempt = args.attempt ?? 0;
	const { tag } = config;

	const domain = await ctx.runQuery(internal.domains.queries.getDomainForRegistration, {
		domainId: args.domainId,
	});
	if (!domain) {
		logError(`[${tag}] Domain ${args.domainId} not found, skipping return-path reflection`);
		return;
	}
	if (domain.providerType !== config.providerType) {
		// Should not happen — the mutation gates on providerType — but stay safe.
		logError(
			`[${tag}] Domain ${domain.domain} is not ${config.providerType}-provider; skipping return-path reflection`
		);
		return;
	}
	if (domain.returnPathHost !== args.returnPathHost) {
		logInfo(
			`[${tag}] Return-path host for ${domain.domain} changed since this reflection was queued; abandoning stale attempt`
		);
		return;
	}

	const recordGiveUp = (message: string, attempts: number) =>
		ctx.runMutation(internal.domains.lifecycle.recordReturnPathPushResult, {
			domainId: args.domainId,
			returnPathHost: args.returnPathHost,
			error: message,
			attempts,
			userId: config.userId,
		});

	let outcome: ReflectionOutcome;
	try {
		outcome = await config.perform(domain);
	} catch (error) {
		const message = error instanceof Error ? error.message : `Unknown ${tag} error`;
		const nextAttempt = attempt + 1;
		if (nextAttempt < RETURN_PATH_REFLECT_MAX_ATTEMPTS) {
			const delayMs = RETURN_PATH_REFLECT_BASE_DELAY_MS * 2 ** attempt;
			logError(
				`[${tag}] Failed to reflect return-path host ${args.returnPathHost} for ${domain.domain} (attempt ${nextAttempt}/${RETURN_PATH_REFLECT_MAX_ATTEMPTS}), retrying in ${delayMs}ms:`,
				message
			);
			await config.reschedule(delayMs, nextAttempt, args.returnPathHost);
			return;
		}
		// Budget exhausted — permanent divergence. Surface it.
		logError(
			`[${tag}] Giving up on return-path reflection ${args.returnPathHost} for ${domain.domain} after ${RETURN_PATH_REFLECT_MAX_ATTEMPTS} attempts:`,
			message
		);
		await recordGiveUp(message, RETURN_PATH_REFLECT_MAX_ATTEMPTS);
		return;
	}

	if (outcome.kind === 'permanent') {
		// Non-transient (config) failure — no retry would ever succeed. Surface it.
		logError(`[${tag}] ${outcome.message}; cannot reflect return-path host for ${domain.domain}`);
		await recordGiveUp(outcome.message, attempt);
		return;
	}

	// Finding 4 — post-call re-read: a newer edit may have committed a different
	// host while our (possibly slow) provider call ran. If so, the provider is now
	// on OUR host but the DB wants the newer one, and we may have finished last.
	// Requeue a fresh reflection for the CURRENT host so the provider converges,
	// and do NOT clear the marker for our now-stale host (the requeued chain owns
	// the marker for the current host).
	const current = await ctx.runQuery(internal.domains.queries.getDomainForRegistration, {
		domainId: args.domainId,
	});
	const currentHost = current?.returnPathHost;
	if (current && currentHost !== args.returnPathHost) {
		// A newer edit superseded our host mid-reflection. Converge the provider on
		// the current host (requeue) rather than clearing the marker for our stale
		// host. If a future "clear" path ever sets the host back to `undefined`,
		// there is nothing to reflect here — leave the marker for that path to own —
		// so requeue ONLY for a concrete host (this replaces a `!== undefined` guard
		// that would have SILENTLY skipped convergence in the clear case).
		if (currentHost !== undefined) {
			logWarn(
				`[${tag}] Return-path host for ${current.domain} changed to ${currentHost} while reflecting ${args.returnPathHost}; requeueing to converge the provider on the current host`
			);
			await config.reschedule(0, 0, currentHost);
		}
		return;
	}

	logInfo(`[${tag}] Return-path host for ${domain.domain} reflected as ${outcome.describe}`);
	// Success — clear any prior sync-failure marker.
	await ctx.runMutation(internal.domains.lifecycle.recordReturnPathPushResult, {
		domainId: args.domainId,
		returnPathHost: args.returnPathHost,
		userId: config.userId,
	});
}

/**
 * Reflect a domain's changed per-domain VERP return-path host (D1/D2) to the
 * MTA. POSTs the host to the D1 register endpoint, which is idempotent for the
 * DKIM key — so this sets ONLY the return-path host, never the signing key.
 * All retry/supersession/give-up handling lives in {@link runReturnPathReflection}.
 */
export const pushReturnPathHost = internalAction({
	args: {
		domainId: v.id('domains'),
		returnPathHost: v.string(),
		attempt: v.optional(v.number()),
	},
	// Block-body async with an explicit `Promise<void>`: the `reschedule` closure
	// names this action's own generated reference, so an inferred return type would
	// be self-referential and collapse Convex's whole `internal`/`DataModel`
	// inference. The annotation breaks that cycle.
	handler: async (ctx, args): Promise<void> => {
		await runReturnPathReflection(ctx, args, {
			tag: 'MTA',
			providerType: 'mta',
			userId: LIFECYCLE_USER_RETURN_PATH_PUSH,
			reschedule: (delayMs, nextAttempt, host) =>
				ctx.scheduler.runAfter(
					delayMs,
					internal.domains.providers.registerAction.pushReturnPathHost,
					{ domainId: args.domainId, returnPathHost: host, attempt: nextAttempt }
				),
			perform: async (domain) => {
				const mta = createMtaIdentityManager();
				await mta.registerDomain(domain.domain, args.returnPathHost);
				return { kind: 'done', describe: args.returnPathHost };
			},
		});
	},
});

/**
 * Reflect a domain's changed per-domain return-path host to SES (X1) via
 * `SetIdentityMailFromDomain`, using the MAIL FROM subdomain derived from the
 * host. A host that is not a subdomain of the sending domain is a permanent
 * (non-retryable) failure. All retry/supersession/give-up handling lives in
 * {@link runReturnPathReflection}.
 */
export const reflectSesMailFrom = internalAction({
	args: {
		domainId: v.id('domains'),
		returnPathHost: v.string(),
		attempt: v.optional(v.number()),
	},
	// Block-body async with an explicit `Promise<void>` — see pushReturnPathHost.
	handler: async (ctx, args): Promise<void> => {
		await runReturnPathReflection(ctx, args, {
			tag: 'SES',
			providerType: 'ses',
			userId: LIFECYCLE_USER_SES_MAILFROM_REFLECT,
			reschedule: (delayMs, nextAttempt, host) =>
				ctx.scheduler.runAfter(
					delayMs,
					internal.domains.providers.registerAction.reflectSesMailFrom,
					{ domainId: args.domainId, returnPathHost: host, attempt: nextAttempt }
				),
			perform: async (domain) => {
				const mailFrom = resolveSesMailFrom(domain.domain, args.returnPathHost);
				if (!mailFrom) {
					return {
						kind: 'permanent',
						message: `Return-path host ${args.returnPathHost} is not a subdomain of ${domain.domain}`,
					};
				}
				const ses = createSESIdentityManager();
				await ses.setupMailFromDomain(domain.domain, mailFrom.host);
				return { kind: 'done', describe: mailFrom.mailFromDomain };
			},
		});
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
