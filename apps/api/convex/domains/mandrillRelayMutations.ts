/**
 * The transactional half of the Mandrill sending-domain identity: persist what
 * a provider call found, and schedule the calls that are due.
 *
 * Split from `mandrillRelay.ts` for the runtime reason every `*Mutations.ts`
 * sibling here is (`sesRelayMutations.ts` is the same pair): that file is
 * `'use node'` and talks to Mandrill, this one runs in the V8 transaction and
 * touches the database. The WRITE RULES themselves live one level down, in
 * `providers/mandrill/persistence.ts`, so the lifecycle's `writeIdentity` and
 * these mutations cannot write the same row two different ways.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalMutation } from '../_generated/server';
import type { MutationCtx } from '../_generated/server';
import { relayIdentityProviderFor } from './providers';
import { mandrillProvider } from './providers/mandrill';
import {
	markMandrillIdentityFailed,
	scheduleMandrillRetry,
	upsertMandrillIdentity,
} from './providers/mandrill/persistence';
import { mandrillIdentityValidator } from './providers/mandrill/validators';

/** How many identities one sweep tick reads. */
const MANDRILL_SWEEP_PAGE_SIZE = 100;

/** Stagger between the per-domain refresh calls one tick schedules. */
const MANDRILL_SWEEP_STAGGER_MS = 1_000;

/**
 * Persist a freshly provisioned identity for a domain we hold the id of (the
 * relay path). Delegates to the adapter's own `writeIdentity` rather than
 * reaching into the table, so a future change to how this kind stores identities
 * lands in one place.
 */
export const storeIdentity = internalMutation({
	args: { domainId: v.id('domains'), identity: mandrillIdentityValidator },
	handler: async (ctx, args) => {
		await mandrillProvider.writeIdentity(ctx, args.domainId, args.identity);
	},
});

/** Persist a check that produced a verdict. */
export const recordCheck = internalMutation({
	args: { domain: v.string(), identity: mandrillIdentityValidator },
	handler: async (ctx, args) => {
		await upsertMandrillIdentity(ctx, args.domain, args.identity);
	},
});

/**
 * Persist a check that produced NO verdict.
 *
 * Two different non-answers, and they are not interchangeable: a rejected
 * credential is a terminal `failed` an operator has to fix, while an outage
 * leaves the identity untouched and only moves the retry. Neither refreshes
 * `lastCheckedAt` — see `providers/mandrill/persistence.ts`.
 */
export const recordCheckFailure = internalMutation({
	args: { domain: v.string(), isAuthFailure: v.boolean(), error: v.string() },
	handler: async (ctx, args) => {
		const now = Date.now();
		if (args.isAuthFailure) {
			await markMandrillIdentityFailed(ctx, args.domain, args.error, now);
			return;
		}
		await scheduleMandrillRetry(ctx, args.domain, now);
	},
});

/**
 * Schedule a bounded batch of the re-checks that are due, then continue from a
 * cursor while pages keep coming back full.
 *
 * The cadence itself lives on the ROW (`nextCheckDueAt`, written from the status
 * the last check produced — 24h verified, 1h pending, 6h on a bad credential),
 * so the cron only has to run often enough to honour the shortest one. Reading
 * the due set through `by_next_check_due` means a deployment whose identities
 * are all fresh pays one index range read per tick and schedules nothing.
 *
 * THE DISPATCH IS THE TABLE'S OWN, not a chain of kind literals (the seams
 * plan's P3.2). The due index is deliberately kind-agnostic — it is a
 * deployment-wide work queue — and Mandrill was simply the first kind to use it.
 * When the second kind wanted the same sweep, the question "whose row is this?"
 * became a registry lookup: every kind that keeps rows here registers the arm
 * that re-asks its provider (`scheduleRelayIdentityRefresh`), so a bundled plugin
 * transport is on this sweep the day it composes and a third kind adds no line
 * here at all.
 *
 * The sweep is still spelled in this Mandrill-named file rather than moved to a
 * neutral one, and that is now only a NAME: nothing below knows a provider. It
 * stays because the module path IS the Convex function path — moving it renames
 * a cron'd scheduled function and strands the paginating continuation any
 * in-flight sweep is holding, which is a real (if small) operational cost for a
 * rename. A later piece that touches the cron registration anyway is the cheap
 * moment for it.
 */
/**
 * Schedule one due row's refresh, and say whether there was one to schedule.
 *
 * A row with no dispatch arm is skipped silently, and that is a real answer
 * rather than a gap: `sendingDomainRelayIdentities` is written by whichever relay
 * kinds a deployment configured, and a row can outlive its plugin (a composition
 * that dropped the package), name a kind a later composition removed, or belong
 * to a kind that proves domains without keeping its rows in this table.
 */
async function scheduleRefresh(
	ctx: MutationCtx,
	delayMs: number,
	providerKind: string,
	domain: string
): Promise<boolean> {
	const provider = relayIdentityProviderFor(providerKind);
	if (!provider?.scheduleRelayIdentityRefresh) return false;
	await provider.scheduleRelayIdentityRefresh(ctx, delayMs, domain);
	return true;
}

export const scheduleDueChecks = internalMutation({
	args: { cursor: v.optional(v.string()) },
	handler: async (ctx, args): Promise<number> => {
		const now = Date.now();
		const page = await ctx.db
			.query('sendingDomainRelayIdentities')
			.withIndex('by_next_check_due', (q) => q.lte('nextCheckDueAt', now))
			.paginate({ cursor: args.cursor ?? null, numItems: MANDRILL_SWEEP_PAGE_SIZE });

		let scheduled = 0;
		for (const identity of page.page) {
			const isScheduled = await scheduleRefresh(
				ctx,
				scheduled * MANDRILL_SWEEP_STAGGER_MS,
				identity.providerKind,
				identity.domain
			);
			if (isScheduled) scheduled += 1;
		}

		if (!page.isDone) {
			// The scheduled-function argument is the durable continuation: each tick
			// reads at most one page, so a large installation progresses without a
			// collect, a timeout, or starving everything after page one.
			await ctx.scheduler.runAfter(
				Math.max(scheduled * MANDRILL_SWEEP_STAGGER_MS, MANDRILL_SWEEP_STAGGER_MS),
				internal.domains.mandrillRelayMutations.scheduleDueChecks,
				{ cursor: page.continueCursor }
			);
		}
		return scheduled;
	},
});
