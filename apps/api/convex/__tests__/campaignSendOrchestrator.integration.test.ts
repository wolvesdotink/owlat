/**
 * End-to-end integration tests for the Campaign send orchestrator
 * (module). Exercises the orchestrator action `startCampaignSend`
 * directly via `t.action()` to verify the variant fanout behavior
 * against a real DB.
 *
 * The orchestrator lives in a `'use node'` file. Some downstream calls
 * (workpool enqueue, provider routing) require infrastructure that
 * isn't bootstrapped in convex-test, so these tests focus on the
 * orchestrator's *DB-visible* effects: emailSends row creation, abVariant
 * tagging, cohort/remainder split. The schedule-only side effects
 * (enqueueCampaignEmails mutations) are tolerated as best-effort.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import {
	createTestCampaign,
	createTestContact,
	createTestEmailTemplate,
	createTestTopic,
	createTestDomain,
	createTestBlockedEmail,
} from './factories';
import type { Id } from '../_generated/dataModel';
import {
	hashFraction,
	testFractionForSplit,
	variantForHash,
} from '../campaigns/sendVariantSplit';

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

const allModules = import.meta.glob('../**/*.*s');
// Exclude the same `'use node'` files sendFlow excludes for provider/workpool
// deps; KEEP emails.ts because that's what we want to invoke.
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('posthog') &&
			!path.includes('delivery/worker.ts') &&
			!path.includes('campaigns/testSend') &&
			!path.includes('delivery/workpool'),
	),
);

const suppressedErrors: Error[] = [];
const unhandledRejectionHandler = (err: Error) => {
	if (
		err.message.includes('Could not find module') ||
		err.message.includes('Write outside of transaction') ||
		err.message.includes('Transaction not started')
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

// ─── Setup ──────────────────────────────────────────────────────────────

interface ABFlowData {
	campaignId: Id<'campaigns'>;
	contactIds: Id<'contacts'>[];
}

async function setupAbFlow(
	t: TestConvex<typeof schema>,
	opts: {
		recipientCount: number;
		splitPercentage: number;
		testType?: 'subject' | 'content';
		isABTest?: boolean;
		abTestStatus?: 'pending' | 'testing' | 'winner_selected';
	},
): Promise<ABFlowData> {
	const data: Partial<ABFlowData> & { contactIds: Id<'contacts'>[] } = {
		contactIds: [],
	};

	await t.run(async (ctx) => {
		await ctx.db.insert(
			'domains',
			createTestDomain({
				domain: 'example.com',
				status: 'verified',
				lastVerifiedAt: Date.now(),
			}),
		);

		const templateA = await ctx.db.insert(
			'emailTemplates',
			createTestEmailTemplate({
				status: 'published',
				subject: 'Variant A subject {{firstName}}',
				htmlContent: '<p>Variant A body for {{firstName}}</p>',
				defaultLanguage: 'en',
			}),
		);
		const templateB = await ctx.db.insert(
			'emailTemplates',
			createTestEmailTemplate({
				status: 'published',
				subject: 'Variant B subject {{firstName}}',
				htmlContent: '<p>Variant B body for {{firstName}}</p>',
				defaultLanguage: 'en',
			}),
		);

		const topicId = await ctx.db.insert(
			'topics',
			createTestTopic({ requireDoubleOptIn: false }),
		);

		for (let i = 0; i < opts.recipientCount; i++) {
			const cid = await ctx.db.insert(
				'contacts',
				createTestContact({
					email: `r${i}@example.com`,
					firstName: `First${i}`,
					lastName: `Last${i}`,
					doiStatus: 'not_required',
				}),
			);
			data.contactIds.push(cid);
			await ctx.db.insert('contactTopics', {
				contactId: cid,
				topicId,
				addedAt: Date.now(),
			});
		}

		const abTestConfig =
			opts.isABTest === false
				? undefined
				: opts.testType === 'content'
					? {
							testType: 'content' as const,
							splitPercentage: opts.splitPercentage,
							variantBTemplateId: templateB,
							winnerCriteria: 'manual' as const,
						}
					: {
							testType: 'subject' as const,
							splitPercentage: opts.splitPercentage,
							variantBSubject: 'Variant B alt subject {{firstName}}',
							winnerCriteria: 'manual' as const,
						};

		data.campaignId = await ctx.db.insert(
			'campaigns',
			createTestCampaign({
				status: 'sending',
				sentAt: Date.now(),
				emailTemplateId: templateA,
				fromEmail: 'sender@example.com',
				fromName: 'Test Sender',
				audience: { kind: 'topic', topicId },
				// Clear faker-randomized subject so the orchestrator uses
				// the template's subject (campaignSubjectOverride logic).
				subject: undefined,
				isABTest: opts.isABTest ?? true,
				abTestConfig,
				abTestStatus: opts.isABTest === false ? undefined : (opts.abTestStatus ?? 'testing'),
			}),
		);
	});

	return data as ABFlowData;
}

// Drain the walker by driving its hops manually until the checkpoint flips to
// `done`. The walker self-reschedules via `ctx.scheduler.runAfter`, but
// convex-test doesn't auto-run scheduled functions; calling `resolveCampaignPage`
// directly is the same per-page work, and `createBatch`'s idempotency guard
// makes any overlap with a self-scheduled hop a zero-row no-op.
async function drainWalker(t: TestConvex<typeof schema>, campaignId: Id<'campaigns'>) {
	for (let i = 0; i < 100; i++) {
		const result = await t.action(internal.campaigns.send.resolveCampaignPage, { campaignId });
		if (result.done) return;
	}
	throw new Error('drainWalker did not finish within 100 hops');
}

// Compute the EXPECTED phase-1 variant for one contact from the same
// deterministic hash the walker uses — so the tests can assert the exact set
// of cohort members rather than only a statistical fraction.
function expectedPhase1Variant(
	campaignId: Id<'campaigns'>,
	contactId: Id<'contacts'>,
	splitPercentage: number,
): 'A' | 'B' | null {
	const tf = testFractionForSplit(splitPercentage);
	return variantForHash(hashFraction(String(campaignId), String(contactId)), tf);
}

function isExpectedRemainder(
	campaignId: Id<'campaigns'>,
	contactId: Id<'contacts'>,
	splitPercentage: number,
): boolean {
	const tf = testFractionForSplit(splitPercentage);
	return hashFraction(String(campaignId), String(contactId)) >= tf;
}

async function getSends(t: TestConvex<typeof schema>, campaignId: Id<'campaigns'>) {
	return await t.run(async (ctx) =>
		ctx.db
			.query('emailSends')
			.withIndex('by_campaign', (q) => q.eq('campaignId', campaignId))
			.collect(),
	);
}

// ─── First-phase A/B fanout (hash-bucketed streaming walker) ─────────────

describe('Campaign send orchestrator — first-phase A/B variant fanout (hash-bucketed)', () => {
	it('non-AB campaign creates emailSends without abVariant tag (regression guard)', async () => {
		const t = convexTest(schema, modules);
		const data = await setupAbFlow(t, {
			recipientCount: 5,
			splitPercentage: 20,
			isABTest: false,
		});

		await t.action(internal.campaigns.send.startCampaignSend, { campaignId: data.campaignId });
		await drainWalker(t, data.campaignId);

		const sends = await getSends(t, data.campaignId);
		expect(sends).toHaveLength(5);
		for (const send of sends) expect(send.abVariant).toBeUndefined();

		const job = await getJob(t, data.campaignId);
		expect(job?.phase).toBe('done');
		expect(job?.variantMode).toBe('plain');
		expect(job?.enqueuedCount).toBe(5);
	});

	it('streams ONLY the test cohort, variant-assigned by hash, on a large multi-page audience', async () => {
		const t = convexTest(schema, modules);
		const N = 1200; // > 2 pages of 500
		const splitPercentage = 20; // testFraction 0.4
		const data = await setupAbFlow(t, {
			recipientCount: N,
			splitPercentage,
			testType: 'subject',
			abTestStatus: 'testing',
		});

		await t.action(internal.campaigns.send.startCampaignSend, { campaignId: data.campaignId });
		await drainWalker(t, data.campaignId);

		const sends = await getSends(t, data.campaignId);

		// EXACT membership: each enqueued send matches the hash-derived variant,
		// and every cohort member (and only cohort members) was enqueued.
		const expectedA = data.contactIds.filter(
			(c) => expectedPhase1Variant(data.campaignId, c, splitPercentage) === 'A',
		);
		const expectedB = data.contactIds.filter(
			(c) => expectedPhase1Variant(data.campaignId, c, splitPercentage) === 'B',
		);
		const expectedCohort = expectedA.length + expectedB.length;

		expect(sends).toHaveLength(expectedCohort);
		expect(sends.filter((s) => s.abVariant === 'A')).toHaveLength(expectedA.length);
		expect(sends.filter((s) => s.abVariant === 'B')).toHaveLength(expectedB.length);

		const sentIds = new Set(sends.map((s) => String(s.contactId)));
		for (const c of expectedA) expect(sentIds.has(String(c))).toBe(true);
		for (const c of expectedB) expect(sentIds.has(String(c))).toBe(true);
		// No remainder member was sent in phase 1.
		for (const c of data.contactIds) {
			if (isExpectedRemainder(data.campaignId, c, splitPercentage)) {
				expect(sentIds.has(String(c))).toBe(false);
			}
		}

		// Cohort fraction ≈ testFraction (0.4) and A/B balance ≈ 50/50 — tolerant.
		expect(Math.abs(expectedCohort / N - 0.4)).toBeLessThan(0.05);
		expect(Math.abs(expectedA.length / expectedCohort - 0.5)).toBeLessThan(0.08);

		// Variant content tags are correct.
		for (const s of sends.filter((x) => x.abVariant === 'A')) {
			expect(s.personalizedSubject).toMatch(/Variant A subject First\d+/);
		}
		for (const s of sends.filter((x) => x.abVariant === 'B')) {
			expect(s.personalizedSubject).toMatch(/Variant B alt subject First\d+/);
		}

		const job = await getJob(t, data.campaignId);
		expect(job?.phase).toBe('done');
		expect(job?.variantMode).toBe('ab_test');
	});

	it('content-test campaign uses variantBTemplateId content for variant B', async () => {
		const t = convexTest(schema, modules);
		const splitPercentage = 30;
		const data = await setupAbFlow(t, {
			recipientCount: 400,
			splitPercentage,
			testType: 'content',
			abTestStatus: 'testing',
		});

		await t.action(internal.campaigns.send.startCampaignSend, { campaignId: data.campaignId });
		await drainWalker(t, data.campaignId);

		const sends = await getSends(t, data.campaignId);
		const variantB = sends.filter((s) => s.abVariant === 'B');
		expect(variantB.length).toBeGreaterThan(0);
		// Variant B's personalizedSubject comes from variantBTemplate's own
		// subject ("Variant B subject {{firstName}}"), not abTestConfig.variantBSubject.
		for (const send of variantB) {
			expect(send.personalizedSubject).toMatch(/Variant B subject First\d+/);
		}
	});

	it('is deterministic — same campaign+contact lands in the same bucket across runs', async () => {
		const splitPercentage = 20;
		const run = async () => {
			const t = convexTest(schema, modules);
			const data = await setupAbFlow(t, {
				recipientCount: 300,
				splitPercentage,
				testType: 'subject',
				abTestStatus: 'testing',
			});
			await t.action(internal.campaigns.send.startCampaignSend, { campaignId: data.campaignId });
			await drainWalker(t, data.campaignId);
			const sends = await getSends(t, data.campaignId);
			return { campaignId: data.campaignId, sends };
		};

		const r1 = await run();
		// The per-contact assignment is a pure function of (campaignId, contactId),
		// so recomputing it must agree with what the walker enqueued.
		for (const s of r1.sends) {
			const expected = expectedPhase1Variant(r1.campaignId, s.contactId, splitPercentage);
			expect(s.abVariant).toBe(expected);
		}
	});

	it('multi-page resume: re-running a committed page adds zero duplicate cohort rows', async () => {
		const t = convexTest(schema, modules);
		const data = await setupAbFlow(t, {
			recipientCount: 700, // 2 pages
			splitPercentage: 30,
			testType: 'subject',
			abTestStatus: 'testing',
		});

		await t.action(internal.campaigns.send.startCampaignSend, { campaignId: data.campaignId });
		// Hop 1 only (page 1's cohort).
		await t.action(internal.campaigns.send.resolveCampaignPage, { campaignId: data.campaignId });
		const afterPage1 = (await getSends(t, data.campaignId)).length;
		expect(afterPage1).toBeGreaterThan(0);

		// Simulate a crash that committed sends but rewound the cursor.
		await t.run(async (ctx) => {
			const job = await ctx.db
				.query('campaignSendJobs')
				.withIndex('by_campaign', (q) => q.eq('campaignId', data.campaignId))
				.first();
			await ctx.db.patch(job!._id, { cursor: '', enqueuedCount: 0 });
		});

		// Re-run page 1 — createBatch's idempotency guard writes zero new rows.
		await t.action(internal.campaigns.send.resolveCampaignPage, { campaignId: data.campaignId });
		expect((await getSends(t, data.campaignId)).length).toBe(afterPage1);

		// Drain the rest; every cohort member ends up with exactly one row.
		await drainWalker(t, data.campaignId);
		const sends = await getSends(t, data.campaignId);
		expect(new Set(sends.map((s) => String(s.contactId))).size).toBe(sends.length);
	});

	it('abTestStatus=pending does not fan out (cross-machine effect not yet fired)', async () => {
		const t = convexTest(schema, modules);
		const data = await setupAbFlow(t, {
			recipientCount: 10,
			splitPercentage: 20,
			testType: 'subject',
			abTestStatus: 'pending',
		});

		// abTestStatus 'pending' ⇒ resolveAbFanout is null ⇒ this goes through
		// the PLAIN walker (sent uniformly, no variant tag).
		await t.action(internal.campaigns.send.startCampaignSend, { campaignId: data.campaignId });
		await drainWalker(t, data.campaignId);

		const sends = await getSends(t, data.campaignId);
		expect(sends).toHaveLength(10);
		for (const send of sends) expect(send.abVariant).toBeUndefined();
		const job = await getJob(t, data.campaignId);
		expect(job?.variantMode).toBe('plain');
	});
});

// ─── Second-phase remainder send (winner streams through the walker) ─────

describe('Campaign send orchestrator — sendCampaignWinnerToRemainder', () => {
	it('phase 2 enqueues EXACTLY the remainder with the winning variant; disjoint from phase 1', async () => {
		const t = convexTest(schema, modules);
		const N = 800;
		const splitPercentage = 20;
		const data = await setupAbFlow(t, {
			recipientCount: N,
			splitPercentage,
			testType: 'subject',
			abTestStatus: 'testing',
		});

		// Phase 1: stream the test cohort.
		await t.action(internal.campaigns.send.startCampaignSend, { campaignId: data.campaignId });
		await drainWalker(t, data.campaignId);
		const phase1Ids = new Set(
			(await getSends(t, data.campaignId)).map((s) => String(s.contactId)),
		);

		// Operator declares winner B.
		await t.run(async (ctx) => {
			await ctx.db.patch(data.campaignId, {
				abTestStatus: 'winner_selected',
				abWinner: 'B',
				abWinnerSelectedAt: Date.now(),
			});
		});

		// Phase 2: resets the job to ab_winner + streams the remainder.
		const result = await t.action(internal.campaigns.send.sendCampaignWinnerToRemainder, {
			campaignId: data.campaignId,
		});
		expect(result.scheduled).toBe(true);
		await drainWalker(t, data.campaignId);

		const sends = await getSends(t, data.campaignId);

		// Cohort ∪ remainder = the eligible set; cohort ∩ remainder = ∅.
		const allIds = sends.map((s) => String(s.contactId));
		expect(new Set(allIds).size).toBe(allIds.length); // no dup across phases
		expect(sends).toHaveLength(N);

		const expectedRemainder = data.contactIds.filter((c) =>
			isExpectedRemainder(data.campaignId, c, splitPercentage),
		);
		// Phase-2 rows are exactly the remainder, carrying winner B.
		const winnerSends = sends.filter((s) => !phase1Ids.has(String(s.contactId)));
		expect(winnerSends).toHaveLength(expectedRemainder.length);
		for (const s of winnerSends) {
			expect(s.abVariant).toBe('B');
			expect(s.personalizedSubject).toMatch(/Variant B alt subject First\d+/);
			expect(isExpectedRemainder(data.campaignId, s.contactId, splitPercentage)).toBe(true);
		}
	});

	it('idempotent — re-running phase 2 adds zero new rows', async () => {
		const t = convexTest(schema, modules);
		const data = await setupAbFlow(t, {
			recipientCount: 300,
			splitPercentage: 20,
			testType: 'subject',
			abTestStatus: 'testing',
		});

		await t.action(internal.campaigns.send.startCampaignSend, { campaignId: data.campaignId });
		await drainWalker(t, data.campaignId);

		await t.run(async (ctx) => {
			await ctx.db.patch(data.campaignId, {
				abTestStatus: 'winner_selected',
				abWinner: 'A',
				abWinnerSelectedAt: Date.now(),
			});
		});

		await t.action(internal.campaigns.send.sendCampaignWinnerToRemainder, { campaignId: data.campaignId });
		await drainWalker(t, data.campaignId);
		const afterFirst = (await getSends(t, data.campaignId)).length;
		expect(afterFirst).toBe(300); // whole audience now sent across both phases

		// Re-invoke phase 2 — createBatch guard makes it a no-op.
		await t.action(internal.campaigns.send.sendCampaignWinnerToRemainder, { campaignId: data.campaignId });
		await drainWalker(t, data.campaignId);
		expect((await getSends(t, data.campaignId)).length).toBe(afterFirst);

		const sends = await getSends(t, data.campaignId);
		expect(new Set(sends.map((s) => String(s.contactId))).size).toBe(sends.length);
	});

	it('refuses to run when winner has not been declared (non-AB or pending)', async () => {
		const t = convexTest(schema, modules);
		const data = await setupAbFlow(t, {
			recipientCount: 10,
			splitPercentage: 20,
			testType: 'subject',
			isABTest: false,
		});

		const result = await t.action(internal.campaigns.send.sendCampaignWinnerToRemainder, {
			campaignId: data.campaignId,
		});

		expect(result.skipped).toBe(true);
		expect(result.scheduled).toBe(false);
		expect(result.reason).toMatch(/not an A\/B test|winner not declared/);

		const sends = await getSends(t, data.campaignId);
		expect(sends).toHaveLength(0);
	});
});

// ─── Checkpointed send walker (NON-A/B) ────────────────────────────────
//
// These exercise emails.resolveCampaignPage — the cursor-walked, idempotent,
// self-rescheduling page worker — and the campaignSendJobs checkpoint + the
// lifecycle completion guard that holds the campaign in `sending` until the
// walk is `done`.

interface WalkerSetup {
	campaignId: Id<'campaigns'>;
	topicId: Id<'topics'>;
	contactIds: Id<'contacts'>[];
}

// Build a NON-A/B campaign already in `sending` with `n` eligible topic
// members. `emailMaker` lets a test customize each address (for suppression).
async function setupWalker(
	t: TestConvex<typeof schema>,
	n: number,
	emailMaker: (i: number) => string = (i) => `w${i}@example.com`,
): Promise<WalkerSetup> {
	const data: Partial<WalkerSetup> & { contactIds: Id<'contacts'>[] } = {
		contactIds: [],
	};
	await t.run(async (ctx) => {
		await ctx.db.insert(
			'domains',
			createTestDomain({ domain: 'example.com', status: 'verified', lastVerifiedAt: Date.now() }),
		);
		const template = await ctx.db.insert(
			'emailTemplates',
			createTestEmailTemplate({
				status: 'published',
				subject: 'Hello {{firstName}}',
				htmlContent: '<p>Body for {{firstName}}</p>',
				defaultLanguage: 'en',
			}),
		);
		const topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
		data.topicId = topicId;
		for (let i = 0; i < n; i++) {
			const cid = await ctx.db.insert(
				'contacts',
				createTestContact({ email: emailMaker(i), firstName: `First${i}`, doiStatus: 'not_required' }),
			);
			data.contactIds.push(cid);
			await ctx.db.insert('contactTopics', { contactId: cid, topicId, addedAt: Date.now() });
		}
		data.campaignId = await ctx.db.insert(
			'campaigns',
			createTestCampaign({
				status: 'sending',
				sentAt: Date.now(),
				emailTemplateId: template,
				fromEmail: 'sender@example.com',
				fromName: 'Test Sender',
				audience: { kind: 'topic', topicId },
				subject: undefined,
				isABTest: false,
			}),
		);
	});
	return data as WalkerSetup;
}

async function getJob(t: TestConvex<typeof schema>, campaignId: Id<'campaigns'>) {
	return await t.run(async (ctx) =>
		ctx.db
			.query('campaignSendJobs')
			.withIndex('by_campaign', (q) => q.eq('campaignId', campaignId))
			.first(),
	);
}

async function countSends(t: TestConvex<typeof schema>, campaignId: Id<'campaigns'>) {
	return await t.run(async (ctx) =>
		(
			await ctx.db
				.query('emailSends')
				.withIndex('by_campaign', (q) => q.eq('campaignId', campaignId))
				.collect()
		).length,
	);
}

describe('startCampaignSend — fire-time guard', () => {
	it('skips a still-scheduled campaign whose scheduledAt is in the future (stale reschedule hop)', async () => {
		const t = convexTest(schema, modules);
		const data = await setupWalker(t, 2);
		// Simulate reschedule-to-later: scheduledAt is in the future, but the
		// original (pre-reschedule) hop fires now and must not send early.
		await t.run(async (ctx) => {
			await ctx.db.patch(data.campaignId, {
				status: 'scheduled' as const,
				scheduledAt: Date.now() + 60 * 60 * 1000,
			});
		});

		const result = await t.action(internal.campaigns.send.startCampaignSend, {
			campaignId: data.campaignId,
		});

		expect(result.skipped).toBe(true);
		expect(result.reason).toMatch(/not yet due/i);
		expect(await countSends(t, data.campaignId)).toBe(0);
		const campaign = await t.run(async (ctx) => ctx.db.get(data.campaignId));
		expect(campaign?.status).toBe('scheduled'); // not transitioned to sending
	});
});

describe('Campaign send walker — multi-page resume', () => {
	it('walks > PAGE_SIZE across pages: cursor advances, enqueuedCount grows, one row per eligible', async () => {
		const t = convexTest(schema, modules);
		const N = 1100; // > 2 pages of 500
		const data = await setupWalker(t, N);

		// PREP: open the checkpoint + schedule the first hop.
		await t.action(internal.campaigns.send.startCampaignSend, { campaignId: data.campaignId });

		// One row created so far? No — startCampaignSend only scheduled the hop.
		expect(await countSends(t, data.campaignId)).toBe(0);
		const job0 = await getJob(t, data.campaignId);
		expect(job0?.phase).toBe('resolving');
		expect(job0?.cursor).toBe('');

		// Hop 1.
		await t.action(internal.campaigns.send.resolveCampaignPage, { campaignId: data.campaignId });
		const job1 = await getJob(t, data.campaignId);
		expect(job1?.phase).toBe('resolving');
		expect(job1?.cursor).not.toBe(''); // advanced
		expect(job1?.enqueuedCount).toBe(500);
		expect(await countSends(t, data.campaignId)).toBe(500);

		// Hop 2.
		await t.action(internal.campaigns.send.resolveCampaignPage, { campaignId: data.campaignId });
		const job2 = await getJob(t, data.campaignId);
		expect(job2?.enqueuedCount).toBe(1000);
		expect(await countSends(t, data.campaignId)).toBe(1000);

		// Hop 3 — last page (100), flips to done.
		await t.action(internal.campaigns.send.resolveCampaignPage, { campaignId: data.campaignId });
		const job3 = await getJob(t, data.campaignId);
		expect(job3?.phase).toBe('done');
		expect(job3?.enqueuedCount).toBe(N);
		expect(await countSends(t, data.campaignId)).toBe(N);

		// Exactly one emailSends row per contact — no dup, no drop.
		await t.run(async (ctx) => {
			const sends = await ctx.db
				.query('emailSends')
				.withIndex('by_campaign', (q) => q.eq('campaignId', data.campaignId))
				.collect();
			expect(new Set(sends.map((s) => String(s.contactId))).size).toBe(N);
		});
	});
});

describe('Campaign send walker — idempotent enqueue (exactly-once)', () => {
	it('re-running a committed page from a reset cursor adds zero new rows', async () => {
		const t = convexTest(schema, modules);
		const data = await setupWalker(t, 600);
		await t.action(internal.campaigns.send.startCampaignSend, { campaignId: data.campaignId });

		// Hop 1 commits page 1 (500 rows) and advances the cursor.
		await t.action(internal.campaigns.send.resolveCampaignPage, { campaignId: data.campaignId });
		expect(await countSends(t, data.campaignId)).toBe(500);

		// Simulate a crash that committed the sends but NOT the cursor: rewind
		// the cursor to '' so the next hop re-resolves page 1.
		await t.run(async (ctx) => {
			const job = await ctx.db
				.query('campaignSendJobs')
				.withIndex('by_campaign', (q) => q.eq('campaignId', data.campaignId))
				.first();
			await ctx.db.patch(job!._id, { cursor: '', enqueuedCount: 0 });
		});

		// Re-run page 1 — createBatch's by_campaign_and_contact guard skips every
		// already-sent contact, so zero new rows are written.
		await t.action(internal.campaigns.send.resolveCampaignPage, { campaignId: data.campaignId });
		expect(await countSends(t, data.campaignId)).toBe(500);
	});

	it('double-running the SAME cursor gives one row per contact', async () => {
		const t = convexTest(schema, modules);
		const data = await setupWalker(t, 10);
		await t.action(internal.campaigns.send.startCampaignSend, { campaignId: data.campaignId });

		// First hop: whole 10-member audience fits in one page → done, 10 rows.
		await t.action(internal.campaigns.send.resolveCampaignPage, { campaignId: data.campaignId });
		expect(await countSends(t, data.campaignId)).toBe(10);

		// Force the job back to resolving at cursor '' and re-run — still 10.
		await t.run(async (ctx) => {
			const job = await ctx.db
				.query('campaignSendJobs')
				.withIndex('by_campaign', (q) => q.eq('campaignId', data.campaignId))
				.first();
			await ctx.db.patch(job!._id, { phase: 'resolving', cursor: '' });
		});
		await t.action(internal.campaigns.send.resolveCampaignPage, { campaignId: data.campaignId });
		expect(await countSends(t, data.campaignId)).toBe(10);

		await t.run(async (ctx) => {
			const sends = await ctx.db
				.query('emailSends')
				.withIndex('by_campaign', (q) => q.eq('campaignId', data.campaignId))
				.collect();
			expect(new Set(sends.map((s) => String(s.contactId))).size).toBe(10);
		});
	});
});

describe('Campaign send walker — completion guard', () => {
	it('crash mid-walk: campaign is NOT sent while resolving; finishes once done', async () => {
		const t = convexTest(schema, modules);
		const data = await setupWalker(t, 600); // 2 pages
		await t.action(internal.campaigns.send.startCampaignSend, { campaignId: data.campaignId });

		// Run ONLY page 1 (no draining of the rescheduled hop).
		await t.action(internal.campaigns.send.resolveCampaignPage, { campaignId: data.campaignId });
		expect((await getJob(t, data.campaignId))?.phase).toBe('resolving');

		// All page-1 sends reach a terminal status and the per-send reconcile
		// runs — but the guard MUST keep the campaign in `sending` because the
		// walk has not finished (page 2 not yet enqueued).
		await t.run(async (ctx) => {
			const sends = await ctx.db
				.query('emailSends')
				.withIndex('by_campaign', (q) => q.eq('campaignId', data.campaignId))
				.collect();
			for (const s of sends) await ctx.db.patch(s._id, { status: 'sent', sentAt: Date.now() });
		});
		await t.mutation(internal.campaigns.lifecycle.reconcileCampaignCompletion, {
			campaignId: data.campaignId,
		});
		await t.run(async (ctx) => {
			const c = await ctx.db.get(data.campaignId);
			expect(c?.status).toBe('sending'); // guard held it
		});

		// Finish the walk (page 2), terminalize its sends, reconcile → sent.
		await t.action(internal.campaigns.send.resolveCampaignPage, { campaignId: data.campaignId });
		expect((await getJob(t, data.campaignId))?.phase).toBe('done');
		await t.run(async (ctx) => {
			const sends = await ctx.db
				.query('emailSends')
				.withIndex('by_campaign', (q) => q.eq('campaignId', data.campaignId))
				.collect();
			for (const s of sends) await ctx.db.patch(s._id, { status: 'sent', sentAt: Date.now() });
		});
		await t.mutation(internal.campaigns.lifecycle.reconcileCampaignCompletion, {
			campaignId: data.campaignId,
		});
		await t.run(async (ctx) => {
			const c = await ctx.db.get(data.campaignId);
			expect(c?.status).toBe('sent');
		});
	});

	it('premature-completion guard: terminal page-1 sends + reconcile cron before phase=done keeps it sending', async () => {
		const t = convexTest(schema, modules);
		const data = await setupWalker(t, 600);
		await t.action(internal.campaigns.send.startCampaignSend, { campaignId: data.campaignId });
		await t.action(internal.campaigns.send.resolveCampaignPage, { campaignId: data.campaignId }); // page 1 only

		await t.run(async (ctx) => {
			const sends = await ctx.db
				.query('emailSends')
				.withIndex('by_campaign', (q) => q.eq('campaignId', data.campaignId))
				.collect();
			for (const s of sends) await ctx.db.patch(s._id, { status: 'sent', sentAt: Date.now() });
		});

		// The safety-net cron sweeps every `sending` campaign — it must respect
		// the same guard and NOT complete this one.
		const result = await t.mutation(internal.campaigns.lifecycle.reconcileSendingCampaigns, {});
		expect(result.completed).toBe(0);
		await t.run(async (ctx) => {
			const c = await ctx.db.get(data.campaignId);
			expect(c?.status).toBe('sending');
		});
	});
});

describe('Campaign send walker — empty audience', () => {
	it('an empty audience flips the campaign straight to sent with 0 enqueued', async () => {
		const t = convexTest(schema, modules);
		const data = await setupWalker(t, 0); // topic with no members
		await t.action(internal.campaigns.send.startCampaignSend, { campaignId: data.campaignId });
		await t.action(internal.campaigns.send.resolveCampaignPage, { campaignId: data.campaignId });

		const job = await getJob(t, data.campaignId);
		expect(job?.phase).toBe('done');
		expect(job?.enqueuedCount).toBe(0);
		expect(await countSends(t, data.campaignId)).toBe(0);
		await t.run(async (ctx) => {
			const c = await ctx.db.get(data.campaignId);
			expect(c?.status).toBe('sent');
		});
	});
});

describe('Campaign send walker — suppression mid-run', () => {
	it('a contact suppressed after page 1 is excluded when its page is resolved', async () => {
		const t = convexTest(schema, modules);
		// 600 members → 2 pages. Block one address that lands on page 2.
		const data = await setupWalker(t, 600);
		await t.action(internal.campaigns.send.startCampaignSend, { campaignId: data.campaignId });

		// Page 1 (first 500). Then suppress a page-2 member before page 2 runs.
		await t.action(internal.campaigns.send.resolveCampaignPage, { campaignId: data.campaignId });
		expect(await countSends(t, data.campaignId)).toBe(500);

		// Block contact index 550 (on page 2). Its email is `w550@example.com`.
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'blockedEmails',
				createTestBlockedEmail({ email: 'w550@example.com' }),
			);
		});

		// Page 2 resolves with the suppression applied → 99 of the remaining 100.
		await t.action(internal.campaigns.send.resolveCampaignPage, { campaignId: data.campaignId });
		expect((await getJob(t, data.campaignId))?.phase).toBe('done');
		expect(await countSends(t, data.campaignId)).toBe(599);

		await t.run(async (ctx) => {
			const blocked = await ctx.db
				.query('emailSends')
				.withIndex('by_campaign', (q) => q.eq('campaignId', data.campaignId))
				.collect();
			expect(blocked.map((s) => s.contactEmail)).not.toContain('w550@example.com');
		});
	});
});

// ─── Watchdog: re-drive a stranded walk ────────────────────────────────────
// resolveCampaignPage self-reschedules ONLY at the end of a successful hop, so a
// throw before that (transient runQuery/OCC error, or the fail-closed no-provider
// route check) halts the walk with the job stuck in `resolving` and every
// recipient past the last committed cursor undelivered. `redriveStuckSendJobs`
// (the `reconcile stuck campaign sends` cron) resumes such a walk from its
// checkpoint — idempotently, so no dupes and no drops.
describe('Campaign send walker — stuck-walk watchdog (redriveStuckSendJobs)', () => {
	async function makeJobStale(t: TestConvex<typeof schema>, campaignId: Id<'campaigns'>) {
		await t.run(async (ctx) => {
			const job = await ctx.db
				.query('campaignSendJobs')
				.withIndex('by_campaign', (q) => q.eq('campaignId', campaignId))
				.first();
			// 11 minutes without progress — past the 10-minute staleness threshold.
			await ctx.db.patch(job!._id, { updatedAt: Date.now() - 11 * 60 * 1000 });
		});
	}

	it('a hop that stopped mid-walk is re-driven and the remaining recipients enqueue exactly once', async () => {
		const t = convexTest(schema, modules);
		const N = 600; // 2 pages of 500
		const data = await setupWalker(t, N);

		await t.action(internal.campaigns.send.startCampaignSend, { campaignId: data.campaignId });

		// Page 1 commits 500 rows and advances the cursor. Then the hop that
		// SHOULD have run page 2 throws before rescheduling itself — simulated by
		// simply NOT draining the rescheduled hop and letting the checkpoint go
		// stale. The walk is now stranded in `resolving`.
		await t.action(internal.campaigns.send.resolveCampaignPage, { campaignId: data.campaignId });
		expect(await countSends(t, data.campaignId)).toBe(500);
		expect((await getJob(t, data.campaignId))?.phase).toBe('resolving');
		await makeJobStale(t, data.campaignId);

		// Watchdog finds exactly this one stranded walk and re-schedules a hop.
		const result = await t.mutation(internal.campaigns.sendJob.redriveStuckSendJobs, {});
		expect(result.redriven).toBe(1);

		// convex-test does not auto-run scheduled functions; drive the hop the
		// watchdog enqueued. It resumes from the committed cursor → page 2 (100).
		await t.action(internal.campaigns.send.resolveCampaignPage, { campaignId: data.campaignId });

		const job = await getJob(t, data.campaignId);
		expect(job?.phase).toBe('done');
		expect(job?.enqueuedCount).toBe(N);
		// Every recipient delivered exactly once — no drop, no dupe.
		expect(await countSends(t, data.campaignId)).toBe(N);
		await t.run(async (ctx) => {
			const sends = await ctx.db
				.query('emailSends')
				.withIndex('by_campaign', (q) => q.eq('campaignId', data.campaignId))
				.collect();
			expect(new Set(sends.map((s) => String(s.contactId))).size).toBe(N);
		});
	});

	it('does NOT re-drive a walk that is still making progress (fresh updatedAt)', async () => {
		const t = convexTest(schema, modules);
		const data = await setupWalker(t, 600);
		await t.action(internal.campaigns.send.startCampaignSend, { campaignId: data.campaignId });
		// Page 1 just ran — updatedAt is fresh, the reschedule is still in flight.
		await t.action(internal.campaigns.send.resolveCampaignPage, { campaignId: data.campaignId });

		const result = await t.mutation(internal.campaigns.sendJob.redriveStuckSendJobs, {});
		expect(result.redriven).toBe(0);
	});

	it('does NOT re-drive a completed (phase=done) walk even when stale', async () => {
		const t = convexTest(schema, modules);
		const data = await setupWalker(t, 10); // single page → done
		await t.action(internal.campaigns.send.startCampaignSend, { campaignId: data.campaignId });
		await t.action(internal.campaigns.send.resolveCampaignPage, { campaignId: data.campaignId });
		expect((await getJob(t, data.campaignId))?.phase).toBe('done');
		await makeJobStale(t, data.campaignId);

		const result = await t.mutation(internal.campaigns.sendJob.redriveStuckSendJobs, {});
		expect(result.redriven).toBe(0);
	});

	// The fail-closed no-provider defer path reschedules its OWN hop after a
	// backoff. It must also refresh `updatedAt` (via `touchSendJob`) so that
	// single self-reschedule chain owns the retry loop: otherwise the row's
	// `updatedAt` stays frozen while the provider is missing and the watchdog
	// piles a fresh redundant re-drive on top of the chain on every tick.
	it('the no-provider defer refreshes updatedAt so the watchdog does not re-drive on top of the self-reschedule chain', async () => {
		const t = convexTest(schema, modules);
		const data = await setupWalker(t, 600);
		// Prep + createSendJob happen with a provider configured (baseline env).
		await t.action(internal.campaigns.send.startCampaignSend, { campaignId: data.campaignId });

		// Age the job past the staleness threshold to prove the refresh matters:
		// if the no-provider hop did NOT touch updatedAt, the row would remain
		// stale and the watchdog below would re-drive it.
		await makeJobStale(t, data.campaignId);

		// Provider removed between schedule and this hop → resolveSendRoute → null.
		const savedProvider = process.env['EMAIL_PROVIDER'];
		delete process.env['EMAIL_PROVIDER'];
		try {
			await t.action(internal.campaigns.send.resolveCampaignPage, {
				campaignId: data.campaignId,
			});

			// Fail-closed: nothing dispatched, cursor untouched, still resolving.
			expect(await countSends(t, data.campaignId)).toBe(0);
			const job = await getJob(t, data.campaignId);
			expect(job?.phase).toBe('resolving');
			// The defer touched updatedAt back to "now" — no longer stale.
			expect(job!.updatedAt).toBeGreaterThan(Date.now() - 60 * 1000);

			// Watchdog leaves the freshly-touched row alone: the self-reschedule
			// chain owns the retry, so no redundant re-drive is stacked on it.
			const result = await t.mutation(internal.campaigns.sendJob.redriveStuckSendJobs, {});
			expect(result.redriven).toBe(0);
		} finally {
			if (savedProvider !== undefined) process.env['EMAIL_PROVIDER'] = savedProvider;
		}

		// Backstop still holds: if the self-reschedule chain truly dies (updatedAt
		// goes stale again), the watchdog re-drives exactly this one job.
		await makeJobStale(t, data.campaignId);
		const backstop = await t.mutation(internal.campaigns.sendJob.redriveStuckSendJobs, {});
		expect(backstop.redriven).toBe(1);
	});
});
