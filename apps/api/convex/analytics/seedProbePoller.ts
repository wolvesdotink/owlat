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
 * D2: with no seed mailboxes connected this returns an empty list forever and
 * the worker's sweep is a no-op. Absence is a supported configuration.
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { shouldRemindSeedRotation, type SeedProbeWorkItem } from '@owlat/shared/seedPlacement';

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

/** Bound on accounts walked in one sweep — a deployment has a handful of seeds. */
const SEED_ACCOUNT_SCAN_LIMIT = 50;

/** Bound on probe ids handed to the worker per account per sweep. */
const SEED_PROBE_WORK_LIMIT = 50;

/**
 * Every seed mailbox with outstanding probe work.
 *
 * Selects on exactly (purpose, status): the same three connectable statuses
 * `listConnectableAccounts` uses — so a seed the operator has not fixed
 * credentials for is skipped rather than erroring — but through an index keyed
 * on `purpose`, so a deployment with many ordinary external accounts cannot
 * push every seed off the end of a bounded page and take gate 5 dark.
 */
export const listSeedProbeWork = internalQuery({
	args: { now: v.number() },
	handler: async (ctx, args): Promise<SeedProbeWorkItem[]> => {
		const groups = await Promise.all(
			(['pending', 'connected', 'error'] as const).map((status) =>
				ctx.db
					.query('externalMailAccounts')
					.withIndex('by_purpose_and_status', (q) => q.eq('purpose', 'seed').eq('status', status))
					.take(SEED_ACCOUNT_SCAN_LIMIT)
			)
		);
		const accounts: Doc<'externalMailAccounts'>[] = groups.flat();

		const work: SeedProbeWorkItem[] = [];
		for (const account of accounts) {
			const mailbox = await ctx.db.get(account.mailboxId);
			if (!mailbox) continue;
			// DISPATCHED probes only, oldest handoff first. `gte(0)` is what excludes
			// the never-dispatched rows: `undefined` sorts below every number in a
			// Convex index, so an undispatched probe is not merely filtered out
			// afterwards — it is outside the range entirely and can never be
			// classified.
			const probes = await ctx.db
				.query('seedPlacementProbes')
				.withIndex('by_account_and_dispatched_at', (q) =>
					q
						.eq('accountId', account._id)
						.gte('dispatchedAt', 0)
						.lte('dispatchedAt', args.now - SEED_PROBE_SETTLE_MS)
				)
				.take(SEED_PROBE_WORK_LIMIT);

			const probeIds: string[] = [];
			const expiredProbeIds: string[] = [];
			for (const probe of probes) {
				if (probe.placement !== undefined) continue;
				const dispatchedAt = probe.dispatchedAt;
				if (dispatchedAt === undefined) continue;
				if (args.now - dispatchedAt >= SEED_PROBE_GIVE_UP_MS) expiredProbeIds.push(probe.probeId);
				else probeIds.push(probe.probeId);
			}
			if (probeIds.length === 0 && expiredProbeIds.length === 0) continue;

			work.push({
				organizationId: account.organizationId,
				accountId: account._id,
				address: mailbox.address,
				provider: account.seedProvider ?? 'other',
				probeIds,
				expiredProbeIds,
				rotationReminderDue: shouldRemindSeedRotation({
					connectedAt: account.createdAt,
					lastRemindedAt: account.seedRotationRemindedAt,
					now: args.now,
				}),
			});
		}
		return work;
	},
});
