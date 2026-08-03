/**
 * THE ONE SEED-PROBE FIXTURE: a connected seed mailbox and the ledger rows the
 * IMAP poller leaves behind it.
 *
 * Two suites on opposite sides of the wiring need identical rows — the ledger's
 * own reduction to per-cell sweeps, and gate 5 end to end through the
 * controller and the screen. Hand-rolling the shape twice is how the two ends
 * of a seam drift apart while both stay green, which is the failure this whole
 * corner of the codebase is being repaired for.
 */

import type { TestConvex } from 'convex-test';
import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import type { SeedPlacement, SeedTransportArm } from '@owlat/shared/seedPlacement';
import type { Id } from '../../_generated/dataModel';
import type schema from '../../schema';
import { SEED_PROBE_RETENTION_MS } from '../../schema/seedPlacement';

export type SeedHarness = TestConvex<typeof schema>;

/** One seed mailbox: the ORDINARY external account the probe ledger points at. */
export async function insertSeedAccount(
	t: SeedHarness,
	args: { readonly organizationId: string; readonly provider: DestinationProviderKey }
): Promise<Id<'externalMailAccounts'>> {
	const now = Date.now();
	return await t.run(async (ctx) => {
		const address = `owlat.seed.${args.provider}.${now}@example.test`;
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user_1',
			organizationId: args.organizationId,
			address,
			domain: 'example.test',
			kind: 'external' as const,
			status: 'active' as const,
			usedBytes: 0,
			uidValidity: now,
			createdAt: now,
			updatedAt: now,
		});
		return await ctx.db.insert('externalMailAccounts', {
			userId: 'user_1',
			organizationId: args.organizationId,
			mailboxId,
			purpose: 'seed' as const,
			...(args.provider === 'other' ? {} : { seedProvider: args.provider }),
			imapHost: 'imap.example.test',
			imapPort: 993,
			isImapSecure: true,
			smtpHost: 'smtp.example.test',
			smtpPort: 587,
			isSmtpSecure: false,
			authMethod: 'password' as const,
			imapUsername: `login-${args.provider}`,
			secretCiphertext: 'ct',
			secretIv: 'iv',
			secretAuthTag: 'tag',
			secretEnvelopeVersion: 1,
			status: 'connected' as const,
			createdAt: now,
			updatedAt: now,
		});
	});
}

export interface SeedProbeOptions {
	readonly organizationId: string;
	readonly count: number;
	readonly placement: SeedPlacement;
	/** Omitted entirely when `unattributed` — the arm the worker never recorded. */
	readonly arm?: SeedTransportArm;
	readonly provider?: DestinationProviderKey;
	/** How long before now the probe was classified. Default: an hour. */
	readonly classifiedAgoMs?: number;
	/** Left unclassified: a probe the poller has not reported on yet. */
	readonly unclassified?: boolean;
	/** Written with NO `transportArm`, the way a pre-attribution row reads. */
	readonly unattributed?: boolean;
}

/**
 * `count` probes, written the way the poller leaves them: dispatched, attributed
 * to an arm, carrying a placement and the instant it was decided.
 */
export async function insertSeedProbes(t: SeedHarness, options: SeedProbeOptions): Promise<void> {
	const provider = options.provider ?? 'gmail';
	const accountId = await insertSeedAccount(t, {
		organizationId: options.organizationId,
		provider,
	});
	const at = Date.now() - (options.classifiedAgoMs ?? 60 * 60 * 1000);
	const arm = options.arm ?? 'own';
	await t.run(async (ctx) => {
		for (let index = 0; index < options.count; index += 1) {
			await ctx.db.insert('seedPlacementProbes', {
				organizationId: options.organizationId,
				probeId: `probe-${provider}-${arm}-${options.placement}-${at}-${index}`,
				accountId,
				provider,
				stream: 'campaign' as const,
				...(options.unattributed === true ? {} : { transportArm: arm }),
				dispatchedAt: at,
				sentAt: at,
				...(options.unclassified === true
					? {}
					: { placement: options.placement, classifiedAt: at }),
				expiresAt: at + SEED_PROBE_RETENTION_MS,
			});
		}
	});
}
