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
import { shouldRemindSeedRotation } from '@owlat/shared/seedPlacement';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';

/**
 * How long after dispatch a probe becomes worth looking for. Filters run on
 * delivery, and a mailbox walked one second after the send would report
 * `missing` for mail that simply has not arrived.
 */
const SEED_PROBE_SETTLE_MS = 15 * 60 * 1000;

/** Give up on a probe that never showed up; it is reported MISSING once. */
const SEED_PROBE_GIVE_UP_MS = 24 * 60 * 60 * 1000;

/** Bound on accounts walked in one sweep — a deployment has a handful of seeds. */
const SEED_ACCOUNT_SCAN_LIMIT = 50;

/** Bound on probe ids handed to the worker per account per sweep. */
const SEED_PROBE_WORK_LIMIT = 50;

export interface SeedProbeWorkItem {
	organizationId: string;
	accountId: string;
	address: string;
	provider: DestinationProviderKey;
	/** Probes still unclassified and old enough to look for. */
	probeIds: string[];
	/** Probes past the give-up horizon — report MISSING without searching further. */
	expiredProbeIds: string[];
	/** Advisory nudge; never a blocking warning (D2). */
	rotationReminderDue: boolean;
}

function isSeedAccount(account: Doc<'externalMailAccounts'>): boolean {
	return account.purpose === 'seed' && account.status !== 'disconnected';
}

/**
 * Every seed mailbox with outstanding probe work.
 *
 * Scans the same three connectable statuses `listConnectableAccounts` does, so
 * a seed the operator has not fixed credentials for is simply skipped rather
 * than erroring.
 */
export const listSeedProbeWork = internalQuery({
	args: { now: v.number() },
	handler: async (ctx, args): Promise<SeedProbeWorkItem[]> => {
		const groups = await Promise.all(
			(['pending', 'connected', 'error'] as const).map((status) =>
				ctx.db
					.query('externalMailAccounts')
					.withIndex('by_status', (q) => q.eq('status', status))
					.take(SEED_ACCOUNT_SCAN_LIMIT)
			)
		);
		const accounts = groups.flat().filter(isSeedAccount);

		const work: SeedProbeWorkItem[] = [];
		for (const account of accounts) {
			const mailbox = await ctx.db.get(account.mailboxId);
			if (!mailbox) continue;
			const probes = await ctx.db
				.query('seedPlacementProbes')
				.withIndex('by_account_and_sent_at', (q) =>
					q.eq('accountId', account._id).lte('sentAt', args.now - SEED_PROBE_SETTLE_MS)
				)
				.order('desc')
				.take(SEED_PROBE_WORK_LIMIT);

			const probeIds: string[] = [];
			const expiredProbeIds: string[] = [];
			for (const probe of probes) {
				if (probe.placement !== undefined) continue;
				if (args.now - probe.sentAt >= SEED_PROBE_GIVE_UP_MS) expiredProbeIds.push(probe.probeId);
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
