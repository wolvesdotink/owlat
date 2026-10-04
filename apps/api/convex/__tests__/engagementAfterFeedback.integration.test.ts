import { convexTest } from 'convex-test';
import { describe, it, expect, afterEach } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import {
	createTestCampaign,
	createTestContact,
	createTestEmailSend,
	createTestTransactionalEmail,
	flushScheduled,
} from './factories';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { rollupCampaignStatsRow } from '../campaigns/statShards';

// #1225: a reader open or click on a soft-bounced or complained send is
// recorded as engagement without moving the status. A hard-bounced send still
// refuses it. None of it resets the soft-bounce counter or lifts a suppression.

const modules = import.meta.glob('../**/*.*s');

afterEach(async () => {
	await flushScheduled();
});

const RECIPIENT = 'reader@example.com';
// Well past the arrival-prefetch window after `sentAt`, so these are reader events.
const READER_EVENTS = [
	{ to: 'opened', at: 10_000, agent: 'client' },
	{ to: 'opened', at: 90_000, agent: 'client' },
	{ to: 'clicked', at: 91_000, url: 'https://example.com/a', agent: 'client' },
	{ to: 'clicked', at: 92_000, url: 'https://example.com/b', agent: 'client' },
] as const;

type Seeded = {
	t: ReturnType<typeof convexTest>;
	campaignId: Id<'campaigns'>;
	contactId: Id<'contacts'>;
	sendId: Id<'emailSends'>;
};

async function seed(row: Record<string, unknown>): Promise<Seeded> {
	const t = convexTest(schema, modules);
	let campaignId!: Id<'campaigns'>;
	let contactId!: Id<'contacts'>;
	let sendId!: Id<'emailSends'>;
	await t.run(async (ctx) => {
		campaignId = await ctx.db.insert('campaigns', createTestCampaign());
		// Two soft bounces on earlier sends: the counter that escalates to a
		// suppression at the threshold.
		contactId = await ctx.db.insert(
			'contacts',
			createTestContact({ email: RECIPIENT, softBounceCount: 2 })
		);
		sendId = await ctx.db.insert(
			'emailSends',
			createTestEmailSend({
				campaignId,
				contactId,
				contactEmail: RECIPIENT,
				sentAt: 100,
				...row,
			})
		);
		await ctx.db.insert('blockedEmails', {
			email: RECIPIENT,
			reason: row['status'] === 'complained' ? 'complained' : 'bounced',
			createdAt: 500,
		});
	});
	return { t, campaignId, contactId, sendId };
}

async function readCampaignWithStats(ctx: MutationCtx, campaignId: Id<'campaigns'>) {
	const c = await ctx.db.get(campaignId);
	if (c) await rollupCampaignStatsRow(ctx, c);
	return ctx.db.get(campaignId);
}

/** The customer-webhook fanouts scheduled so far, by event literal. */
async function fanoutEvents(t: ReturnType<typeof convexTest>): Promise<string[]> {
	return await t.run(async (ctx) => {
		const jobs = await ctx.db.system.query('_scheduled_functions').collect();
		return jobs
			.filter((job) => job.name === 'webhooks/deliveryQueries:enqueueFanoutDeliveries')
			.map((job) => (job.args[0] as { event: string }).event);
	});
}

async function engagementActivities(t: ReturnType<typeof convexTest>): Promise<string[]> {
	return await t.run(async (ctx) =>
		(await ctx.db.query('contactActivities').collect())
			.map((a) => a.activityType)
			.filter((type) => type === 'email_opened' || type === 'email_clicked')
	);
}

describe('reader engagement after a bounce or complaint (#1225)', () => {
	it.each([
		{
			label: 'soft-bounced',
			row: { status: 'bounced', bounceType: 'soft', bouncedAt: 500 },
			activities: ['email_opened', 'email_clicked'],
		},
		{
			label: 'complained',
			row: { status: 'complained', complainedAt: 500 },
			// A complaint outweighs engagement on the contact: no activity row, so no
			// `hasOpened` / `hasClicked` flag and no engagement-score lift.
			activities: [],
		},
	] as const)(
		'records the first open and click on a $label send once, keeping its status',
		async ({ row, activities }) => {
			const { t, campaignId, contactId, sendId } = await seed(row);

			for (const transition of READER_EVENTS) {
				const outcome = await t.mutation(internal.delivery.sendLifecycle.transition, {
					send: { kind: 'campaign', id: sendId },
					transition,
				});
				expect(outcome).toMatchObject({
					ok: true,
					applied: 'recorded',
					from: row.status,
					to: transition.to,
				});
			}

			await t.run(async (ctx) => {
				const send = await ctx.db.get(sendId);
				expect(send?.status).toBe(row.status);
				expect(send?.bounceType).toBe('bounceType' in row ? row.bounceType : undefined);
				expect(send?.openCount).toBe(2);
				expect(send?.openedAt).toBe(10_000);
				expect(send?.clickedAt).toBe(91_000);
				expect(send?.clickedLinks?.map((l) => l.url)).toEqual([
					'https://example.com/a',
					'https://example.com/b',
				]);
				// The open is delivery evidence, recorded once like any other.
				expect(send?.deliveredAt).toBe(10_000);

				const campaign = await readCampaignWithStats(ctx, campaignId);
				expect(campaign?.statsOpened).toBe(1);
				expect(campaign?.statsClicked).toBe(1);
				expect(campaign?.statsDelivered).toBe(1);

				// An open neither resets the soft-bounce counter nor lifts the block.
				const contact = await ctx.db.get(contactId);
				expect(contact?.softBounceCount).toBe(2);
				expect(contact?.hasOpened).toBe(activities.length > 0 ? true : undefined);
				const blocks = await ctx.db
					.query('blockedEmails')
					.withIndex('by_email', (q) => q.eq('email', RECIPIENT))
					.collect();
				expect(blocks).toHaveLength(1);
			});

			expect(await engagementActivities(t)).toEqual(activities);
			const events = await fanoutEvents(t);
			// `email.opened` is first-open only; `email.clicked` goes out per click.
			expect(events.filter((e) => e === 'email.opened')).toHaveLength(1);
			expect(events.filter((e) => e === 'email.clicked')).toHaveLength(2);
		}
	);

	it('refuses an open or click on a hard-bounced send and records nothing', async () => {
		const { t, campaignId, contactId, sendId } = await seed({
			status: 'bounced',
			bounceType: 'hard',
			bouncedAt: 500,
		});

		for (const transition of READER_EVENTS) {
			const outcome = await t.mutation(internal.delivery.sendLifecycle.transition, {
				send: { kind: 'campaign', id: sendId },
				transition,
			});
			expect(outcome).toMatchObject({ ok: false, reason: 'terminal' });
		}

		await t.run(async (ctx) => {
			const send = await ctx.db.get(sendId);
			expect(send?.status).toBe('bounced');
			expect(send?.openCount ?? 0).toBe(0);
			expect(send?.openedAt).toBeUndefined();
			expect(send?.clickedLinks).toBeUndefined();
			expect(send?.deliveredAt).toBeUndefined();
			const campaign = await readCampaignWithStats(ctx, campaignId);
			expect(campaign?.statsOpened ?? 0).toBe(0);
			expect(campaign?.statsDelivered ?? 0).toBe(0);
			expect((await ctx.db.get(contactId))?.softBounceCount).toBe(2);
		});
		expect(await engagementActivities(t)).toEqual([]);
		expect(await fanoutEvents(t)).toEqual([]);
	});

	it('counts an automated open on a soft-bounced send apart, without a reader open', async () => {
		const { t, campaignId, contactId, sendId } = await seed({
			status: 'bounced',
			bounceType: 'soft',
			bouncedAt: 500,
		});

		const outcome = await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition: { to: 'opened', at: 1000, agent: 'apple_proxy' },
		});
		expect(outcome).toMatchObject({ ok: true, applied: 'recorded', from: 'bounced' });

		await t.run(async (ctx) => {
			const send = await ctx.db.get(sendId);
			expect(send?.status).toBe('bounced');
			expect(send?.automatedOpenCount).toBe(1);
			expect(send?.openCount ?? 0).toBe(0);
			expect(send?.openedAt).toBeUndefined();
			const campaign = await readCampaignWithStats(ctx, campaignId);
			expect(campaign?.statsOpened ?? 0).toBe(0);
			expect(campaign?.statsAutomatedOpened).toBe(1);
			expect((await ctx.db.get(contactId))?.softBounceCount).toBe(2);
		});
		expect(await engagementActivities(t)).toEqual([]);
		expect((await fanoutEvents(t)).filter((e) => e === 'email.opened')).toEqual([]);
	});

	it('records a provider-reported open on a soft-bounced transactional send', async () => {
		const t = convexTest(schema, modules);
		let sendId!: Id<'transactionalSends'>;
		await t.run(async (ctx) => {
			const transactionalEmailId = await ctx.db.insert(
				'transactionalEmails',
				createTestTransactionalEmail()
			);
			sendId = await ctx.db.insert('transactionalSends', {
				kind: 'transactional',
				transactionalEmailId,
				email: RECIPIENT,
				status: 'bounced',
				bounceType: 'soft',
				bouncedAt: 500,
				providerMessageId: 'tx-soft-1',
				sentAt: 100,
			});
		});

		const outcome = await t.mutation(
			internal.delivery.sendLifecycle.transitionByProviderMessageId,
			{ providerMessageId: 'tx-soft-1', transition: { to: 'opened', at: 1000 } }
		);
		expect(outcome).toMatchObject({ ok: true, applied: 'recorded', from: 'bounced' });

		await t.run(async (ctx) => {
			const send = await ctx.db.get(sendId);
			expect(send?.status).toBe('bounced');
			expect(send?.openCount).toBe(1);
			expect(send?.openedAt).toBe(1000);
		});
	});
});
