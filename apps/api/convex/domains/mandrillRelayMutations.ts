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
 * Rows of another provider kind are skipped rather than filtered in the index:
 * the due index is deliberately kind-agnostic (it is a deployment-wide work
 * queue), and Mandrill is simply the first kind to use this table. The next
 * kind to want a sweep adds its own dispatch line here.
 */
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
			if (identity.providerKind !== 'mandrill') continue;
			await ctx.scheduler.runAfter(
				scheduled * MANDRILL_SWEEP_STAGGER_MS,
				internal.domains.mandrillRelay.refreshIdentity,
				{ domain: identity.domain }
			);
			scheduled += 1;
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
