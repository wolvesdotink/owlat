/**
 * (c) A probe that was never MAILED is not a placement verdict.
 *
 * `missing` is gate 5's most alarming reading and the one no other signal
 * surfaces. It must therefore mean "the provider accepted the message and we
 * cannot find it" — never "our own workpool never got round to sending it".
 * The failure mode this suite exists to prevent closes a loop: warming caps and
 * deferrals keep a probe queued, the probe is written `missing`, and the
 * corroborating deferral gate is breached by the SAME root cause, so gate 5
 * reaches `fail` on an artifact of our own queue.
 *
 * Also pins the poller's account selection: it must not go dark behind a
 * bounded page of ordinary external accounts.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { summarizeSeedPlacementWindow } from '../seedPlacement';
import { SEED_PROBE_RETENTION_MS } from '../../schema/seedPlacement';
import type { Id } from '../../_generated/dataModel';

const rootGlob = import.meta.glob('../../**/*.*s');
const analyticsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../analytics/'),
		module,
	])
);
const modules = { ...rootGlob, ...analyticsGlob };

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const ORG = 'org_dispatch_gate';

async function seedAccount(
	t: ReturnType<typeof convexTest>,
	index = 0,
	purpose: 'seed' | undefined = 'seed'
): Promise<Id<'externalMailAccounts'>> {
	return t.run(async (ctx) => {
		const address = `owlat.seed.${index}@gmail.example`;
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user_1',
			organizationId: ORG,
			address,
			domain: 'gmail.example',
			kind: 'external' as const,
			status: 'active' as const,
			usedBytes: 0,
			uidValidity: NOW,
			createdAt: NOW,
			updatedAt: NOW,
		});
		return ctx.db.insert('externalMailAccounts', {
			userId: 'user_1',
			organizationId: ORG,
			mailboxId,
			...(purpose ? { purpose, seedProvider: 'gmail' as const } : {}),
			imapHost: 'imap.gmail.example',
			imapPort: 993,
			isImapSecure: true,
			smtpHost: 'smtp.gmail.example',
			smtpPort: 587,
			isSmtpSecure: false,
			authMethod: 'password' as const,
			imapUsername: `login-${index}`,
			secretCiphertext: 'ct',
			secretIv: 'iv',
			secretAuthTag: 'tag',
			secretEnvelopeVersion: 1,
			status: 'pending' as const,
			createdAt: NOW,
			updatedAt: NOW,
		});
	});
}

async function probe(
	t: ReturnType<typeof convexTest>,
	accountId: Id<'externalMailAccounts'>,
	fields: { probeId: string; sentAt: number; dispatchedAt?: number }
): Promise<Id<'seedPlacementProbes'>> {
	return t.run(async (ctx) =>
		ctx.db.insert('seedPlacementProbes', {
			organizationId: ORG,
			probeId: fields.probeId,
			accountId,
			provider: 'gmail' as const,
			stream: 'campaign' as const,
			sentAt: fields.sentAt,
			...(fields.dispatchedAt !== undefined ? { dispatchedAt: fields.dispatchedAt } : {}),
			expiresAt: fields.sentAt + SEED_PROBE_RETENTION_MS,
		})
	);
}

describe('work selection keys off dispatch, never off enqueue', () => {
	it('offers nothing for a probe that has been queued for hours but never sent', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedAccount(t);
		await probe(t, accountId, { probeId: 'sp_queued00000000000000', sentAt: NOW - 12 * HOUR });

		const work = await t.query(internal.analytics.seedProbePoller.listSeedProbeWork, { now: NOW });
		expect(work).toEqual([]);
	});

	it('offers a probe once it has been dispatched and settled', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedAccount(t);
		await probe(t, accountId, {
			probeId: 'sp_sent0000000000000000',
			sentAt: NOW - 12 * HOUR,
			dispatchedAt: NOW - HOUR,
		});

		const work = await t.query(internal.analytics.seedProbePoller.listSeedProbeWork, { now: NOW });
		expect(work).toHaveLength(1);
		expect(work[0]?.probeIds).toEqual(['sp_sent0000000000000000']);
		expect(work[0]?.expiredProbeIds).toEqual([]);
	});

	it('measures the give-up horizon from dispatch, so a long queue never expires a probe', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedAccount(t);
		// Enqueued three days ago, handed to a transport an hour ago: fresh work.
		await probe(t, accountId, {
			probeId: 'sp_slowqueue00000000000',
			sentAt: NOW - 72 * HOUR,
			dispatchedAt: NOW - HOUR,
		});
		// Dispatched two days ago and still not found: genuinely expired.
		await probe(t, accountId, {
			probeId: 'sp_reallygone000000000',
			sentAt: NOW - 72 * HOUR,
			dispatchedAt: NOW - 48 * HOUR,
		});

		const work = await t.query(internal.analytics.seedProbePoller.listSeedProbeWork, { now: NOW });
		expect(work[0]?.probeIds).toEqual(['sp_slowqueue00000000000']);
		expect(work[0]?.expiredProbeIds).toEqual(['sp_reallygone000000000']);
	});

	it('does not go dark behind a page of ordinary external accounts', async () => {
		const t = convexTest(schema, modules);
		for (let i = 0; i < 60; i += 1) await seedAccount(t, i + 100, undefined);
		const accountId = await seedAccount(t, 1);
		await probe(t, accountId, {
			probeId: 'sp_findme00000000000000',
			sentAt: NOW - 12 * HOUR,
			dispatchedAt: NOW - HOUR,
		});

		const work = await t.query(internal.analytics.seedProbePoller.listSeedProbeWork, { now: NOW });
		expect(work.map((w) => w.probeIds)).toEqual([['sp_findme00000000000000']]);
	});
});

describe('an undispatched probe can never be classified', () => {
	it('is refused with its own non-evidence reason, leaving the ledger untouched', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedAccount(t);
		const ref = await probe(t, accountId, {
			probeId: 'sp_queued00000000000000',
			sentAt: NOW - 12 * HOUR,
		});

		const outcome = await t.mutation(
			internal.analytics.seedPlacement.recordSeedProbeClassification,
			{
				organizationId: ORG,
				probeId: 'sp_queued00000000000000',
				folderName: null,
				now: NOW,
				clickRoll: 0.9,
			}
		);
		expect(outcome).toEqual({ recorded: false, reason: 'never_dispatched' });
		const row = await t.run(async (ctx) => ctx.db.get(ref));
		expect(row?.placement).toBeUndefined();
		expect(row?.classifiedAt).toBeUndefined();
	});
});

describe('the abandonment sweep writes off what was never sent', () => {
	it('stamps the non-evidence disposition and never a placement', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedAccount(t);
		const stale = await probe(t, accountId, {
			probeId: 'sp_abandoned0000000000',
			sentAt: Date.now() - 96 * HOUR,
		});
		const fresh = await probe(t, accountId, {
			probeId: 'sp_stillwaiting0000000',
			sentAt: Date.now() - HOUR,
		});

		const result = await t.mutation(
			internal.analytics.seedPlacement.abandonUndispatchedSeedProbes,
			{}
		);
		expect(result.abandoned).toBe(1);
		expect(result.hasMore).toBe(false);

		const rows = await t.run(async (ctx) => ({
			stale: await ctx.db.get(stale),
			fresh: await ctx.db.get(fresh),
		}));
		expect(rows.stale?.notDispatchedAt).toBeDefined();
		expect(rows.stale?.placement).toBeUndefined();
		expect(rows.fresh?.notDispatchedAt).toBeUndefined();
	});

	it('is idempotent — a second pass finds nothing left to write off', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedAccount(t);
		await probe(t, accountId, {
			probeId: 'sp_abandoned0000000000',
			sentAt: Date.now() - 96 * HOUR,
		});
		await t.mutation(internal.analytics.seedPlacement.abandonUndispatchedSeedProbes, {});
		const second = await t.mutation(
			internal.analytics.seedPlacement.abandonUndispatchedSeedProbes,
			{}
		);
		expect(second.abandoned).toBe(0);
	});

	it('contributes nothing to the roll-up, in either direction', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedAccount(t);
		await probe(t, accountId, {
			probeId: 'sp_abandoned0000000000',
			sentAt: Date.now() - 96 * HOUR,
		});
		await t.mutation(internal.analytics.seedPlacement.abandonUndispatchedSeedProbes, {});

		const summary = await t.run(async (ctx) =>
			summarizeSeedPlacementWindow(ctx.db, ORG, Date.now())
		);
		expect(summary.rollups).toEqual([]);
	});
});
