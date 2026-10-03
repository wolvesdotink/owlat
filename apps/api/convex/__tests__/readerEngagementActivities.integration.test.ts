/**
 * Reader opens and clicks become contact activities, through the send
 * lifecycle and the single activity writer (#1157):
 *
 *   - a reader open writes one `email_opened` row, sets `hasOpened`, folds the
 *     engagement score, and the segment `email_activity` condition matches;
 *   - an automated open (Apple proxy, scanner) and a scanner click write none;
 *   - a reader click writes one `email_clicked` row and sets `hasClicked`;
 *   - re-opening the same email adds no second row, and the send-time profile
 *     (fed by the reducers directly) still counts the open once.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { createTestCampaign, createTestContact, createTestEmailSend } from './factories';
import { evaluateAgainstContact } from '../conditions/segmentMatch';
import { parseSegmentFilters } from '../conditions';
import { engagementActivityKey } from '../analytics/engagementScore';

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('posthog') &&
			!path.includes('delivery/worker.ts') &&
			!path.includes('campaigns/testSend') &&
			!path.includes('delivery/workpool')
	)
);

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 2, 11, 10, 0);
const SUBJECT = 'Spring update';

type Harness = TestConvex<typeof schema>;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

const drain = (t: Harness) => t.finishAllScheduledFunctions(vi.runAllTimers);

async function seedSend(
	t: Harness
): Promise<{ campaignId: Id<'campaigns'>; contactId: Id<'contacts'>; sendId: Id<'emailSends'> }> {
	return await t.run(async (ctx) => {
		const campaignId = await ctx.db.insert('campaigns', createTestCampaign({ status: 'sent' }));
		const contactId = await ctx.db.insert(
			'contacts',
			createTestContact({ timezone: 'Europe/Berlin' }) as never
		);
		const sendId = await ctx.db.insert(
			'emailSends',
			createTestEmailSend({
				campaignId,
				contactId,
				status: 'delivered',
				sentAt: NOW - 2 * HOUR,
				deliveredAt: NOW - 2 * HOUR,
				personalizedSubject: SUBJECT,
			}) as never
		);
		return { campaignId, contactId, sendId };
	});
}

const activitiesOf = (t: Harness, contactId: Id<'contacts'>) =>
	t.run((ctx) =>
		ctx.db
			.query('contactActivities')
			.withIndex('by_contact', (q) => q.eq('contactId', contactId))
			.collect()
	);

async function matchesEmailActivity(
	t: Harness,
	contactId: Id<'contacts'>,
	field: 'opened' | 'clicked'
): Promise<boolean> {
	return await t.run(async (ctx) => {
		const contact = await ctx.db.get(contactId);
		const parsed = parseSegmentFilters({
			logic: 'AND',
			conditions: [{ kind: 'email_activity', field, operator: 'is_true' }],
		});
		return evaluateAgainstContact(ctx, parsed.conditions, parsed.logic, contact!);
	});
}

describe('reader opens', () => {
	it('write one email_opened row, set hasOpened, fold the score and match the segment', async () => {
		const t = convexTest(schema, modules);
		const { campaignId, contactId, sendId } = await seedSend(t);
		expect(await matchesEmailActivity(t, contactId, 'opened')).toBe(false);

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition: { to: 'opened', at: NOW, agent: 'client' },
		});
		await drain(t);

		const rows = await activitiesOf(t, contactId);
		expect(rows.map((r) => [r.activityType, r.metadata, r.occurredAt])).toEqual([
			['email_opened', { campaignId: String(campaignId), emailSubject: SUBJECT }, NOW],
		]);

		const contact = await t.run((ctx) => ctx.db.get(contactId));
		expect(contact?.hasOpened).toBe(true);
		expect(contact?.hasClicked).toBeUndefined();
		expect(contact?.engagementScoreState?.lastFoldedKey).toBe(engagementActivityKey('open', NOW));
		expect(await matchesEmailActivity(t, contactId, 'opened')).toBe(true);
		expect(await matchesEmailActivity(t, contactId, 'clicked')).toBe(false);
	});

	it('add no second row when the same email is opened again, and the profile counts it once', async () => {
		const t = convexTest(schema, modules);
		const { contactId, sendId } = await seedSend(t);

		for (const at of [NOW, NOW + HOUR]) {
			await t.mutation(internal.delivery.sendLifecycle.transition, {
				send: { kind: 'campaign', id: sendId },
				transition: { to: 'opened', at, agent: 'client' },
			});
		}
		await drain(t);

		const rows = await activitiesOf(t, contactId);
		expect(rows.filter((r) => r.activityType === 'email_opened')).toHaveLength(1);
		const contact = await t.run((ctx) => ctx.db.get(contactId));
		expect(contact?.sendTimeProfile?.total).toBe(1);
	});

	it.each(['apple_proxy', 'scanner'] as const)(
		'write nothing for an automated (%s) open',
		async (agent) => {
			const t = convexTest(schema, modules);
			const { contactId, sendId } = await seedSend(t);

			await t.mutation(internal.delivery.sendLifecycle.transition, {
				send: { kind: 'campaign', id: sendId },
				transition: { to: 'opened', at: NOW, agent },
			});
			await drain(t);

			expect(await activitiesOf(t, contactId)).toEqual([]);
			const contact = await t.run((ctx) => ctx.db.get(contactId));
			expect(contact?.hasOpened).toBeUndefined();
			expect(await matchesEmailActivity(t, contactId, 'opened')).toBe(false);
		}
	);
});

describe('reader clicks', () => {
	it('write one email_clicked row with the link and set hasClicked', async () => {
		const t = convexTest(schema, modules);
		const { campaignId, contactId, sendId } = await seedSend(t);
		const url = 'https://example.com/pricing';

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition: { to: 'clicked', at: NOW, url, agent: 'client' },
		});
		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition: { to: 'clicked', at: NOW + HOUR, url: 'https://example.com/b', agent: 'client' },
		});
		await drain(t);

		const rows = await activitiesOf(t, contactId);
		expect(rows.map((r) => [r.activityType, r.metadata, r.occurredAt])).toEqual([
			['email_clicked', { campaignId: String(campaignId), linkUrl: url }, NOW],
		]);
		const contact = await t.run((ctx) => ctx.db.get(contactId));
		expect(contact?.hasClicked).toBe(true);
		expect(await matchesEmailActivity(t, contactId, 'clicked')).toBe(true);
	});

	it('write nothing for a scanner click', async () => {
		const t = convexTest(schema, modules);
		const { contactId, sendId } = await seedSend(t);

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition: { to: 'clicked', at: NOW, url: 'https://example.com/a', agent: 'scanner' },
		});
		await drain(t);

		expect(await activitiesOf(t, contactId)).toEqual([]);
		const contact = await t.run((ctx) => ctx.db.get(contactId));
		expect(contact?.hasClicked).toBeUndefined();
	});
});
