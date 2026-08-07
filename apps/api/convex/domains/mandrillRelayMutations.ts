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
import { mandrillProvider } from './providers/mandrill';
import {
	markMandrillIdentityFailed,
	scheduleMandrillRetry,
	upsertMandrillIdentity,
} from './providers/mandrill/persistence';
import { mandrillIdentityValidator } from './providers/mandrill/validators';
import { pluginSendTransportDomainIdentityFor } from '../plugins/sendTransportDomainIdentityCatalog';

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
 * kind to want a sweep adds its own dispatch line here — the seams plan's P3.2
 * took that invitation up for the bundled plugin tier, whose dispatch arm is
 * asked of the REGISTRY rather than written as a second kind literal, so every
 * plugin transport that contributes a `domainIdentity` is on this sweep the day
 * it composes.
 *
 * The sweep is still spelled here rather than moved to a neutral file. It is one
 * cron entry with one registered name, and moving it would rename a scheduled
 * function for a tidiness that buys nothing; the two dispatch arms below are
 * where a reader looks anyway.
 */
/**
 * Schedule one due row's refresh, and say whether there was one to schedule.
 *
 * A row with no dispatch arm is skipped silently, and that is a real answer
 * rather than a gap: `sendingDomainRelayIdentities` is written by whichever relay
 * kinds a deployment configured, and a row can outlive its plugin (a composition
 * that dropped the package) or predate a kind's sweep.
 */
async function scheduleRefresh(
	ctx: MutationCtx,
	delayMs: number,
	providerKind: string,
	domain: string
): Promise<boolean> {
	if (providerKind === 'mandrill') {
		await ctx.scheduler.runAfter(delayMs, internal.domains.mandrillRelay.refreshIdentity, {
			domain,
		});
		return true;
	}
	// ASKED OF THE REGISTRY, not of a second literal: the bundled plugin tier's
	// kinds are decided by `plugins.config.ts` at composition time, so there is no
	// list here to keep in step with one.
	if (pluginSendTransportDomainIdentityFor(providerKind)) {
		await ctx.scheduler.runAfter(delayMs, internal.domains.pluginRelay.refreshIdentity, {
			kind: providerKind,
			domain,
		});
		return true;
	}
	return false;
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
