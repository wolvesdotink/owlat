import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { summarizeSeedPlacementWindow, SEED_PLACEMENT_WINDOW_MS } from '../seedPlacement';
import { loadSeedAccounts } from '../seedAccounts';
import { enqueueSeedShadowCopies } from '../../delivery/seedShadowCopy';
import { SEED_GATE_CONFIDENCE } from '@owlat/shared/seedPlacement';
import { SEED_PROBE_RETENTION_MS } from '../../schema/seedPlacement';
import type { Id } from '../../_generated/dataModel';
import { modules } from '../../__tests__/testModules';

const NOW = 1_800_000_000_000;
const ORG = 'org_standalone';

/**
 * (f) THE D2 PROOF — a fresh install with zero seed mailboxes.
 *
 * Absence of a seed mailbox lowers measurement confidence and slows the ramp.
 * It does NOTHING else: no throw, no error state, no warning, no
 * "setup incomplete" nag, and no effect on any send.
 */
describe('zero seed mailboxes is a supported configuration', () => {
	it('summarizes an empty deployment without throwing', async () => {
		const t = convexTest(schema, modules);
		const summary = await t.run(async (ctx) => summarizeSeedPlacementWindow(ctx.db, ORG, NOW));
		expect(summary.rollups).toEqual([]);
		expect(summary.seedAccountCount).toBe(0);
		expect(summary.rotationRemindersDue).toBe(0);
		expect(summary.windowStart).toBe(NOW - SEED_PLACEMENT_WINDOW_MS);
		// D14 — the reading carries how much it is WORTH, and the one hint that
		// would improve it. A hint, never an error and never a nag: nothing here
		// is an unresolved task and nothing gates a send on it.
		expect(summary.placementSource).toBe('self_hosted_seeds');
		expect(summary.placementConfidence).toBe('none');
		expect(summary.placementImprovement).toBe('add_seed_mailboxes');
	});

	it('finds no seed accounts and reports no reminder', async () => {
		const t = convexTest(schema, modules);
		const accounts = await t.run(async (ctx) => loadSeedAccounts(ctx.db, ORG, NOW));
		expect(accounts).toEqual([]);
	});

	it('answers an empty summary through the shared window reader', async () => {
		const t = convexTest(schema, modules);
		const summary = await t.run(async (ctx) => summarizeSeedPlacementWindow(ctx.db, ORG, NOW));
		expect(summary.rollups).toEqual([]);
		expect(summary.seedAccountCount).toBe(0);
		expect(summary.rotationRemindersDue).toBe(0);
	});

	it('ignores an ordinary (non-seed) external mailbox entirely', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const mailboxId = await ctx.db.insert('mailboxes', {
				userId: 'user_1',
				organizationId: ORG,
				kind: 'external',
				address: 'jane@org.example',
				domain: 'org.example',
				status: 'active',
				usedBytes: 0,
				uidValidity: NOW,
				createdAt: NOW,
				updatedAt: NOW,
			});
			await ctx.db.insert('externalMailAccounts', {
				userId: 'user_1',
				organizationId: ORG,
				mailboxId,
				imapHost: 'imap.example',
				imapPort: 993,
				isImapSecure: true,
				smtpHost: 'smtp.example',
				smtpPort: 465,
				isSmtpSecure: true,
				authMethod: 'password',
				imapUsername: 'jane@org.example',
				secretCiphertext: 'ct',
				secretIv: 'iv',
				secretAuthTag: 'tag',
				secretEnvelopeVersion: 1,
				status: 'connected',
				createdAt: NOW,
				updatedAt: NOW,
			});
		});
		const accounts = await t.run(async (ctx) => loadSeedAccounts(ctx.db, ORG, NOW));
		expect(accounts).toEqual([]);
	});
});

/**
 * (f) Absence must be structurally incapable of blocking anything — asserted
 * as BEHAVIOUR through the real enqueue path, not by grepping module source
 * (a source grep is blind to a throw that lives one module over).
 */
describe('absence is never load-bearing', () => {
	const base = {
		kind: 'campaign' as const,
		deliveryDomain: 'production' as const,
		to: 'jane@example.com',
		from: 'news@org.example',
		template: { subject: 'Hi', htmlContent: '<p>Hi</p>' },
		contactInfo: { email: 'jane@example.com', contactId: 'c1' as Id<'contacts'> },
		emailSendId: 's1' as Id<'emailSends'>,
		organizationId: ORG,
	};

	it('enqueues nothing, schedules nothing and writes nothing with zero seeds', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await t.run(async (ctx) =>
			ctx.db.insert('campaigns', {
				name: 'March',
				subject: 'Hi',
				status: 'sending' as const,
				createdAt: NOW,
				updatedAt: NOW,
			})
		);
		const outcome = await t.run(async (ctx) =>
			enqueueSeedShadowCopies(ctx, {
				organizationId: ORG,
				campaignId,
				base: { ...base, campaignId },
				now: NOW,
			})
		);
		expect(outcome).toEqual({ enqueued: 0 });

		const probes = await t.run(async (ctx) => ctx.db.query('seedPlacementProbes').collect());
		expect(probes).toEqual([]);

		// "Schedules nothing" is asserted, not merely claimed: absence must not
		// leave a scheduled follow-up behind either.
		const scheduled = await t.run(async (ctx) =>
			ctx.db.system.query('_scheduled_functions').collect()
		);
		expect(scheduled).toEqual([]);
	});

	it('is idempotent and still silent when called again', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await t.run(async (ctx) =>
			ctx.db.insert('campaigns', {
				name: 'March',
				subject: 'Hi',
				status: 'sending' as const,
				createdAt: NOW,
				updatedAt: NOW,
			})
		);
		for (let i = 0; i < 3; i += 1) {
			const outcome = await t.run(async (ctx) =>
				enqueueSeedShadowCopies(ctx, {
					organizationId: ORG,
					campaignId,
					base: { ...base, campaignId },
					now: NOW + i,
				})
			);
			expect(outcome).toEqual({ enqueued: 0 });
		}
	});
});

/**
 * The other end of the same query: with seeds connected and every probe in the
 * spam folder, the shipped summary must REPORT the provider-wide collapse as a
 * status — so the ledger→roll-up wiring is proven end to end.
 *
 * It stops there, deliberately. What the controller may DO about a collapse is
 * the ramp's (`delivery/ramp/seedGate.ts` plus `CORROBORATION_REQUIRED_RAMP_GATES`,
 * covered by the ramp gate suites); this module reports and does not decide, and
 * the query that decided here was #504's parallel route.
 */
describe('the shipped summary reports a provider-wide collapse', () => {
	const SEEDS = 4;

	async function connectSeedsWithSpamProbes(t: TestConvex<typeof schema>): Promise<void> {
		await t.run(async (ctx) => {
			for (let i = 0; i < SEEDS; i += 1) {
				const address = `owlat.seed.${i}@gmail.example`;
				const mailboxId = await ctx.db.insert('mailboxes', {
					userId: 'user_1',
					organizationId: ORG,
					kind: 'external' as const,
					scope: 'seed' as const,
					address,
					domain: 'gmail.example',
					status: 'active' as const,
					usedBytes: 0,
					uidValidity: NOW,
					createdAt: NOW,
					updatedAt: NOW,
				});
				const accountId = await ctx.db.insert('externalMailAccounts', {
					userId: 'user_1',
					organizationId: ORG,
					mailboxId,
					purpose: 'seed' as const,
					seedProvider: 'gmail' as const,
					imapHost: 'imap.gmail.example',
					imapPort: 993,
					isImapSecure: true,
					smtpHost: 'smtp.gmail.example',
					smtpPort: 465,
					isSmtpSecure: true,
					authMethod: 'password' as const,
					imapUsername: `login-${i}`,
					secretCiphertext: 'ct',
					secretIv: 'iv',
					secretAuthTag: 'tag',
					secretEnvelopeVersion: 1,
					status: 'connected' as const,
					createdAt: NOW,
					updatedAt: NOW,
				});
				const sentAt = NOW - 3 * 60 * 60 * 1000;
				await ctx.db.insert('seedPlacementProbes', {
					organizationId: ORG,
					probeId: `sp_collapse${String(i).padStart(12, '0')}`,
					accountId,
					provider: 'gmail' as const,
					stream: 'campaign' as const,
					sentAt,
					dispatchedAt: sentAt + 1_000,
					placement: 'spam' as const,
					classifiedAt: sentAt + 60_000,
					expiresAt: sentAt + SEED_PROBE_RETENTION_MS,
				});
			}
		});
	}

	it('names the provider and grades the reading', async () => {
		const t = convexTest(schema, modules);
		await connectSeedsWithSpamProbes(t);
		const summary = await t.run(async (ctx) => summarizeSeedPlacementWindow(ctx.db, ORG, NOW));
		expect(summary.rollups).toHaveLength(1);
		expect(summary.rollups[0]).toMatchObject({
			provider: 'gmail',
			status: 'collapse_suspected',
			sampleSize: SEEDS,
			confidence: SEED_GATE_CONFIDENCE,
		});
		expect(summary.seedAccountCount).toBe(SEEDS);
		// D14 — connected seeds are the reading's own grade, and there is nothing
		// left to advise: the hint is the ABSENCE of seeds, not a bad result.
		expect(summary.placementConfidence).toBe(SEED_GATE_CONFIDENCE);
		expect(summary.placementImprovement).toBe('none');
	});

	it('reports a STATUS and never a placement number (D17)', async () => {
		const t = convexTest(schema, modules);
		await connectSeedsWithSpamProbes(t);
		const summary = await t.run(async (ctx) => summarizeSeedPlacementWindow(ctx.db, ORG, NOW));
		for (const rollup of summary.rollups) {
			expect(rollup).not.toHaveProperty('placementRate');
			expect(rollup).not.toHaveProperty('reachedShare');
		}
	});
});
