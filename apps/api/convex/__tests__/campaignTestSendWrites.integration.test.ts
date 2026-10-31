/**
 * What the test-send actions (`campaigns/testSend.ts`) write: the queued test
 * Sends and their retention callbacks, the self-healed default sender, and the
 * per-user rate-limit token, including which refusals still spend one.
 */

import { convexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	createTestCampaign,
	createTestDomain,
	createTestEmailTemplate,
	createTestInstanceSettings,
} from './factories';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const session = { userId: 'member-1', role: 'owner', activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue(session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue(session.userId),
		getMutationContext: vi.fn().mockResolvedValue(session),
	};
});

// The Workpool component is not registered here; the queued row is the record.
vi.mock('../delivery/workpool', () => ({
	transactionalEmailPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
	campaignEmailPool: { enqueueAction: vi.fn().mockResolvedValue(undefined) },
}));

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('posthog') &&
			!path.includes('delivery/worker.ts') &&
			!path.includes('delivery/workpool')
	)
);

const MEMBERS = ['ann@example.com', 'bob@example.com'];

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubEnv('EMAIL_PROVIDER', 'mta');
	vi.stubEnv('MTA_API_URL', 'https://mta.example.com');
	vi.stubEnv('MTA_API_KEY', 'test-key');
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

type Harness = TestConvex<typeof schema>;

/** A verified domain, the org default sender (not yet curated) and two members. */
async function setup(): Promise<{ t: Harness; campaignId: Id<'campaigns'> }> {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	const campaignId = await t.run(async (ctx) => {
		const now = Date.now();
		await ctx.db.insert(
			'domains',
			createTestDomain({ domain: 'example.com', status: 'verified', lastVerifiedAt: now })
		);
		await ctx.db.insert(
			'instanceSettings',
			createTestInstanceSettings({
				defaultFromName: 'Example News',
				defaultFromEmail: 'news@example.com',
				isCustomCampaignSendersAllowed: false,
			})
		);
		for (const [i, email] of MEMBERS.entries()) {
			await ctx.db.insert('userProfiles', {
				authUserId: `member-${i + 1}`,
				email,
				name: `Member ${i + 1}`,
				createdAt: now,
				updatedAt: now,
			});
		}
		const templateId = await ctx.db.insert(
			'emailTemplates',
			createTestEmailTemplate({
				subject: 'Hello {{firstName}}',
				htmlContent: '<p>Hi {{firstName}}</p>',
				defaultLanguage: 'en',
			})
		);
		return await ctx.db.insert(
			'campaigns',
			createTestCampaign({
				status: 'draft',
				emailTemplateId: templateId,
				fromEmail: 'news@example.com',
				fromName: 'Example News',
				replyTo: 'reply@example.com',
				subject: undefined,
			})
		);
	});
	return { t, campaignId };
}

async function written(t: Harness) {
	return await t.run(async (ctx) => ({
		sends: await ctx.db.query('transactionalSends').collect(),
		senders: await ctx.db.query('campaignSenders').collect(),
		retention: (await ctx.db.system.query('_scheduled_functions').collect()).filter(
			(job) =>
				job.state.kind === 'pending' &&
				job.name === 'delivery/enqueueTestSend:deleteExpiredTestSend'
		),
	}));
}

/** Spend the caller's whole burst (20 tokens) on refused recipients. */
async function spendBurstOnOutsiders(send: () => Promise<unknown>) {
	for (let i = 0; i < 20; i++) {
		await expect(send()).rejects.toThrow(/only be sent to your organization's own member/);
	}
}

describe('sendTestEmail', () => {
	it('queues one test Send, seeds the default sender and schedules its retention', async () => {
		const { t, campaignId } = await setup();

		const result = await t.action(api.campaigns.testSend.sendTestEmail, {
			campaignId,
			testEmail: 'ann@example.com',
		});

		const state = await written(t);
		expect(state.sends).toHaveLength(1);
		expect(state.sends[0]).toMatchObject({
			kind: 'test',
			email: 'ann@example.com',
			subject: '[TEST] Hello Test',
			status: 'queued',
		});
		expect(result).toEqual({
			success: true,
			id: state.sends[0]!._id,
			message: 'Test email queued for ann@example.com',
			language: 'en',
		});
		expect(state.senders).toHaveLength(1);
		expect(state.senders[0]).toMatchObject({ email: 'news@example.com', isDefault: true });
		expect(state.retention.map((job) => job.args[0])).toEqual([
			{ sendId: state.sends[0]!._id, queuedAt: state.sends[0]!.queuedAt },
		]);
	});

	it('a refused recipient still spends a rate-limit token and queues nothing', async () => {
		const { t, campaignId } = await setup();
		const send = (testEmail: string) =>
			t.action(api.campaigns.testSend.sendTestEmail, { campaignId, testEmail });

		await spendBurstOnOutsiders(() => send('outsider@example.org'));
		await expect(send('ann@example.com')).rejects.toThrow(/Too many test emails/);

		expect((await written(t)).sends).toEqual([]);
	});

	it('without a delivery provider: refuses, queues nothing, and the token stays spent', async () => {
		const { t, campaignId } = await setup();
		vi.stubEnv('EMAIL_PROVIDER', '');
		const send = () =>
			t.action(api.campaigns.testSend.sendTestEmail, { campaignId, testEmail: 'ann@example.com' });

		await expect(send()).rejects.toThrow(/No email delivery provider is configured/);
		expect((await written(t)).sends).toEqual([]);

		for (let i = 0; i < 19; i++) await expect(send()).rejects.toThrow(/No email delivery provider/);
		await expect(send()).rejects.toThrow(/Too many test emails/);
	});
});

describe('sendTestEmailFromTemplate', () => {
	const preview = {
		htmlContent: '<p>Hi {{firstName}}</p>',
		subject: 'Preview {{firstName}}',
		fromEmail: 'news@example.com',
		fromName: 'Example News',
		sampleData: { firstName: 'Sam' },
	};

	it('queues one test Send per recipient with the composed preview', async () => {
		const { t } = await setup();

		const result = await t.action(api.campaigns.testSend.sendTestEmailFromTemplate, {
			...preview,
			testEmails: MEMBERS,
		});

		expect(result).toEqual({
			success: true,
			results: MEMBERS.map((email) => ({ email, success: true })),
			message: `Test emails queued for ${MEMBERS.join(', ')}`,
		});
		const state = await written(t);
		expect(state.sends.map((send) => [send.email, send.subject, send.kind]).sort()).toEqual([
			['ann@example.com', '[TEST] Preview Sam', 'test'],
			['bob@example.com', '[TEST] Preview Sam', 'test'],
		]);
		expect(state.retention).toHaveLength(2);
		expect(state.senders.map((sender) => sender.email)).toEqual(['news@example.com']);
	});

	it('one refused recipient refuses the whole call and still spends the token', async () => {
		const { t } = await setup();
		const send = (testEmails: string[]) =>
			t.action(api.campaigns.testSend.sendTestEmailFromTemplate, { ...preview, testEmails });

		await spendBurstOnOutsiders(() => send(['ann@example.com', 'outsider@example.org']));
		await expect(send(['ann@example.com'])).rejects.toThrow(/Too many test emails/);

		expect((await written(t)).sends).toEqual([]);
	});

	it('without a delivery provider: names every recipient that failed and queues nothing', async () => {
		const { t } = await setup();
		vi.stubEnv('EMAIL_PROVIDER', '');

		await expect(
			t.action(api.campaigns.testSend.sendTestEmailFromTemplate, {
				...preview,
				testEmails: MEMBERS,
			})
		).rejects.toThrow(
			/Failed to send test emails: ann@example\.com: No email delivery provider.*bob@example\.com: No email delivery provider/
		);
		expect((await written(t)).sends).toEqual([]);
	});
});
