/**
 * transportOutcomes — the write path (plan D5, ADR-0042 shape).
 *
 * Coverage here:
 *   - one SHIPPED lifecycle transition bumps exactly ONE shard of exactly ONE
 *     bucket, for every event type the lifecycle can produce — including the
 *     queued→terminal MTA path, the only one that emits two outcome effects;
 *   - engagement rides the shipped UNIQUE open/click gate, so an outcome
 *     counter can never disagree with the dashboard counter beside it;
 *   - the exclusions: `failed` is not a transport outcome, a duplicate
 *     transition records nothing twice, a test preview records nothing, and a
 *     send with NO assignment row (a seed shadow copy, plan D18) never enters a
 *     denominator.
 *
 * The pure event→counter map is `transportOutcomesEvents.test.ts`; the aging
 * sweep is `transportOutcomesRetention.test.ts`.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import {
	reduceClicked,
	reduceOpened,
	type EmailSendDoc,
	type SendRef,
} from '../../delivery/sendLifecycle/reducers';
import type { Effect } from '../../delivery/sendLifecycle/effects';
import { recordTransportOutcomeForCell, recordTransportOutcomeForSend } from '../transportOutcomes';
import { modules } from './testModules';
import {
	GMAIL_CAMPAIGN_CELL,
	OUTCOME_ORG,
	readBuckets,
	seedAssignedSend,
	seedAssignedTestPreview,
	sumCounter,
} from './transportOutcomesFixtures';

// The singleton-org lookup goes through the BetterAuth component, which is not
// registered in the convex-test harness. Same override the shipped routing and
// assignment tests use, so the recorder's org resolution is deterministic.
vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	// The literal, not the `OUTCOME_ORG` import: `vi.mock` factories are hoisted
	// above the imports, so referencing one here is a TDZ error at load time.
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org_outcomes') };
});

// The lifecycle schedules webhook fanout and reputation updates via
// `runAfter(0, …)`; let them drain before convex-test's global state is
// replaced, or they surface as "Write outside of transaction" rejections.
afterEach(async () => {
	await new Promise((resolve) => setTimeout(resolve, 25));
});

describe('engagement outcomes ride the shipped unique gate (pure reducers)', () => {
	const SEND_ID = 'send_engagement' as Id<'emailSends'>;
	const ref: SendRef = { kind: 'campaign', id: SEND_ID };

	function campaignSend(overrides: Partial<EmailSendDoc> = {}): EmailSendDoc {
		return {
			_id: SEND_ID,
			_creationTime: 0,
			campaignId: 'campaign_engagement',
			contactId: 'contact_engagement',
			contactEmail: 'jane@example.com',
			status: 'delivered',
			...overrides,
		} as unknown as EmailSendDoc;
	}

	const outcomeEvents = (effects: readonly Effect[]): string[] =>
		effects.flatMap((effect) => (effect.kind === 'transport_outcome' ? [effect.event] : []));

	it('emits the outcome effect beside the shipped unique-open counter, and only then', () => {
		const first = reduceOpened(campaignSend(), { to: 'opened', at: 1_000 }, ref);
		expect(outcomeEvents(first.effects)).toEqual(['opened']);
		// The shipped unique-open counter is emitted for exactly the same events.
		expect(
			first.effects.some(
				(effect) => effect.kind === 'daily_stats_bump' && effect.field === 'opened'
			)
		).toBe(true);

		const reopen = reduceOpened(
			campaignSend({ status: 'opened', openedAt: 1_000, openCount: 1 }),
			{ to: 'opened', at: 2_000 },
			ref
		);
		expect(outcomeEvents(reopen.effects)).toEqual([]);
	});

	it('emits it for a genuine FIRST open whose status cannot move', () => {
		// The reducer reports `recorded`, not `transitioned`, because a terminal
		// row's status stays put — which is why the dispatcher must not gate the
		// effect on `applied === 'transitioned'`.
		const result = reduceOpened(
			campaignSend({ status: 'bounced', bounceType: 'hard' }),
			{ to: 'opened', at: 3_000 },
			ref
		);
		expect(result.applied).toBe('recorded');
		expect(outcomeEvents(result.effects)).toEqual(['opened']);
	});

	it('does the same for clicks, while the per-click customer webhook still fires', () => {
		const first = reduceClicked(
			campaignSend(),
			{ to: 'clicked', at: 1_000, url: 'https://example.com/a' },
			ref
		);
		expect(outcomeEvents(first.effects)).toEqual(['clicked']);

		const second = reduceClicked(
			campaignSend({ status: 'clicked', clickedAt: 1_000 }),
			{ to: 'clicked', at: 2_000, url: 'https://example.com/b' },
			ref
		);
		expect(outcomeEvents(second.effects)).toEqual([]);
		// Unchanged shipped behaviour: every click still emits its own webhook.
		expect(second.effects.some((effect) => effect.kind === 'customer_webhook')).toBe(true);
	});
});

describe('lifecycle transition → one shard of one bucket', () => {
	async function runTransition(
		status: 'queued' | 'sent' | 'delivered' | 'opened',
		transition:
			| { to: 'sent'; at: number; providerMessageId: string; providerType?: string }
			| { to: 'delivered'; at: number }
			| { to: 'opened'; at: number }
			| { to: 'clicked'; at: number; url: string }
			| { to: 'bounced'; at: number; bounceType: 'hard' | 'soft' }
			| { to: 'complained'; at: number }
			| { to: 'failed'; at: number; errorMessage: string; errorCode: string }
	) {
		const t = convexTest(schema, modules);
		let sendId: Id<'emailSends'> | undefined;
		await t.run(async (ctx) => {
			const seeded = await seedAssignedSend(ctx, { status, assignment: {} });
			sendId = seeded.sendId;
		});
		if (!sendId) throw new Error('seed failed');
		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition,
		});
		return await t.run(async (ctx) => await readBuckets(ctx));
	}

	it('records `sent` on queued → sent', async () => {
		const buckets = await runTransition('queued', {
			to: 'sent',
			at: Date.now(),
			providerMessageId: 'pm-sent',
			providerType: 'mta',
		});
		expect(buckets).toHaveLength(1);
		expect(buckets[0]?.organizationId).toBe(OUTCOME_ORG);
		expect(buckets[0]?.cell).toBe(GMAIL_CAMPAIGN_CELL);
		expect(buckets[0]?.arm).toBe('own');
		expect(buckets[0]?.sent).toBe(1);
		expect(buckets[0]?.delivered).toBe(0);
		expect(buckets[0]?.calibrationSent).toBe(0);
	});

	it('records `delivered` on sent → delivered', async () => {
		const buckets = await runTransition('sent', { to: 'delivered', at: Date.now() });
		expect(buckets).toHaveLength(1);
		expect(buckets[0]?.delivered).toBe(1);
		expect(buckets[0]?.sent).toBe(0);
	});

	it('records `opened` on delivered → opened', async () => {
		const buckets = await runTransition('delivered', { to: 'opened', at: Date.now() });
		expect(buckets).toHaveLength(1);
		expect(buckets[0]?.opened).toBe(1);
	});

	it('records `clicked` on opened → clicked', async () => {
		const buckets = await runTransition('opened', {
			to: 'clicked',
			at: Date.now(),
			url: 'https://example.com/offer',
		});
		expect(buckets).toHaveLength(1);
		expect(buckets[0]?.clicked).toBe(1);
	});

	it('records `hard_bounced` on sent → bounced(hard)', async () => {
		const buckets = await runTransition('sent', {
			to: 'bounced',
			at: Date.now(),
			bounceType: 'hard',
		});
		expect(buckets).toHaveLength(1);
		expect(buckets[0]?.hardBounced).toBe(1);
		expect(buckets[0]?.softBounced).toBe(0);
	});

	it('records `soft_bounced` on sent → bounced(soft)', async () => {
		const buckets = await runTransition('sent', {
			to: 'bounced',
			at: Date.now(),
			bounceType: 'soft',
		});
		expect(buckets).toHaveLength(1);
		expect(buckets[0]?.softBounced).toBe(1);
		expect(buckets[0]?.hardBounced).toBe(0);
	});

	it('records `complained` on delivered → complained', async () => {
		const buckets = await runTransition('delivered', { to: 'complained', at: Date.now() });
		expect(buckets).toHaveLength(1);
		expect(buckets[0]?.complained).toBe(1);
	});

	it('counts UNIQUE opens: a second `opened → opened` does not bump the counter', async () => {
		const t = convexTest(schema, modules);
		let sendId: Id<'emailSends'> | undefined;
		await t.run(async (ctx) => {
			const seeded = await seedAssignedSend(ctx, { status: 'delivered', assignment: {} });
			sendId = seeded.sendId;
		});
		if (!sendId) throw new Error('seed failed');

		for (const at of [Date.now(), Date.now() + 1_000]) {
			await t.mutation(internal.delivery.sendLifecycle.transition, {
				send: { kind: 'campaign', id: sendId },
				transition: { to: 'opened', at },
			});
		}

		await t.run(async (ctx) => {
			const buckets = await readBuckets(ctx);
			// Image prefetch re-opens a message several times; the outcome counter
			// must agree with the shipped unique-open dashboard counter.
			expect(sumCounter(buckets, 'opened')).toBe(1);
			// …and the shipped re-open accounting is untouched.
			expect((await ctx.db.get(sendId!))?.openCount).toBe(2);
		});
	});

	it('counts UNIQUE clicks: a second `clicked → clicked` does not bump the counter', async () => {
		const t = convexTest(schema, modules);
		let sendId: Id<'emailSends'> | undefined;
		await t.run(async (ctx) => {
			const seeded = await seedAssignedSend(ctx, { status: 'opened', assignment: {} });
			sendId = seeded.sendId;
		});
		if (!sendId) throw new Error('seed failed');

		for (const url of ['https://example.com/a', 'https://example.com/b']) {
			await t.mutation(internal.delivery.sendLifecycle.transition, {
				send: { kind: 'campaign', id: sendId },
				transition: { to: 'clicked', at: Date.now(), url },
			});
		}

		await t.run(async (ctx) => {
			expect(sumCounter(await readBuckets(ctx), 'clicked')).toBe(1);
			expect((await ctx.db.get(sendId!))?.clickedLinks).toHaveLength(2);
		});
	});

	it('records nothing for a `failed` transition', async () => {
		const buckets = await runTransition('queued', {
			to: 'failed',
			at: Date.now(),
			errorMessage: 'connect ETIMEDOUT',
			errorCode: 'timeout',
		});
		expect(buckets).toHaveLength(0);
	});
});

describe('exclusions', () => {
	it('records nothing for a send with no assignment row (the seed shadow-copy seam, D18)', async () => {
		const t = convexTest(schema, modules);
		let sendId: Id<'emailSends'> | undefined;
		await t.run(async (ctx) => {
			// No `assignment` — a seed probe is a shadow copy through the identical
			// composer and transport, never audience membership, so it never gets an
			// assignment row and must never enter a denominator here.
			const seeded = await seedAssignedSend(ctx, { status: 'queued' });
			sendId = seeded.sendId;
		});
		if (!sendId) throw new Error('seed failed');

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition: { to: 'sent', at: Date.now(), providerMessageId: 'pm-probe' },
		});

		await t.run(async (ctx) => {
			expect(await readBuckets(ctx)).toHaveLength(0);
			// …and the send itself still transitioned: measurement degrades, delivery
			// never does.
			expect((await ctx.db.get(sendId!))?.status).toBe('sent');
		});
	});

	it('reports why nothing was recorded instead of throwing', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const unassigned = await seedAssignedSend(ctx, { status: 'sent' });
			expect(
				await recordTransportOutcomeForSend(ctx, {
					sendId: unassigned.sendId,
					event: 'delivered',
				})
			).toBe('no_assignment');

			const malformed = await seedAssignedSend(ctx, {
				status: 'sent',
				assignment: { cell: 'not-a-cell-key' },
			});
			expect(
				await recordTransportOutcomeForSend(ctx, { sendId: malformed.sendId, event: 'delivered' })
			).toBe('invalid_cell');
			expect(await readBuckets(ctx)).toHaveLength(0);
		});
	});

	it('records nothing for a transactional `test` preview', async () => {
		// The exclusion is `withoutTestSendEffects` blanking the whole effect
		// array one layer up. Pin it here: a future change that applied the
		// outcome effect BEFORE that wrapper would silently feed member previews
		// into the arm denominators, and nothing else in the suite would notice.
		const t = convexTest(schema, modules);
		let sendId: Id<'transactionalSends'> | undefined;
		await t.run(async (ctx) => {
			sendId = await seedAssignedTestPreview(ctx);
		});
		if (!sendId) throw new Error('seed failed');

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'transactional', id: sendId },
			transition: { to: 'sent', at: Date.now(), providerMessageId: 'pm-preview' },
		});

		await t.run(async (ctx) => {
			expect(await readBuckets(ctx)).toHaveLength(0);
			// …and the preview still has its durable lifecycle evidence.
			expect((await ctx.db.get(sendId!))?.status).toBe('sent');
		});
	});

	it('does not double-count a duplicate transition', async () => {
		const t = convexTest(schema, modules);
		let sendId: Id<'emailSends'> | undefined;
		await t.run(async (ctx) => {
			const seeded = await seedAssignedSend(ctx, { status: 'queued', assignment: {} });
			sendId = seeded.sendId;
		});
		if (!sendId) throw new Error('seed failed');

		const transition = {
			to: 'sent' as const,
			at: Date.now(),
			providerMessageId: 'pm-dupe',
			providerType: 'mta',
		};
		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition,
		});
		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition,
		});

		await t.run(async (ctx) => {
			expect(sumCounter(await readBuckets(ctx), 'sent')).toBe(1);
		});
	});
});

describe('the deferral and unsubscribe counters', () => {
	it('records events with no shipped lifecycle source through the same writer', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (const event of ['deferred', 'unsubscribed'] as const) {
				await recordTransportOutcomeForCell(ctx, {
					organizationId: OUTCOME_ORG,
					cell: GMAIL_CAMPAIGN_CELL,
					arm: 'own',
					event,
					isCalibration: false,
				});
			}
			const buckets = await readBuckets(ctx);
			expect(sumCounter(buckets, 'deferred')).toBe(1);
			expect(sumCounter(buckets, 'unsubscribed')).toBe(1);
		});
	});
});

describe('the queued → terminal MTA path (two outcome effects, one transition)', () => {
	async function runMtaTerminal(
		transition:
			| { to: 'bounced'; at: number; bounceType: 'hard' | 'soft' }
			| { to: 'complained'; at: number }
			| { to: 'failed'; at: number; errorMessage: string; errorCode: string }
	) {
		const t = convexTest(schema, modules);
		const providerMessageId = 'pm-mta-terminal';
		await t.run(async (ctx) => {
			await seedAssignedSend(ctx, { status: 'queued', assignment: {}, providerMessageId });
		});
		await t.mutation(internal.delivery.sendLifecycle.transitionMtaByProviderMessageId, {
			providerMessageId,
			transition,
		});
		return await t.run(async (ctx) => await readBuckets(ctx));
	}

	it('records the `sent` denominator exactly once alongside a hard bounce', async () => {
		// This is the one path that emits TWO outcome effects for a single
		// transition — the queued-terminal `sent` accounting plus the bounce — so
		// it is the one most at risk of inflating the denominator it re-supplies.
		const buckets = await runMtaTerminal({ to: 'bounced', at: Date.now(), bounceType: 'hard' });
		expect(sumCounter(buckets, 'sent')).toBe(1);
		expect(sumCounter(buckets, 'hardBounced')).toBe(1);
		expect(sumCounter(buckets, 'softBounced')).toBe(0);
		expect(sumCounter(buckets, 'delivered')).toBe(0);
	});

	it('records `sent` and nothing else for post-DATA ambiguity', async () => {
		// An envelope provably reached the wire, but the disposition is unknown:
		// the denominator is owed, no outcome is.
		const buckets = await runMtaTerminal({
			to: 'failed',
			at: Date.now(),
			errorMessage: 'ambiguous post-data response',
			errorCode: 'ambiguous_post_data',
		});
		expect(sumCounter(buckets, 'sent')).toBe(1);
		expect(sumCounter(buckets, 'hardBounced')).toBe(0);
		expect(sumCounter(buckets, 'softBounced')).toBe(0);
		expect(sumCounter(buckets, 'complained')).toBe(0);
	});

	it('records no `sent` for a local terminal failure that never reached the wire', async () => {
		const buckets = await runMtaTerminal({
			to: 'failed',
			at: Date.now(),
			errorMessage: 'connect ETIMEDOUT',
			errorCode: 'timeout',
		});
		expect(buckets).toHaveLength(0);
	});
});
