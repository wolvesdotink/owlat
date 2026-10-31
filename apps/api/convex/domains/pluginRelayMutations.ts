/**
 * The transactional half of a bundled plugin's sending-domain identity:
 * persist what a provider call found.
 *
 * Split from `pluginRelay.ts` for the runtime reason every `*Mutations.ts`
 * sibling here is (`mandrillRelayMutations.ts` is the same pair): that file is an
 * action that talks to a provider, this one runs in the V8 transaction and
 * touches the database. The WRITE RULES themselves live one level down, in
 * `providers/plugin/persistence.ts`, so the backfill and these mutations cannot
 * write the same row two different ways.
 *
 * THE ARGUMENTS ARE ALREADY HOST-VALIDATED. `observation` is what
 * `parsePluginRelayResult` made of a third-party module's return value — a
 * derived status, bounded record verdicts, bounded DNS facts — never the module's
 * own object. The validators below are the second reading, of the wire between
 * two host functions.
 */

import { v } from 'convex/values';
import {
	markPluginRelayIdentityFailed,
	schedulePluginRelayRetry,
	upsertPluginRelayIdentity,
} from './providers/plugin/persistence';
import {
	PLUGIN_DENIED_RETRY_MS,
	PLUGIN_UNAVAILABLE_RETRY_MS,
	type PluginRelayObservation,
} from './providers/plugin/state';
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { relayIdentityStatusValidator } from '../lib/literalValidators';
import {
	authorizeIdentityCallIn,
	recordIdentityCallOutcome,
} from '../plugins/sendTransportDomainIdentityAuthorization';

const recordVerdictValidator = v.object({
	isValid: v.boolean(),
	error: v.optional(v.string()),
});

/** The host's reading of one provider observation, on its way to the row. */
const observationValidator = v.object({
	status: relayIdentityStatusValidator,
	spf: recordVerdictValidator,
	dkim: recordVerdictValidator,
	dkimSelectors: v.array(v.string()),
	spfMechanisms: v.array(v.string()),
});

/**
 * What one identity call came back with, as the host read it: a verdict, or a
 * failure (a rejected credential, a missing one, an outage, an unreadable
 * answer).
 *
 * A verdict's `checkedAt` is the caller's, not `Date.now()`: it dates the
 * EVIDENCE, and the relay proof's freshness bound reads it. Stamping the write
 * time would let a row written long after the call it describes look fresher
 * than the fact it holds.
 */
const callResultValidator = v.union(
	v.object({
		outcome: v.literal('ok'),
		observation: observationValidator,
		checkedAt: v.number(),
	}),
	v.object({
		outcome: v.literal('failed'),
		isAuthFailure: v.boolean(),
		error: v.string(),
	})
);

/**
 * The one write of an identity call that got as far as asking the provider, or
 * that a missing credential stopped: the row's verdict or failure, and the
 * call's audited outcome, in one transaction.
 *
 * Authorization is not rechecked here. The provider call has already happened
 * by now, and what it found is evidence about the domain whether or not the
 * plugin is still enabled.
 */
export const commitIdentityCall = internalMutation({
	args: {
		pluginId: v.string(),
		kind: v.string(),
		domain: v.string(),
		result: callResultValidator,
	},
	handler: async (ctx, args) => {
		const { result } = args;
		if (result.outcome === 'ok') {
			await upsertPluginRelayIdentity(
				ctx,
				args.kind,
				args.domain,
				result.observation as PluginRelayObservation,
				result.checkedAt
			);
		} else {
			await writeCheckFailure(ctx, args.kind, args.domain, result.isAuthFailure, result.error);
		}
		await recordIdentityCallOutcome(
			ctx,
			args.pluginId,
			args.kind,
			result.outcome === 'ok' ? 'completed' : 'failed'
		);
	},
});

/**
 * The one write of an identity call the host refused to make. Rechecks the
 * authorization in this transaction, which audits the refusal, and moves the
 * retry for the reasons `deferDeniedCheck` gives. A plugin re-enabled since the
 * action's read gets nothing written: its row stays due and the next sweep
 * asks the provider.
 */
export const commitDeniedCall = internalMutation({
	args: { pluginId: v.string(), kind: v.string(), domain: v.string() },
	handler: async (ctx, args): Promise<{ isDenied: boolean }> => {
		if (await authorizeIdentityCallIn(ctx, args.pluginId, args.kind)) {
			return { isDenied: false };
		}
		await schedulePluginRelayRetry(ctx, args.kind, args.domain, Date.now(), PLUGIN_DENIED_RETRY_MS);
		return { isDenied: true };
	},
});

/**
 * Persist a call that produced a verdict. Kept for one release: identity
 * actions of the previous release still call it by path during the deploy.
 * Remove after release 0.6.17.
 */
export const recordCheck = internalMutation({
	args: {
		kind: v.string(),
		domain: v.string(),
		observation: observationValidator,
		checkedAt: v.number(),
	},
	handler: async (ctx, args) => {
		await upsertPluginRelayIdentity(
			ctx,
			args.kind,
			args.domain,
			args.observation as PluginRelayObservation,
			args.checkedAt
		);
	},
});

/**
 * Persist a call that produced NO verdict.
 *
 * Two different non-answers, and they are not interchangeable: a rejected
 * credential is a terminal `failed` an operator has to fix, while an outage (or a
 * module that threw, or answered in a shape we could not read) leaves the
 * identity untouched and only moves the retry. Neither refreshes `lastCheckedAt`
 * — see `providers/plugin/persistence.ts`.
 */
async function writeCheckFailure(
	ctx: MutationCtx,
	kind: string,
	domain: string,
	isAuthFailure: boolean,
	error: string
): Promise<void> {
	const now = Date.now();
	if (isAuthFailure) {
		await markPluginRelayIdentityFailed(ctx, kind, domain, error, now);
		return;
	}
	await schedulePluginRelayRetry(ctx, kind, domain, now, PLUGIN_UNAVAILABLE_RETRY_MS);
}

/**
 * {@link writeCheckFailure} as its own mutation. Kept for one release, like
 * `recordCheck`. Remove after release 0.6.17.
 */
export const recordCheckFailure = internalMutation({
	args: {
		kind: v.string(),
		domain: v.string(),
		isAuthFailure: v.boolean(),
		error: v.string(),
	},
	handler: async (ctx, args) => {
		await writeCheckFailure(ctx, args.kind, args.domain, args.isAuthFailure, args.error);
	},
});

/**
 * Move the retry for a call the host REFUSED TO MAKE — the plugin's flag is off,
 * its `send:transport` grant was revoked, or a variable its flag requires is
 * unset.
 *
 * WITHOUT THIS THE SWEEP NEVER STOPS. `nextCheckDueAt` is what takes a row out of
 * the due set, so a denial that wrote nothing would leave every row of a disabled
 * plugin permanently due: one scheduled action and one `access_denied` audit row
 * per row per tick, for as long as the operator leaves the plugin off — which is
 * a state they deliberately chose. Every other non-answer on this path already
 * moves the retry and only the retry; this is the one that was missing.
 *
 * IT IS STILL NOT EVIDENCE. It routes to the same write as an outage, so
 * `lastCheckedAt`, the verdicts and the status are untouched and the proof ages
 * out exactly on schedule. A revoked grant must not be able to keep a stale proof
 * alive, and must not be able to condemn a credential nobody rejected. The delay
 * is the slower {@link PLUGIN_DENIED_RETRY_MS} because a denial is a decision
 * rather than an outage.
 *
 * Kept for one release, like `recordCheck`; `commitDeniedCall` makes this write
 * now. Remove after release 0.6.17.
 */
export const deferDeniedCheck = internalMutation({
	args: { kind: v.string(), domain: v.string() },
	handler: async (ctx, args) => {
		await schedulePluginRelayRetry(ctx, args.kind, args.domain, Date.now(), PLUGIN_DENIED_RETRY_MS);
	},
});
