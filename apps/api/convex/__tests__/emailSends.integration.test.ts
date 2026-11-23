import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { createTestCampaign, createTestContact, createTestEmailSend } from './factories';
import type { Id } from '../_generated/dataModel';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

const modules = import.meta.glob('../**/*.*s');

// Status-write tests (markAsSent/markAsDelivered/recordOpen/recordClick/
// markAsBounced/markAsComplained/markAsFailed) moved to
// sendLifecycle.integration.test.ts when the lifecycle was consolidated.
// Tests retained here cover the create/delete/stats surface, which the
// lifecycle module does not own.

// ============ createBatch ============

describe('emailSends.createBatch', () => {
	it('should create multiple sends at once', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		let contactId1: Id<'contacts'>;
		let contactId2: Id<'contacts'>;

		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			contactId1 = await ctx.db.insert('contacts', createTestContact());
			contactId2 = await ctx.db.insert('contacts', createTestContact());
		});

		const created = await t.mutation(internal.delivery.sends.createBatch, {
			sends: [
				{
					campaignId: campaignId!,
					contactId: contactId1!,
					contactEmail: 'user1@example.com',
					contactFirstName: 'User',
					contactLastName: 'One',
					personalizedSubject: 'Hello User One',
				},
				{
					campaignId: campaignId!,
					contactId: contactId2!,
					contactEmail: 'user2@example.com',
					contactFirstName: 'User',
					contactLastName: 'Two',
				},
			],
		});

		expect(created).toHaveLength(2);

		await t.run(async (ctx) => {
			const send1 = await ctx.db.get(created[0]!.emailSendId);
			expect(send1?.status).toBe('queued');
			expect(send1?.contactEmail).toBe('user1@example.com');
			expect(send1?.personalizedSubject).toBe('Hello User One');
			expect(send1?.queuedAt).toBeTypeOf('number');

			const send2 = await ctx.db.get(created[1]!.emailSendId);
			expect(send2?.status).toBe('queued');
			expect(send2?.contactEmail).toBe('user2@example.com');
		});
	});

	it('should fetch contact info from DB when contactEmail is not provided', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			contactId = await ctx.db.insert(
				'contacts',
				createTestContact({
					email: 'db-contact@example.com',
					firstName: 'DB',
					lastName: 'Contact',
				})
			);
		});

		const created = await t.mutation(internal.delivery.sends.createBatch, {
			sends: [
				{
					campaignId: campaignId!,
					contactId: contactId!,
				},
			],
		});

		expect(created).toHaveLength(1);

		await t.run(async (ctx) => {
			const send = await ctx.db.get(created[0]!.emailSendId);
			expect(send?.contactEmail).toBe('db-contact@example.com');
			expect(send?.contactFirstName).toBe('DB');
			expect(send?.contactLastName).toBe('Contact');
		});
	});

	it('should skip deleted contacts and return fewer IDs', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		let contactId1: Id<'contacts'>;
		let deletedContactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			contactId1 = await ctx.db.insert('contacts', createTestContact());
			deletedContactId = await ctx.db.insert('contacts', createTestContact());
			await ctx.db.delete(deletedContactId);
		});

		const created = await t.mutation(internal.delivery.sends.createBatch, {
			sends: [
				{
					campaignId: campaignId!,
					contactId: contactId1!,
					contactEmail: 'existing@example.com',
				},
				{
					campaignId: campaignId!,
					contactId: deletedContactId!,
					// No contactEmail — forces DB lookup, which will find nothing
				},
			],
		});

		expect(created).toHaveLength(1);
	});

	it('should handle empty sends array', async () => {
		const t = convexTest(schema, modules);

		const created = await t.mutation(internal.delivery.sends.createBatch, {
			sends: [],
		});

		expect(created).toHaveLength(0);
	});

	it('should persist abVariant when provided (A/B test fanout)', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		let contactA: Id<'contacts'>;
		let contactB: Id<'contacts'>;
		let contactNone: Id<'contacts'>;

		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			contactA = await ctx.db.insert('contacts', createTestContact());
			contactB = await ctx.db.insert('contacts', createTestContact());
			contactNone = await ctx.db.insert('contacts', createTestContact());
		});

		const created = await t.mutation(internal.delivery.sends.createBatch, {
			sends: [
				{
					campaignId: campaignId!,
					contactId: contactA!,
					contactEmail: 'a@example.com',
					abVariant: 'A' as const,
				},
				{
					campaignId: campaignId!,
					contactId: contactB!,
					contactEmail: 'b@example.com',
					abVariant: 'B' as const,
				},
				{
					campaignId: campaignId!,
					contactId: contactNone!,
					contactEmail: 'none@example.com',
					// no abVariant — non-AB row
				},
			],
		});

		expect(created).toHaveLength(3);

		await t.run(async (ctx) => {
			const sendA = await ctx.db.get(created[0]!.emailSendId);
			expect(sendA?.abVariant).toBe('A');
			const sendB = await ctx.db.get(created[1]!.emailSendId);
			expect(sendB?.abVariant).toBe('B');
			const sendNone = await ctx.db.get(created[2]!.emailSendId);
			expect(sendNone?.abVariant).toBeUndefined();
		});
	});

	it('is idempotent — re-running the same batch inserts zero new rows', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		let contactId: Id<'contacts'>;

		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			contactId = await ctx.db.insert('contacts', createTestContact());
		});

		const sends = [
			{
				campaignId: campaignId!,
				contactId: contactId!,
				contactEmail: 'dup@example.com',
			},
		];

		const first = await t.mutation(internal.delivery.sends.createBatch, { sends });
		expect(first).toHaveLength(1);

		// Second call for the same (campaign, contact) is skipped by the
		// by_campaign_and_contact guard — exactly-once on resume.
		const second = await t.mutation(internal.delivery.sends.createBatch, { sends });
		expect(second).toHaveLength(0);

		await t.run(async (ctx) => {
			const rows = await ctx.db
				.query('emailSends')
				.withIndex('by_campaign_and_contact', (q) =>
					q.eq('campaignId', campaignId!).eq('contactId', contactId!)
				)
				.collect();
			expect(rows).toHaveLength(1);
		});
	});
});

// ============ getStatsByCampaign ============

describe('emailSends.getStatsByCampaign', () => {
	it('should compute correct stats from send records', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;

		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			const contactId = await ctx.db.insert('contacts', createTestContact());

			// 1 queued
			await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'queued',
				})
			);

			// 1 sent
			await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'sent',
					sentAt: Date.now(),
				})
			);

			// 1 delivered
			await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'delivered',
					deliveredAt: Date.now(),
				})
			);

			// 1 opened (openCount=3)
			await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'opened',
					openedAt: Date.now(),
					openCount: 3,
				})
			);

			// 1 clicked (with 2 clicked links, also opened)
			await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'clicked',
					openedAt: Date.now() - 10000,
					openCount: 1,
					clickedAt: Date.now(),
					clickedLinks: [
						{ url: 'https://a.com', clickedAt: Date.now() },
						{ url: 'https://b.com', clickedAt: Date.now() },
					],
				})
			);

			// 1 hard bounce (canonical bounceType)
			await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'bounced',
					bouncedAt: Date.now(),
					bounceType: 'hard',
				})
			);

			// 1 soft bounce
			await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'bounced',
					bouncedAt: Date.now(),
					bounceType: 'soft',
				})
			);

			// 1 complained
			await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'complained',
					complainedAt: Date.now(),
				})
			);
		});

		const stats = await t.query(api.delivery.sends.getStatsByCampaign, {
			campaignId: campaignId!,
		});

		expect(stats.total).toBe(8);
		expect(stats.queued).toBe(1);
		expect(stats.sent).toBe(1);
		// "ever delivered": the delivered + opened + clicked rows all carry a
		// delivered/opened/clicked timestamp (counting by current status alone
		// dropped recipients who progressed past delivered).
		expect(stats.delivered).toBe(3);
		// "ever opened": the opened row + the clicked row (clicked implies open)
		expect(stats.opened).toBe(2);
		expect(stats.clicked).toBe(1);
		expect(stats.bounced).toBe(2);
		expect(stats.complained).toBe(1);
		expect(stats.hardBounced).toBe(1);
		expect(stats.softBounced).toBe(1);
		// uniqueOpens: opened send + clicked send (both have openedAt)
		expect(stats.uniqueOpens).toBe(2);
		// totalOpens: 3 (from opened) + 1 (from clicked) = 4
		expect(stats.totalOpens).toBe(4);
		// uniqueClicks: clicked send has clickedAt
		expect(stats.uniqueClicks).toBe(1);
		// totalClicks: 2 clicked links
		expect(stats.totalClicks).toBe(2);
	});

	it('should classify legacy errorCode bounces when bounceType is absent', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;

		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			const contactId = await ctx.db.insert('contacts', createTestContact());

			// Legacy row: only errorCode, no bounceType (pre-sendLifecycle write)
			await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'bounced',
					bouncedAt: Date.now(),
					errorCode: 'hard_bounce',
				})
			);
		});

		const stats = await t.query(api.delivery.sends.getStatsByCampaign, {
			campaignId: campaignId!,
		});

		expect(stats.bounced).toBe(1);
		expect(stats.hardBounced).toBe(1);
		expect(stats.softBounced).toBe(0);
	});

	it('should return zero stats when no sends exist', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;

		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign());
		});

		const stats = await t.query(api.delivery.sends.getStatsByCampaign, {
			campaignId: campaignId!,
		});

		expect(stats.total).toBe(0);
		expect(stats.queued).toBe(0);
		expect(stats.sent).toBe(0);
		expect(stats.delivered).toBe(0);
		expect(stats.opened).toBe(0);
		expect(stats.clicked).toBe(0);
		expect(stats.bounced).toBe(0);
		expect(stats.complained).toBe(0);
		expect(stats.uniqueOpens).toBe(0);
		expect(stats.uniqueClicks).toBe(0);
		expect(stats.totalOpens).toBe(0);
		expect(stats.totalClicks).toBe(0);
		expect(stats.hardBounced).toBe(0);
		expect(stats.softBounced).toBe(0);
	});

	it('should count bounced send without bounceType or errorCode as soft bounce', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;

		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			const contactId = await ctx.db.insert('contacts', createTestContact());

			await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'bounced',
					bouncedAt: Date.now(),
					// no bounceType, no errorCode
				})
			);
		});

		const stats = await t.query(api.delivery.sends.getStatsByCampaign, {
			campaignId: campaignId!,
		});

		expect(stats.bounced).toBe(1);
		expect(stats.hardBounced).toBe(0);
		expect(stats.softBounced).toBe(1);
	});
});

// ============ one delivered rule across the campaign report ============

describe('campaign report delivered rule', () => {
	it('gives the click heatmap the same delivered count as the report header', async () => {
		const t = convexTest(schema, modules);
		let campaignId: Id<'campaigns'>;
		const now = Date.now();

		await t.run(async (ctx) => {
			campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			const contactId = await ctx.db.insert('contacts', createTestContact());

			// Delivered, never engaged.
			await ctx.db.insert(
				'emailSends',
				createTestEmailSend({ campaignId, contactId, status: 'delivered', deliveredAt: now })
			);

			// Delivered, opened, clicked one link.
			await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'clicked',
					deliveredAt: now,
					openedAt: now + 1_000,
					openCount: 1,
					clickedAt: now + 2_000,
					clickedLinks: [{ url: 'https://example.com/a', clickedAt: now + 2_000 }],
				})
			);

			// Opened, then bounced: current status is `bounced`, but the
			// recipient was delivered and opened. The old heatmap rule, which
			// counted by status, dropped this row from its denominator.
			await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId,
					contactId,
					status: 'bounced',
					bounceType: 'soft',
					deliveredAt: now,
					openedAt: now + 1_000,
					openCount: 1,
					bouncedAt: now + 5_000,
				})
			);

			// Never delivered.
			await ctx.db.insert(
				'emailSends',
				createTestEmailSend({ campaignId, contactId, status: 'failed' })
			);
		});

		const stats = await t.query(api.delivery.sends.getStatsByCampaign, {
			campaignId: campaignId!,
		});
		const linkStats = await t.query(api.delivery.sends.getLinkClickStats, {
			campaignId: campaignId!,
		});
		const opened = await t.query(api.delivery.sends.getOpenedContacts, {
			campaignId: campaignId!,
		});
		const clicked = await t.query(api.delivery.sends.getClickedContacts, {
			campaignId: campaignId!,
		});

		expect(stats.delivered).toBe(3);
		expect(linkStats.totalDelivered).toBe(stats.delivered);
		expect(linkStats.totalUniqueClicks).toBe(1);
		expect(stats.opened).toBe(2);
		expect(opened.total).toBe(stats.opened);
		expect(clicked.total).toBe(stats.clicked);
	});
});

// ============ failed and bounced sends ============

describe('campaign report failed and bounced sends', () => {
	async function seedUndelivered() {
		const t = convexTest(schema, modules);
		const ids = await t.run(async (ctx) => {
			const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
			const otherCampaignId = await ctx.db.insert('campaigns', createTestCampaign());
			const insert = async (overrides: Record<string, unknown>) => {
				const contactId = await ctx.db.insert('contacts', createTestContact());
				return await ctx.db.insert(
					'emailSends',
					createTestEmailSend({ campaignId, contactId, queuedAt: 1_000, ...overrides })
				);
			};
			const authOld = await insert({
				status: 'failed',
				failedAt: 2_000,
				errorCode: 'AUTH_FAILED',
				errorMessage: '535 5.7.8 Username and Password not accepted',
			});
			const authNew = await insert({
				status: 'failed',
				failedAt: 3_000,
				errorCode: 'AUTH_FAILED',
				errorMessage: '535 5.7.8 Username and Password not accepted',
			});
			const suppressed = await insert({
				status: 'failed',
				failedAt: 2_500,
				errorCode: 'RECIPIENT_SUPPRESSED',
				errorMessage: 'Recipient suppressed (blocklist) before dispatch',
			});
			const hard = await insert({
				status: 'bounced',
				sentAt: 1_500,
				bouncedAt: 4_000,
				bounceType: 'hard',
				errorMessage: '550 5.1.1 No such user',
			});
			// A bounce written before `bounceType` existed.
			const legacySoft = await insert({ status: 'bounced', bouncedAt: 5_000 });
			// Sends that arrived, and another campaign's failure, are not listed.
			await insert({ status: 'delivered', sentAt: 1_500, deliveredAt: 1_600 });
			await insert({ status: 'opened', sentAt: 1_500, openedAt: 1_700 });
			await ctx.db.insert(
				'emailSends',
				createTestEmailSend({
					campaignId: otherCampaignId,
					contactId: await ctx.db.insert('contacts', createTestContact()),
					status: 'failed',
					errorCode: 'AUTH_FAILED',
				})
			);
			return { campaignId, authOld, authNew, suppressed, hard, legacySoft };
		});
		return { t, ...ids };
	}

	it('groups the failed sends by error code and the bounces by class', async () => {
		const { t, campaignId } = await seedUndelivered();

		const summary = await t.query(api.delivery.sendFailures.getFailureSummary, { campaignId });

		expect(summary.failed).toEqual({
			total: 3,
			reasons: [
				{
					errorCode: 'AUTH_FAILED',
					count: 2,
					exampleMessage: '535 5.7.8 Username and Password not accepted',
				},
				{
					errorCode: 'RECIPIENT_SUPPRESSED',
					count: 1,
					exampleMessage: 'Recipient suppressed (blocklist) before dispatch',
				},
			],
		});
		expect(summary.bounced.total).toBe(2);
		expect(summary.bounced.reasons).toEqual(
			expect.arrayContaining([
				{ bounceType: 'hard', count: 1, exampleMessage: '550 5.1.1 No such user' },
				{ bounceType: 'soft', count: 1, exampleMessage: null },
			])
		);
	});

	it('lists one status of one campaign, newest first, a page at a time', async () => {
		const { t, campaignId, authOld, authNew, suppressed } = await seedUndelivered();

		const first = await t.query(api.delivery.sendFailures.getUndeliveredContacts, {
			campaignId,
			status: 'failed',
			limit: 2,
		});
		expect(first.total).toBe(3);
		expect(first.hasMore).toBe(true);
		expect(first.sends.map((s) => s._id)).toEqual([authNew, suppressed]);
		expect(first.sends[0]).toMatchObject({
			at: 3_000,
			errorCode: 'AUTH_FAILED',
			errorMessage: '535 5.7.8 Username and Password not accepted',
			bounceType: null,
		});

		const second = await t.query(api.delivery.sendFailures.getUndeliveredContacts, {
			campaignId,
			status: 'failed',
			limit: 2,
			offset: 2,
		});
		expect(second.sends.map((s) => s._id)).toEqual([authOld]);
		expect(second.hasMore).toBe(false);
	});

	it('lists the bounces with their class, the legacy one read as soft', async () => {
		const { t, campaignId, hard, legacySoft } = await seedUndelivered();

		const page = await t.query(api.delivery.sendFailures.getUndeliveredContacts, {
			campaignId,
			status: 'bounced',
		});

		expect(page.sends.map((s) => [s._id, s.bounceType])).toEqual([
			[legacySoft, 'soft'],
			[hard, 'hard'],
		]);
	});

	it('caps a page at the page limit whatever the caller asks for', async () => {
		const t = convexTest(schema, modules);
		const campaignId = await t.run(async (ctx) => {
			const id = await ctx.db.insert('campaigns', createTestCampaign());
			for (let i = 0; i < 60; i++) {
				await ctx.db.insert(
					'emailSends',
					createTestEmailSend({
						campaignId: id,
						contactId: await ctx.db.insert('contacts', createTestContact()),
						status: 'failed',
						errorCode: 'SERVER_ERROR',
					})
				);
			}
			return id;
		});

		const page = await t.query(api.delivery.sendFailures.getUndeliveredContacts, {
			campaignId,
			status: 'failed',
			limit: 1_000,
		});

		expect(page.total).toBe(60);
		expect(page.sends).toHaveLength(50);
		expect(page.hasMore).toBe(true);
	});
});
