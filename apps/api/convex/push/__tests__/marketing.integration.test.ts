/**
 * Web Push for marketing notices (push/dispatch → push/marketing): the notice
 * is re-checked at send time against the person's current role, switch and
 * the occurrence itself, quiet hours hold it like mail, a reminder lives on the
 * push service only until its campaign starts and carries Open and Cancel
 * buttons, and private notifications name nothing.
 */

import type { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import {
	createTestAutomation,
	createTestCampaign,
	enableFeatures,
} from '../../__tests__/factories';
import {
	VAPID_ENV,
	pushHarness,
	quietWindowAroundNow,
	seedDevice,
	setMemberRole,
} from './pushFixtures';

// Sibling `push/*` modules glob in as `../foo.ts`; convex-test resolves function
// paths from the convex root, so re-root them to `../../push/foo.ts`.
const modules = Object.fromEntries(
	Object.entries(import.meta.glob('../../**/*.*s')).map(([key, load]) =>
		key.startsWith('../') && !key.startsWith('../../')
			? ['../../push/' + key.slice(3), load]
			: [key, load]
	)
);

type T = ReturnType<typeof convexTest>;

const USER = 'user-a';

beforeEach(() => {
	for (const [key, value] of Object.entries(VAPID_ENV)) vi.stubEnv(key, value);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

async function setup(): Promise<T> {
	const t = await pushHarness(modules, { [USER]: 'admin' });
	await enableFeatures(t, ['campaigns', 'automations']);
	await seedDevice(t, USER);
	return t;
}

async function seedNotice(
	t: T,
	fields: Partial<Doc<'marketingNotices'>> & Pick<Doc<'marketingNotices'>, 'kind'>
): Promise<Id<'marketingNotices'>> {
	return t.run((ctx) =>
		ctx.db.insert('marketingNotices', {
			userId: USER,
			eventKey: `test:${Math.random()}`,
			subjectKey: 'test',
			url: '/dashboard',
			createdAt: Date.now(),
			...fields,
		})
	);
}

async function prepare(t: T, noticeId: Id<'marketingNotices'>, userId = USER) {
	const deliveries = await t.mutation(internal.push.dispatch.prepareDelivery, {
		userId,
		event: { kind: 'marketing', noticeId },
	});
	return deliveries.map((delivery) => ({ ...delivery, payload: JSON.parse(delivery.payload) }));
}

async function seedFinished(t: T): Promise<Id<'marketingNotices'>> {
	const campaignId = await t.run((ctx) =>
		ctx.db.insert(
			'campaigns',
			createTestCampaign({ name: 'Autumn launch', status: 'sent' }) as never
		)
	);
	return seedNotice(t, {
		kind: 'campaign_finished',
		campaignId,
		name: 'Autumn launch',
		percent: 98,
		subjectKey: `campaign:${campaignId}`,
		url: `/dashboard/campaigns/${campaignId}/report`,
	});
}

describe('push.dispatch marketing', () => {
	it('pushes a finished campaign with its delivered share to the person it was written for', async () => {
		const t = await setup();
		const noticeId = await seedFinished(t);
		const [delivery] = await prepare(t, noticeId);
		expect(delivery?.payload).toMatchObject({
			title: 'Campaign finished',
			body: 'Autumn launch · 98% delivered',
		});
		expect(delivery?.ttlSeconds).toBe(12 * 3600);
		expect(await prepare(t, noticeId, 'user-b')).toEqual([]);
	});

	it('sends a reminder with Open and Cancel that expires when the campaign starts', async () => {
		const t = await setup();
		const scheduledAt = Date.now() + 15 * 60_000;
		const campaignId = await t.run((ctx) =>
			ctx.db.insert(
				'campaigns',
				createTestCampaign({ name: 'Webinar', status: 'scheduled', scheduledAt }) as never
			)
		);
		const noticeId = await seedNotice(t, {
			kind: 'campaign_reminder',
			campaignId,
			name: 'Webinar',
			scheduledAt,
			url: `/dashboard/campaigns/${campaignId}/edit`,
		});
		const [delivery] = await prepare(t, noticeId);
		expect(delivery?.payload.actions).toEqual([
			{ action: 'open', title: 'Open', url: `/dashboard/campaigns/${campaignId}/edit` },
			{
				action: 'cancel',
				title: 'Cancel send',
				url: `/dashboard/campaigns/${campaignId}/edit?intent=cancel`,
			},
		]);
		expect(delivery?.ttlSeconds).toBeGreaterThan(0);
		expect(delivery?.ttlSeconds).toBeLessThanOrEqual(15 * 60);

		// Cancelled before the push went out: nothing to remind about.
		await t.run((ctx) => ctx.db.patch(campaignId, { status: 'cancelled' }));
		expect(await prepare(t, noticeId)).toEqual([]);
	});

	it('sends nothing once the person turned the switch off or lost the role', async () => {
		const t = await setup();
		const pausedNotice = await seedNotice(t, {
			kind: 'automation_paused',
			name: 'Welcome',
			automationId: await t.run((ctx) =>
				ctx.db.insert(
					'automations',
					createTestAutomation({ name: 'Welcome', status: 'paused' }) as never
				)
			),
		});
		expect(await prepare(t, pausedNotice)).toHaveLength(1);

		await setMemberRole(t, USER, 'editor');
		expect(await prepare(t, pausedNotice)).toEqual([]);
		await setMemberRole(t, USER, 'admin');

		await t.run((ctx) =>
			ctx.db.insert('marketingNotificationSettings', {
				userId: USER,
				isAutomationProblemsOn: false,
				updatedAt: Date.now(),
			})
		);
		expect(await prepare(t, pausedNotice)).toEqual([]);
	});

	it('holds a notice back in quiet hours and keeps names off the lock screen when private', async () => {
		const t = await setup();
		const noticeId = await seedFinished(t);
		const now = Date.now();
		await t.run((ctx) =>
			ctx.db.insert('mailUserSettings', {
				userId: USER,
				autoAdvance: 'next',
				quietHours: quietWindowAroundNow(),
				createdAt: now,
				updatedAt: now,
			})
		);
		expect(await prepare(t, noticeId)).toEqual([]);
		const device = await t.run((ctx) => ctx.db.query('pushSubscriptions').first());
		expect(device?.quietDeferredCount).toBe(1);

		await t.run(async (ctx) => {
			const row = await ctx.db.query('mailUserSettings').first();
			await ctx.db.patch(row!._id, {
				quietHours: { ...quietWindowAroundNow(), enabled: false },
				isHidePreviewOn: true,
			});
		});
		const [delivery] = await prepare(t, noticeId);
		expect(delivery?.payload.body).toBe('A campaign has finished sending');
		expect(JSON.stringify(delivery?.payload)).not.toContain('Autumn launch');
	});
});
