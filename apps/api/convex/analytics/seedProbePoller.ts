/**
 * Seed-probe poller surface — the Convex half of step 3 (classify).
 *
 * The mail-sync worker already owns the shipped IMAP client and the sealed
 * credential path; this module tells it WHICH seed mailboxes to walk and WHICH
 * probe ids to look for, and takes the answer back through
 * `analytics/seedPlacement.recordSeedProbeClassification`.
 *
 * Nothing here reads or returns a credential, and nothing here reads mailbox
 * CONTENTS — a probe id and a folder NAME are the entire vocabulary.
 *
 * D2: with no seed mailboxes connected this returns an empty page forever and
 * the worker's sweep is a no-op. Absence is a supported configuration.
 */

import { v } from 'convex/values';
import { internalQuery, type DatabaseReader } from '../_generated/server';
import { CONNECTABLE_ACCOUNT_STATUSES, seedProviderOf } from '../mail/externalAccountShared';
import { getOptional } from '../lib/env';
import {
	shouldRemindSeedRotation,
	type SeedProbeWorkItem,
	type SeedProbeWorkPage,
} from '@owlat/shared/seedPlacement';

/**
 * How long after DISPATCH a probe becomes worth looking for. Filters run on
 * delivery, and a mailbox walked one second after the handoff would report
 * `missing` for mail that simply has not arrived.
 *
 * Every horizon in this module keys off `dispatchedAt`, never off `sentAt`.
 * `sentAt` is the ENQUEUE timestamp, and a probe can legitimately sit in the
 * rate-limited campaign workpool for hours behind a warming cap — which is the
 * common case for exactly the deployments this feature exists for. Searching on
 * enqueue time would find nothing and write `missing`, manufacturing gate 5's
 * most alarming outcome out of our own queue depth.
 */
const SEED_PROBE_SETTLE_MS = 15 * 60 * 1000;

/**
 * Give up on a DISPATCHED probe that never showed up; it is reported MISSING
 * once. A probe that was never dispatched never reaches this horizon — it is
 * abandoned as non-evidence instead (`abandonUndispatchedSeedProbes`).
 */
const SEED_PROBE_GIVE_UP_MS = 24 * 60 * 60 * 1000;

/**
 * Seed accounts examined per tick. NOT a cap on the seed set: the sweep is
 * PAGINATED and the worker carries the cursor across ticks, so every seed in
 * every org is reached in bounded time. A bare bounded page with no cursor
 * starves whichever orgs sort last, permanently and silently.
 */
const SEED_ACCOUNT_PAGE_SIZE = 25;

/** Bound on probe ids handed to the worker per account per sweep. */
const SEED_PROBE_WORK_LIMIT = 50;

const connectableStatuses = new Set<string>(CONNECTABLE_ACCOUNT_STATUSES);

/**
 * The hosts the worker's hygiene click may be issued against.
 *
 * The click target is picked out of links found INSIDE a message sitting on a
 * mail server we do not run, so the permitted set is supplied by the backend
 * rather than inferred from the content: this deployment's own tracking domain
 * and its own site/Convex origins, and nothing else. Anything not on the list
 * is simply not clicked — a skipped click is a missing data point, which is a
 * far cheaper outcome than an outbound request the worker was talked into.
 */
async function resolveClickHosts(db: DatabaseReader): Promise<string[]> {
	const hosts = new Set<string>();
	const add = (value: string | undefined): void => {
		if (!value) return;
		try {
			hosts.add(new URL(value.includes('://') ? value : `https://${value}`).host.toLowerCase());
		} catch {
			// A malformed configured URL contributes nothing; it is never a failure.
		}
	};
	add(getOptional('CONVEX_SITE_URL'));
	add(getOptional('SITE_URL'));
	// Tracking domains are few per deployment and the shipped resolver collects
	// them the same way (`domains/trackingDomains.getActiveTrackingDomain`).
	const trackingDomains = await db.query('trackingDomains').collect(); // bounded: tracking domains (a handful per deployment), same read as domains/trackingDomains.ts
	for (const domain of trackingDomains) {
		if (domain.isVerified) add(domain.domain);
	}
	return [...hosts];
}

/**
 * One page of the seed mailboxes with outstanding probe work.
 *
 * Selects on `purpose` through its own index — a deployment with many ordinary
 * external accounts cannot push every seed off the end of a page and take gate
 * 5 dark — and pages with a CURSOR so a multi-org deployment cannot starve the
 * orgs that sort last. Statuses outside `CONNECTABLE_ACCOUNT_STATUSES` are
 * skipped (a seed whose credentials the operator has not fixed is skipped, not
 * an error), which is a per-row filter rather than an index selection precisely
 * because the cursor, not the page, is what guarantees progress.
 */
export const listSeedProbeWork = internalQuery({
	args: { now: v.number(), cursor: v.optional(v.union(v.string(), v.null())) },
	handler: async (ctx, args): Promise<SeedProbeWorkPage> => {
		const page = await ctx.db
			.query('externalMailAccounts')
			.withIndex('by_purpose', (q) => q.eq('purpose', 'seed'))
			.paginate({ numItems: SEED_ACCOUNT_PAGE_SIZE, cursor: args.cursor ?? null });

		const items: SeedProbeWorkItem[] = [];
		const clickHosts = await resolveClickHosts(ctx.db);
		for (const account of page.page) {
			if (!connectableStatuses.has(account.status)) continue;
			const mailbox = await ctx.db.get(account.mailboxId);
			if (!mailbox) continue;
			// UNCLASSIFIED, DISPATCHED probes only, oldest handoff first.
			//
			// `eq('placement', undefined)` is load-bearing twice over. It retires a
			// row from the range the moment the poller classifies it — without it the
			// page fills with already-classified probes (they stay in range for the
			// whole 90-day retention) and the account goes permanently dark after
			// roughly one page. And `gte(0)` excludes the never-dispatched rows:
			// `undefined` sorts below every number in a Convex index, so an
			// undispatched probe is outside the range entirely and can never be
			// classified.
			const probes = await ctx.db
				.query('seedPlacementProbes')
				.withIndex('by_account_placement_and_dispatched_at', (q) =>
					q
						.eq('accountId', account._id)
						.eq('placement', undefined)
						.gte('dispatchedAt', 0)
						.lte('dispatchedAt', args.now - SEED_PROBE_SETTLE_MS)
				)
				.take(SEED_PROBE_WORK_LIMIT);

			const probeIds: string[] = [];
			const expiredProbeIds: string[] = [];
			for (const probe of probes) {
				const dispatchedAt = probe.dispatchedAt;
				if (dispatchedAt === undefined) continue;
				if (args.now - dispatchedAt >= SEED_PROBE_GIVE_UP_MS) expiredProbeIds.push(probe.probeId);
				else probeIds.push(probe.probeId);
			}
			if (probeIds.length === 0 && expiredProbeIds.length === 0) continue;

			items.push({
				organizationId: account.organizationId,
				accountId: account._id,
				address: mailbox.address,
				provider: seedProviderOf(account),
				probeIds,
				expiredProbeIds,
				rotationReminderDue: shouldRemindSeedRotation({
					connectedAt: account.createdAt,
					lastRemindedAt: account.seedRotationRemindedAt,
					now: args.now,
				}),
				clickHosts,
			});
		}
		return {
			items,
			cursor: page.isDone ? null : page.continueCursor,
			isDone: page.isDone,
		};
	},
});
