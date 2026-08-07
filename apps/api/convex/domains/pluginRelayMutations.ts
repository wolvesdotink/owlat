/**
 * The transactional half of a bundled plugin's sending-domain identity (the
 * seams plan's P3.2): persist what a provider call found.
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
import { internalMutation } from '../_generated/server';
import type { PluginRelayObservation } from './providers/plugin/state';

const recordVerdictValidator = v.object({
	isValid: v.boolean(),
	error: v.optional(v.string()),
});

/** The host's reading of one provider observation, on its way to the row. */
const observationValidator = v.object({
	status: v.union(
		v.literal('unverified'),
		v.literal('pending_dns'),
		v.literal('verified'),
		v.literal('failed')
	),
	spf: recordVerdictValidator,
	dkim: recordVerdictValidator,
	dkimSelectors: v.array(v.string()),
	spfMechanisms: v.array(v.string()),
});

/**
 * Persist a call that produced a verdict.
 *
 * `checkedAt` is the caller's, not `Date.now()`: it dates the EVIDENCE, and the
 * relay proof's freshness bound reads it. Stamping the write time would let a row
 * written long after the call it describes look fresher than the fact it holds.
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
export const recordCheckFailure = internalMutation({
	args: {
		kind: v.string(),
		domain: v.string(),
		isAuthFailure: v.boolean(),
		error: v.string(),
	},
	handler: async (ctx, args) => {
		const now = Date.now();
		if (args.isAuthFailure) {
			await markPluginRelayIdentityFailed(ctx, args.kind, args.domain, args.error, now);
			return;
		}
		await schedulePluginRelayRetry(ctx, args.kind, args.domain, now);
	},
});
