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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { summarizeSeedPlacementWindow } from '../seedPlacement';
import { SEED_PROBE_RETENTION_MS } from '../../schema/seedPlacement';
import type { Id } from '../../_generated/dataModel';
import { modules } from './testModules';

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const ORG = 'org_dispatch_gate';
/** A SECOND tenant, for the cross-org starvation regression. */
const ORG_B = 'org_dispatch_gate_b';

// The clock is pinned for the WHOLE suite: this file is specifically about
// horizons, and a fixture built on the real `Date.now()` while the assertions
// run against `NOW` measures nothing.
// Only `Date` is faked — convex-test drives its own scheduler through real
// timers, and faking those would deadlock the harness rather than pin a clock.
beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
});
afterEach(() => {
	vi.useRealTimers();
});

async function seedAccount(
	t: ReturnType<typeof convexTest>,
	index = 0,
	// 'mail' is an ORDINARY connected account; `null` is a LEGACY row that predates
	// the column. Deliberately not an optional parameter defaulting to 'seed': an
	// explicit `undefined` triggers the default, which is exactly how the
	// page-pressure regression below ended up tagging all 60 of its "ordinary"
	// accounts as seeds and testing nothing.
	purpose: 'seed' | 'mail' | null = 'seed',
	organizationId: string = ORG
): Promise<Id<'externalMailAccounts'>> {
	return t.run(async (ctx) => {
		const address = `owlat.seed.${index}@gmail.example`;
		const mailboxId = await ctx.db.insert('mailboxes', {
			userId: 'user_1',
			organizationId,
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
			organizationId,
			mailboxId,
			...(purpose !== null ? { purpose } : {}),
			...(purpose === 'seed' ? { seedProvider: 'gmail' as const } : {}),
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
	fields: {
		probeId: string;
		sentAt: number;
		dispatchedAt?: number;
		placement?: 'inbox' | 'spam';
		organizationId?: string;
	}
): Promise<Id<'seedPlacementProbes'>> {
	return t.run(async (ctx) =>
		ctx.db.insert('seedPlacementProbes', {
			organizationId: fields.organizationId ?? ORG,
			probeId: fields.probeId,
			accountId,
			provider: 'gmail' as const,
			stream: 'campaign' as const,
			sentAt: fields.sentAt,
			...(fields.dispatchedAt !== undefined ? { dispatchedAt: fields.dispatchedAt } : {}),
			...(fields.placement !== undefined
				? { placement: fields.placement, classifiedAt: fields.sentAt }
				: {}),
			expiresAt: fields.sentAt + SEED_PROBE_RETENTION_MS,
		})
	);
}

/**
 * Drain the CURSORED sweep the way the worker does — page after page until the
 * server says it wrapped around — so a regression that hides work behind a page
 * boundary still fails these assertions.
 */
async function listWork(
	t: ReturnType<typeof convexTest>,
	now: number = NOW
): Promise<Array<{ organizationId: string; probeIds: string[]; expiredProbeIds: string[] }>> {
	const all: Array<{ organizationId: string; probeIds: string[]; expiredProbeIds: string[] }> = [];
	let cursor: string | null = null;
	// Hard bound so a cursor that never advances fails loudly instead of hanging.
	for (let page = 0; page < 50; page += 1) {
		const result: {
			items: Array<{ organizationId: string; probeIds: string[]; expiredProbeIds: string[] }>;
			cursor: string | null;
			isDone: boolean;
		} = await t.query(internal.analytics.seedProbePoller.listSeedProbeWork, { now, cursor });
		all.push(...result.items);
		if (result.isDone) return all;
		cursor = result.cursor;
	}
	throw new Error('seed probe sweep never reported isDone');
}

describe('work selection keys off dispatch, never off enqueue', () => {
	it('offers nothing for a probe that has been queued for hours but never sent', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedAccount(t);
		await probe(t, accountId, { probeId: 'sp_queued00000000000000', sentAt: NOW - 12 * HOUR });

		const work = await listWork(t);
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

		const work = await listWork(t);
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

		const work = await listWork(t);
		expect(work[0]?.probeIds).toEqual(['sp_slowqueue00000000000']);
		expect(work[0]?.expiredProbeIds).toEqual(['sp_reallygone000000000']);
	});

	it('does not go dark behind a page of ordinary external accounts', async () => {
		const t = convexTest(schema, modules);
		// 60 genuinely NON-seed accounts: half tagged 'mail', half legacy rows that
		// predate the column entirely. Either shape must be invisible to the seed
		// sweep no matter how many of them a deployment has.
		for (let i = 0; i < 30; i += 1) await seedAccount(t, i + 100, 'mail');
		for (let i = 0; i < 30; i += 1) await seedAccount(t, i + 200, null);
		const ordinary = await t.run(async (ctx) =>
			(await ctx.db.query('externalMailAccounts').collect()).filter((a) => a.purpose === 'seed')
		);
		expect(ordinary).toHaveLength(0);

		const accountId = await seedAccount(t, 1);
		await probe(t, accountId, {
			probeId: 'sp_findme00000000000000',
			sentAt: NOW - 12 * HOUR,
			dispatchedAt: NOW - HOUR,
		});

		const work = await listWork(t);
		expect(work.map((w) => w.probeIds)).toEqual([['sp_findme00000000000000']]);
	});

	/**
	 * The "goes dark" class, one level down. `by_account_*` pages are bounded, and
	 * a CLASSIFIED probe stays in the ledger for the whole 90-day retention: keyed
	 * on `(accountId, dispatchedAt)` alone the page fills with rows the poller
	 * already answered and every new probe becomes invisible. The index leads with
	 * `placement`, so a classified row leaves the range the moment it is written.
	 */
	it('still offers a fresh probe on an account holding a page of CLASSIFIED ones', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedAccount(t);
		for (let i = 0; i < 60; i += 1) {
			await probe(t, accountId, {
				probeId: `sp_done${String(i).padStart(17, '0')}`,
				sentAt: NOW - 72 * HOUR,
				dispatchedAt: NOW - 71 * HOUR,
				placement: 'inbox',
			});
		}
		await probe(t, accountId, {
			probeId: 'sp_fresh00000000000000',
			sentAt: NOW - 2 * HOUR,
			dispatchedAt: NOW - HOUR,
		});

		const work = await listWork(t);
		expect(work.map((w) => w.probeIds)).toEqual([['sp_fresh00000000000000']]);
	});

	it('reaches every organization rather than starving whoever sorts last', async () => {
		const t = convexTest(schema, modules);
		// More seed accounts than a single page holds, spread across TWO tenants:
		// a bounded top-N with no cursor drains whichever org sorts first and
		// starves the other one permanently, which is the regression this pins —
		// a single-org fixture would only prove the cursor advances.
		const expected = new Map<string, string[]>([
			[ORG, []],
			[ORG_B, []],
		]);
		for (let i = 0; i < 40; i += 1) {
			const organizationId = i % 2 === 0 ? ORG : ORG_B;
			const accountId = await seedAccount(t, i + 500, 'seed', organizationId);
			const probeId = `sp_multi${String(i).padStart(16, '0')}`;
			expected.get(organizationId)?.push(probeId);
			await probe(t, accountId, {
				probeId,
				sentAt: NOW - 12 * HOUR,
				dispatchedAt: NOW - HOUR,
				organizationId,
			});
		}

		const work = await listWork(t);
		// Named claim, asserted: BOTH tenants are represented in the drained work,
		// and every probe of each comes back.
		for (const [organizationId, probeIds] of expected) {
			const seen = work
				.filter((item) => item.organizationId === organizationId)
				.flatMap((item) => item.probeIds)
				.sort();
			expect(seen).toEqual([...probeIds].sort());
		}
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

describe('the classification mutation is the single arbiter', () => {
	it('no-ops on an already-classified probe, so a second replica cannot re-click', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedAccount(t);
		const ref = await probe(t, accountId, {
			probeId: 'sp_raced000000000000000',
			sentAt: NOW - 12 * HOUR,
			dispatchedAt: NOW - HOUR,
		});

		const first = await t.mutation(internal.analytics.seedPlacement.recordSeedProbeClassification, {
			organizationId: ORG,
			probeId: 'sp_raced000000000000000',
			folderName: 'INBOX',
			now: NOW,
			clickRoll: 0,
		});
		expect(first).toMatchObject({ recorded: true, placement: 'inbox' });

		// A second mail-sync replica sweeping the same probe. It must not be told
		// to mark read or CLICK again — a second click is a real request a real
		// provider sees, and no subscriber produces that pattern.
		const second = await t.mutation(
			internal.analytics.seedPlacement.recordSeedProbeClassification,
			{
				organizationId: ORG,
				probeId: 'sp_raced000000000000000',
				folderName: '[Gmail]/Spam',
				now: NOW + 1000,
				clickRoll: 0,
			}
		);
		expect(second).toEqual({ recorded: false, reason: 'already_classified' });

		const row = await t.run(async (ctx) => ctx.db.get(ref));
		expect(row?.placement).toBe('inbox');
		expect(row?.classifiedAt).toBe(NOW);
	});
});

describe('the abandonment sweep writes off what was never sent', () => {
	it('stamps the non-evidence disposition and never a placement', async () => {
		const t = convexTest(schema, modules);
		const accountId = await seedAccount(t);
		const stale = await probe(t, accountId, {
			probeId: 'sp_abandoned0000000000',
			sentAt: NOW - 96 * HOUR,
		});
		const fresh = await probe(t, accountId, {
			probeId: 'sp_stillwaiting0000000',
			sentAt: NOW - HOUR,
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
			sentAt: NOW - 96 * HOUR,
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
			sentAt: NOW - 96 * HOUR,
		});
		await t.mutation(internal.analytics.seedPlacement.abandonUndispatchedSeedProbes, {});

		const summary = await t.run(async (ctx) => summarizeSeedPlacementWindow(ctx.db, ORG, NOW));
		expect(summary.rollups).toEqual([]);
	});
});
