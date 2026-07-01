import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import {
	createTestCampaign,
	createTestContact,
	createTestEmailTemplate,
	createTestTopic,
	createTestDomain,
	createTestEmailSend,
	createTestBlockedEmail,
	createTestSegment,
} from './factories';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import type { WorkId } from '@convex-dev/workpool';
import { rollupCampaignStatsRow } from '../campaigns/statShards';

const testWorkId = 'test-work-id' as WorkId;

// Campaign send stats are write-sharded; roll the shards into campaigns.stats*
// before reading (the production rollup is async/cron).
async function readCampaignWithStats(ctx: MutationCtx, campaignId: Id<'campaigns'>) {
	const c = await ctx.db.get(campaignId);
	if (c) await rollupCampaignStatsRow(ctx, c);
	return ctx.db.get(campaignId);
}

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

// Exclude 'use node' files that need external deps (AWS SDK, PostHog, Resend, etc.)
// Also exclude emailWorkpool (requires @convex-dev/workpool components) and email worker actions
const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('posthog') &&
			!path.includes('delivery/worker.ts') &&
			!path.includes('campaigns/send.ts') &&
			!path.includes('campaigns/testSend') &&
			!path.includes('delivery/workpool')
	)
);

// Suppress unhandled rejections from convex-test trying to run excluded scheduled functions
// (sendNow schedules emails.startCampaignSend and posthog.capture which are excluded)
const suppressedErrors: Error[] = [];
const unhandledRejectionHandler = (err: Error) => {
	if (
		err.message.includes('Could not find module') ||
		err.message.includes('Write outside of transaction')
	) {
		suppressedErrors.push(err);
	} else {
		throw err;
	}
};

beforeEach(() => {
	suppressedErrors.length = 0;
	process.on('unhandledRejection', unhandledRejectionHandler);
});

afterEach(() => {
	process.removeListener('unhandledRejection', unhandledRejectionHandler);
});

// ============ Data Setup Helper ============

interface SendFlowData {
	domainId: Id<'domains'>;
	emailTemplateId: Id<'emailTemplates'>;
	topicId: Id<'topics'>;
	aliceId: Id<'contacts'>;
	bobId: Id<'contacts'>;
	charlieId: Id<'contacts'>;
	campaignId: Id<'campaigns'>;
}

async function setupSendFlowData(t: TestConvex<typeof schema>): Promise<SendFlowData> {
	const result = {} as SendFlowData;

	await t.run(async (ctx) => {
		// Verified domain
		result.domainId = await ctx.db.insert(
			'domains',
			createTestDomain({
				domain: 'example.com',
				status: 'verified',
				lastVerifiedAt: Date.now(),
			})
		);

		// Published email template
		result.emailTemplateId = await ctx.db.insert(
			'emailTemplates',
			createTestEmailTemplate({
				status: 'published',
				htmlContent: '<p>Hello {{firstName}}</p>',
				subject: 'Welcome {{firstName}}',
			})
		);

		// Topic (requires DOI so we can test DOI filtering)
		result.topicId = await ctx.db.insert(
			'topics',
			createTestTopic({ requireDoubleOptIn: true })
		);

		// Contacts: alice and bob are DOI-confirmed (eligible), charlie has pending DOI
		result.aliceId = await ctx.db.insert(
			'contacts',
			createTestContact({ email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith', doiStatus: 'confirmed', doiConfirmedAt: Date.now() })
		);
		result.bobId = await ctx.db.insert(
			'contacts',
			createTestContact({ email: 'bob@example.com', firstName: 'Bob', lastName: 'Jones', doiStatus: 'confirmed', doiConfirmedAt: Date.now() })
		);
		result.charlieId = await ctx.db.insert(
			'contacts',
			createTestContact({ email: 'charlie@example.com', firstName: 'Charlie', lastName: 'Brown', doiStatus: 'pending' })
		);

		// Topic memberships (no DOI fields — DOI is on the contact)
		await ctx.db.insert('contactTopics', {
			contactId: result.aliceId,
			topicId: result.topicId,
			addedAt: Date.now(),
		});
		await ctx.db.insert('contactTopics', {
			contactId: result.bobId,
			topicId: result.topicId,
			addedAt: Date.now(),
		});
		await ctx.db.insert('contactTopics', {
			contactId: result.charlieId,
			topicId: result.topicId,
			addedAt: Date.now(),
		});

		// Campaign
		result.campaignId = await ctx.db.insert(
			'campaigns',
			createTestCampaign({
				status: 'draft',
				emailTemplateId: result.emailTemplateId,
				fromEmail: 'sender@example.com',
				audience: { kind: 'topic', topicId: result.topicId },
			})
		);
	});

	return result;
}

// ============ sendNow Validation ============

describe('sendNow validation', () => {
	it('should reject campaign missing email template', async () => {
		const t = convexTest(schema, modules);

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'domains',
				createTestDomain({ domain: 'example.com', status: 'verified', lastVerifiedAt: Date.now() })
			);
		});

		let campaignId: Id<'campaigns'>;
		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'draft',
					fromEmail: 'sender@example.com',
					// no emailTemplateId
				})
			);
		});

		await expect(
			t.mutation(api.campaigns.campaigns.sendNow, { campaignId: campaignId! })
		).rejects.toThrow(/must have an email template/);
	});

	it('should reject campaign missing fromEmail', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;

		await t.run(async (ctx) => {
			const templateId = await ctx.db.insert(
				'emailTemplates',
				createTestEmailTemplate({ status: 'published' })
			);
			const topicId = await ctx.db.insert('topics', createTestTopic());
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'draft',
					emailTemplateId: templateId,
					audience: { kind: 'topic', topicId },
					fromEmail: undefined,
				})
			);
		});

		await expect(
			t.mutation(api.campaigns.campaigns.sendNow, { campaignId: campaignId! })
		).rejects.toThrow(/must have a from email/);
	});

	it('should reject campaign missing audience', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;

		await t.run(async (ctx) => {
			const templateId = await ctx.db.insert(
				'emailTemplates',
				createTestEmailTemplate({ status: 'published' })
			);
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'draft',
					emailTemplateId: templateId,
					fromEmail: 'sender@example.com',
					// no audience configured
				})
			);
		});

		await expect(
			t.mutation(api.campaigns.campaigns.sendNow, { campaignId: campaignId! })
		).rejects.toThrow(/must have an audience/);
	});

	it('should reject unverified domain', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;

		await t.run(async (ctx) => {
			// Domain exists but is not verified
			await ctx.db.insert(
				'domains',
				createTestDomain({ domain: 'example.com', status: 'pending' })
			);
			const templateId = await ctx.db.insert(
				'emailTemplates',
				createTestEmailTemplate({ status: 'published' })
			);
			const topicId = await ctx.db.insert('topics', createTestTopic());
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'draft',
					emailTemplateId: templateId,
					fromEmail: 'sender@example.com',
					audience: { kind: 'topic', topicId },
				})
			);
		});

		await expect(
			t.mutation(api.campaigns.campaigns.sendNow, { campaignId: campaignId! })
		).rejects.toThrow(/not verified/);
	});

	it('should reject non-draft campaign', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'domains',
				createTestDomain({ domain: 'example.com', status: 'verified', lastVerifiedAt: Date.now() })
			);
			const templateId = await ctx.db.insert(
				'emailTemplates',
				createTestEmailTemplate({ status: 'published' })
			);
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({
					status: 'sent',
					emailTemplateId: templateId,
					fromEmail: 'sender@example.com',
				})
			);
		});

		await expect(
			t.mutation(api.campaigns.campaigns.sendNow, { campaignId: campaignId! })
		).rejects.toThrow(/Only draft or scheduled/);
	});
});

// ============ sendNow Happy Path ============

describe('sendNow happy path', () => {
	it('should transition campaign to sending with zeroed stats', async () => {
		const t = convexTest(schema, modules);
		const data = await setupSendFlowData(t);

		await t.mutation(api.campaigns.campaigns.sendNow, { campaignId: data.campaignId });
		// Do NOT call t.finishInProgressScheduledFunctions() — the scheduled action
		// would try to call the email provider

		await t.run(async (ctx) => {
			const campaign = await readCampaignWithStats(ctx, data.campaignId);
			expect(campaign).toBeDefined();
			expect(campaign!.status).toBe('sending');
			expect(campaign!.sentAt).toBeDefined();
			expect(campaign!.statsSent).toBe(0);
			expect(campaign!.statsDelivered).toBe(0);
			expect(campaign!.statsOpened).toBe(0);
			expect(campaign!.statsClicked).toBe(0);
			expect(campaign!.statsBounced).toBe(0);
			expect(campaign!.statsUnsubscribed).toBe(0);
		});
	});
});

// ============ Recipient Resolution ============

describe('resolveRecipients (Audience resolution)', () => {
	it('should return only DOI-eligible contacts', async () => {
		const t = convexTest(schema, modules);
		const data = await setupSendFlowData(t);

		const recipients = await t.query(internal.campaigns.audienceResolution.resolveRecipients, {
			audience: { kind: 'topic', topicId: data.topicId },
		});

		expect(recipients).toHaveLength(2);
		const emails = recipients.map((r: { email: string }) => r.email);
		expect(emails).toContain('alice@example.com');
		expect(emails).toContain('bob@example.com');
		// charlie with doiStatus 'pending' should be excluded
		expect(emails).not.toContain('charlie@example.com');
	});

	it('should exclude blocked emails', async () => {
		const t = convexTest(schema, modules);
		const data = await setupSendFlowData(t);

		// Block alice
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'blockedEmails',
				createTestBlockedEmail({ email: 'alice@example.com' })
			);
		});

		const recipients = await t.query(internal.campaigns.audienceResolution.resolveRecipients, {
			audience: { kind: 'topic', topicId: data.topicId },
		});

		expect(recipients).toHaveLength(1);
		expect(recipients[0]!.email).toBe('bob@example.com');
	});

	it('should return empty for topic with no members', async () => {
		const t = convexTest(schema, modules);
		let emptyTopicId: Id<'topics'>;

		await t.run(async (ctx) => {
			emptyTopicId = await ctx.db.insert(
				'topics',
				createTestTopic()
			);
		});

		const recipients = await t.query(internal.campaigns.audienceResolution.resolveRecipients, {
			audience: { kind: 'topic', topicId: emptyTopicId! },
		});

		expect(recipients).toHaveLength(0);
	});
});

// ============ freezeCampaignAudience (send-time snapshot) ============

describe('freezeCampaignAudience (ADR-0033 segment snapshot)', () => {
	const segmentFilters = (value: string) => ({
		logic: 'AND' as const,
		conditions: [
			{
				kind: 'contact_property' as const,
				field: 'email',
				operator: 'contains' as const,
				value,
			},
		],
	});

	it('snapshots the live segment filters and survives a later segment edit', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		let segmentId: Id<'segments'>;

		await t.run(async (ctx) => {
			await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'a@frozen.com', doiStatus: 'not_required' })
			);
			segmentId = await ctx.db.insert(
				'segments',
				createTestSegment({ filters: segmentFilters('@frozen.com') })
			);
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'sending', audience: { kind: 'segment', segmentId } })
			);
		});

		const frozen = await t.mutation(internal.campaigns.sendQueries.freezeCampaignAudience, {
			campaignId: campaignId!,
		});

		// The returned audience carries the snapshot, and it is persisted.
		expect(frozen).toEqual({
			kind: 'segment',
			segmentId: segmentId!,
			frozenFilters: segmentFilters('@frozen.com'),
		});
		await t.run(async (ctx) => {
			const campaign = await readCampaignWithStats(ctx, campaignId!);
			expect(campaign?.audience).toEqual(frozen);
		});

		// Edit the live segment to target a different population.
		await t.run(async (ctx) => {
			await ctx.db.patch(segmentId!, { filters: segmentFilters('@other.com') });
		});

		// Resolution against the stored (frozen) audience ignores the edit.
		const recipients = await t.query(
			internal.campaigns.audienceResolution.resolveRecipients,
			{ audience: frozen! }
		);
		expect(recipients.map((r) => r.email)).toEqual(['a@frozen.com']);
	});

	it('is idempotent — re-freezing keeps the original snapshot', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		let segmentId: Id<'segments'>;

		await t.run(async (ctx) => {
			segmentId = await ctx.db.insert(
				'segments',
				createTestSegment({ filters: segmentFilters('@frozen.com') })
			);
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'sending', audience: { kind: 'segment', segmentId } })
			);
		});

		await t.mutation(internal.campaigns.sendQueries.freezeCampaignAudience, { campaignId: campaignId! });
		await t.run(async (ctx) => {
			await ctx.db.patch(segmentId!, { filters: segmentFilters('@other.com') });
		});
		const second = await t.mutation(internal.campaigns.sendQueries.freezeCampaignAudience, {
			campaignId: campaignId!,
		});

		// Still the first snapshot, not the edited live filters.
		expect(second).toEqual({
			kind: 'segment',
			segmentId: segmentId!,
			frozenFilters: segmentFilters('@frozen.com'),
		});
	});

	it('passes a topic audience through unchanged', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		let topicId: Id<'topics'>;

		await t.run(async (ctx) => {
			topicId = await ctx.db.insert('topics', createTestTopic());
			campaignId = await ctx.db.insert(
				'campaigns',
				createTestCampaign({ status: 'sending', audience: { kind: 'topic', topicId } })
			);
		});

		const result = await t.mutation(internal.campaigns.sendQueries.freezeCampaignAudience, {
			campaignId: campaignId!,
		});
		expect(result).toEqual({ kind: 'topic', topicId: topicId! });
	});
});

// ============ emailSends.createBatch ============

describe('emailSends.createBatch', () => {
	it('should create records with correct denormalized data', async () => {
		const t = convexTest(schema, modules);
		const data = await setupSendFlowData(t);

		const created = await t.mutation(internal.delivery.sends.createBatch, {
			sends: [
				{
					campaignId: data.campaignId,
					contactId: data.aliceId,
					contactEmail: 'alice@example.com',
					contactFirstName: 'Alice',
					contactLastName: 'Smith',
					personalizedSubject: 'Welcome Alice',
				},
				{
					campaignId: data.campaignId,
					contactId: data.bobId,
					contactEmail: 'bob@example.com',
					contactFirstName: 'Bob',
					contactLastName: 'Jones',
					personalizedSubject: 'Welcome Bob',
				},
			],
		});

		expect(created).toHaveLength(2);

		await t.run(async (ctx) => {
			const send1 = await ctx.db.get(created[0]!.emailSendId);
			expect(send1).toBeDefined();
			expect(send1!.status).toBe('queued');
			expect(send1!.contactEmail).toBe('alice@example.com');
			expect(send1!.contactFirstName).toBe('Alice');
			expect(send1!.queuedAt).toBeDefined();

			const send2 = await ctx.db.get(created[1]!.emailSendId);
			expect(send2).toBeDefined();
			expect(send2!.contactEmail).toBe('bob@example.com');
			expect(send2!.contactFirstName).toBe('Bob');
		});
	});

	it('should look up contact info when not provided', async () => {
		const t = convexTest(schema, modules);
		const data = await setupSendFlowData(t);

		const created = await t.mutation(internal.delivery.sends.createBatch, {
			sends: [
				{
					campaignId: data.campaignId,
					contactId: data.aliceId,
					// No contactEmail/contactFirstName/contactLastName provided
				},
			],
		});

		expect(created).toHaveLength(1);

		await t.run(async (ctx) => {
			const send = await ctx.db.get(created[0]!.emailSendId);
			expect(send).toBeDefined();
			expect(send!.contactEmail).toBe('alice@example.com');
			expect(send!.contactFirstName).toBe('Alice');
		});
	});
});

// ============ Send completion module ============

describe('sendCompletion.completeSend', () => {
	it('should mark emailSend as sent on success', async () => {
		const t = convexTest(schema, modules);
		const data = await setupSendFlowData(t);

		let emailSendId: Id<'emailSends'>;
		await t.run(async (ctx) => {
			emailSendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId: data.campaignId,
					contactId: data.aliceId,
					contactEmail: 'alice@example.com',
					contactFirstName: 'Alice',
					status: 'queued',
					providerMessageId: undefined,
				})
			);
		});

		await t.mutation(internal.delivery.sendCompletion.completeSend, {
			workId: testWorkId,
			result: { kind: 'success', returnValue: { success: true, providerMessageId: 'msg-123' } },
			context: {
				sendRef: { kind: 'campaign' as const, id: emailSendId! },
			},
		});

		// Let internal mutations (sendLifecycle transition + effects, billing) finish
		await t.finishInProgressScheduledFunctions();

		await t.run(async (ctx) => {
			const send = await ctx.db.get(emailSendId!);
			expect(send!.status).toBe('sent');
			expect(send!.providerMessageId).toBe('msg-123');
			expect(send!.sentAt).toBeDefined();
		});
	});

	it('should mark emailSend as failed on error', async () => {
		const t = convexTest(schema, modules);
		const data = await setupSendFlowData(t);

		let emailSendId: Id<'emailSends'>;
		await t.run(async (ctx) => {
			emailSendId = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId: data.campaignId,
					contactId: data.bobId,
					contactEmail: 'bob@example.com',
					contactFirstName: 'Bob',
					status: 'queued',
					providerMessageId: undefined,
				})
			);
		});

		await t.mutation(internal.delivery.sendCompletion.completeSend, {
			workId: testWorkId,
			result: { kind: 'failed', error: 'Provider timeout' },
			context: {
				sendRef: { kind: 'campaign' as const, id: emailSendId! },
			},
		});

		await t.finishInProgressScheduledFunctions();

		await t.run(async (ctx) => {
			const send = await ctx.db.get(emailSendId!);
			expect(send!.errorMessage).toBe('Provider timeout');
			expect(send!.errorCode).toBe('WORKPOOL_FAILED');
		});
	});

	it('should update campaign stats on completion', async () => {
		const t = convexTest(schema, modules);
		const data = await setupSendFlowData(t);

		// Create two email sends
		let sendId1: Id<'emailSends'>;
		let sendId2: Id<'emailSends'>;
		await t.run(async (ctx) => {
			sendId1 = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId: data.campaignId,
					contactId: data.aliceId,
					contactEmail: 'alice@example.com',
					status: 'queued',
					providerMessageId: undefined,
				})
			);
			sendId2 = await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId: data.campaignId,
					contactId: data.bobId,
					contactEmail: 'bob@example.com',
					status: 'queued',
					providerMessageId: undefined,
				})
			);
		});

		// Success for first
		await t.mutation(internal.delivery.sendCompletion.completeSend, {
			workId: testWorkId,
			result: { kind: 'success', returnValue: { success: true, providerMessageId: 'msg-1' } },
			context: { sendRef: { kind: 'campaign' as const, id: sendId1! } },
		});
		await t.finishInProgressScheduledFunctions();

		// Failure for second
		await t.mutation(internal.delivery.sendCompletion.completeSend, {
			workId: testWorkId,
			result: { kind: 'failed', error: 'Bounced' },
			context: { sendRef: { kind: 'campaign' as const, id: sendId2! } },
		});
		await t.finishInProgressScheduledFunctions();

		await t.run(async (ctx) => {
			const campaign = await readCampaignWithStats(ctx, data.campaignId);
			// sendLifecycle's `campaign_stats_sent` effect bumps statsSent by 1 for success
			expect(campaign!.statsSent).toBe(1);
		});
	});
});

// ============ Full Lifecycle Chain ============

describe('full campaign send lifecycle', () => {
	it('should chain sendNow → recipients → createBatch → completeSend → lifecycle.transition(sent)', async () => {
		const t = convexTest(schema, modules);
		const data = await setupSendFlowData(t);

		// Step 1: sendNow — transitions to 'sending'
		await t.mutation(api.campaigns.campaigns.sendNow, { campaignId: data.campaignId });
		// Do NOT finish scheduled functions (would try to call email provider)

		await t.run(async (ctx) => {
			const campaign = await readCampaignWithStats(ctx, data.campaignId);
			expect(campaign!.status).toBe('sending');
		});

		// Step 2: resolveRecipients — should return 2 (charlie filtered out)
		const recipients = await t.query(internal.campaigns.audienceResolution.resolveRecipients, {
			audience: { kind: 'topic', topicId: data.topicId },
		});

		expect(recipients).toHaveLength(2);

		// Step 3: createBatch — create emailSend records
		const created = await t.mutation(internal.delivery.sends.createBatch, {
			sends: recipients.map((r: { _id: Id<'contacts'>; email: string; firstName?: string; lastName?: string }) => ({
				campaignId: data.campaignId,
				contactId: r._id,
				contactEmail: r.email,
				contactFirstName: r.firstName,
				contactLastName: r.lastName,
			})),
		});

		expect(created).toHaveLength(2);
		const sendIds = created.map((c) => c.emailSendId);

		await t.run(async (ctx) => {
			for (const id of sendIds) {
				const send = await ctx.db.get(id);
				expect(send!.status).toBe('queued');
			}
		});

		// Step 4: completeSend — success for first, failure for second
		await t.mutation(internal.delivery.sendCompletion.completeSend, {
			workId: testWorkId,
			result: { kind: 'success', returnValue: { success: true, providerMessageId: 'msg-abc' } },
			context: { sendRef: { kind: 'campaign' as const, id: sendIds[0]! } },
		});
		await t.finishInProgressScheduledFunctions();

		await t.mutation(internal.delivery.sendCompletion.completeSend, {
			workId: testWorkId,
			result: { kind: 'failed', error: 'Mailbox full' },
			context: { sendRef: { kind: 'campaign' as const, id: sendIds[1]! } },
		});
		await t.finishInProgressScheduledFunctions();

		// Step 5: Verify emailSend states
		await t.run(async (ctx) => {
			const send1 = await ctx.db.get(sendIds[0]!);
			expect(send1!.status).toBe('sent');
			expect(send1!.providerMessageId).toBe('msg-abc');

			const send2 = await ctx.db.get(sendIds[1]!);
			expect(send2!.errorMessage).toBe('Mailbox full');
			expect(send2!.errorCode).toBe('WORKPOOL_FAILED');
		});

		// Step 6: Verify campaign stats
		await t.run(async (ctx) => {
			const campaign = await readCampaignWithStats(ctx, data.campaignId);
			expect(campaign!.statsSent).toBe(1);
		});

		// Step 7: lifecycle.transition({ to: 'sent' }) — terminal transition.
		// Pre-ADR-0017 this was emailsQueries.markCampaignSent; under the
		// Campaign lifecycle module, the orchestrator calls the lifecycle.
		await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: data.campaignId,
			input: { to: 'sent', at: Date.now() },
			userId: 'system:orchestrator',
		});

		await t.run(async (ctx) => {
			const campaign = await readCampaignWithStats(ctx, data.campaignId);
			expect(campaign!.status).toBe('sent');
		});
	});
});
