/**
 * How a suspension lifts, as every reader outside the web app gets it: the
 * `sendingHold` of `GET /api/v1/status`, the `data` of the transactional
 * `403 abuse_blocked`, and the assistant's delivery-health and campaign reads.
 * All of them carry the same `lift` object, so a client or the model reads one
 * shape wherever a suspension shows up.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import { internal } from '../_generated/api';
import { createTestCampaign, createTestDomain } from './factories';

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([p]) =>
			!p.includes('sesActions') &&
			!p.includes('agentSecurity') &&
			!p.includes('agentContext') &&
			!p.includes('agentClassifier') &&
			!p.includes('agentDrafter') &&
			!p.includes('agentRouter') &&
			!p.includes('agent/walker') &&
			!p.includes('agent/steps/index') &&
			!p.includes('agent/steps/shared') &&
			!p.includes('agent/steps/classify') &&
			!p.includes('agent/steps/draft') &&
			!p.includes('knowledgeExtraction') &&
			!p.includes('files/processing') &&
			!p.includes('visualizationAgent') &&
			!p.includes('llmProvider')
	)
);

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 20, 12);
const SUSPENDED_AT = NOW - DAY_MS;
const REASON = 'Auto-suspended: complaint rate or bounce rate exceeded critical thresholds';

afterEach(() => vi.useRealTimers());

type Tester = ReturnType<typeof convexTest>;

async function hashKey(k: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(k));
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

async function seedKey(t: Tester, scopes: string[]): Promise<string> {
	const key = `lm_live_${scopes
		.join('')
		.replace(/[^a-z]/g, '')
		.padEnd(40, 'a')}`;
	const keyHash = await hashKey(key);
	await t.run(async (ctx) => {
		await ctx.db.insert('apiKeys', {
			name: 'test-key',
			keyHash,
			keyPrefix: 'lm_live_',
			isActive: true,
			scopes,
			createdAt: NOW,
			updatedAt: NOW,
		});
	});
	return key;
}

function headers(key: string) {
	return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

async function seed(
	t: Tester,
	settings: Record<string, unknown>,
	window: { sent: number; bounced: number; complaints: number }
) {
	await t.run(async (ctx) => {
		await ctx.db.insert('instanceSettings', {
			contactCount: 0,
			createdAt: NOW - 10 * DAY_MS,
			abuseStatus: 'suspended',
			abuseStatusReason: REASON,
			abuseStatusChangedAt: SUSPENDED_AT,
			...settings,
		});
		await ctx.db.insert('sendingReputation', {
			scope: 'org',
			periodStart: NOW - (NOW % DAY_MS),
			shardKey: 0,
			totalSent: window.sent,
			totalDelivered: window.sent - window.bounced,
			totalBounced: window.bounced,
			totalHardBounced: window.bounced,
			totalComplaints: window.complaints,
			lastCalculatedAt: NOW,
		});
		await ctx.db.insert(
			'campaigns',
			createTestCampaign({
				name: 'Spring sale',
				searchableText: 'spring sale',
				status: 'sending',
			}) as never
		);
	});
}

/** The lift as each surface reports it, plus the 403's message. */
async function readEverySurface(t: Tester) {
	const statusKey = await seedKey(t, ['status:read']);
	const status = await t.fetch('/api/v1/status', { method: 'GET', headers: headers(statusKey) });
	expect(status.status).toBe(200);
	const { sendingHold } = (await status.json()).data;

	const sendKey = await seedKey(t, ['transactional:send']);
	const refused = await t.fetch('/api/v1/transactional', {
		method: 'POST',
		headers: headers(sendKey),
		body: JSON.stringify({ email: 'to@example.com', slug: 'welcome' }),
	});
	expect(refused.status).toBe(403);
	const { error } = await refused.json();

	const health = await t.query(internal.assistant.insights.deliveryHealth, {});
	const { campaigns } = await t.query(internal.assistant.insights.campaignStats, {
		query: 'spring',
	});

	return {
		sendingHold,
		forbidden: error.data,
		message: error.message as string,
		assistantLift: health.sendHold?.lift,
		campaignLift: campaigns[0]?.sendHold?.kind === 'held' ? campaigns[0].sendHold.lift : undefined,
	};
}

/** Every surface carries the identical `lift`; returns it. */
function sameLiftEverywhere(read: Awaited<ReturnType<typeof readEverySurface>>) {
	const { reason, ...forbiddenHold } = read.forbidden;
	expect(reason).toBe('abuse_blocked');
	expect(forbiddenHold).toEqual(read.sendingHold);
	expect(read.assistantLift).toEqual(read.sendingHold.lift);
	expect(read.campaignLift).toEqual(read.sendingHold.lift);
	return read.sendingHold.lift;
}

describe('how a suspension lifts, on the API and in the assistant', () => {
	it('an automatic suspension names the metric, where it stands and the line it must fall under', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await seed(
			t,
			{ abuseStatusChangedBy: 'system', abuseStatusTrigger: { code: 'complaint_rate' } },
			{ sent: 1000, bounced: 0, complaints: 3 }
		);

		const read = await readEverySurface(t);
		expect(sameLiftEverywhere(read)).toEqual({
			mode: 'automatic',
			condition: {
				trigger: 'complaint_rate',
				domain: null,
				currentPct: 0.3,
				limitPct: 0.2,
				isClear: false,
				clearsAt: null,
			},
		});
		expect(read.message).toBe(
			`Sending is suspended on this Owlat instance. It lifts by itself once the complaint rate over the last 30 days is under 0.2%; it is 0.3% now. A platform admin of this instance can lift it in the operator console. Reason: ${REASON}`
		);
	});

	it('a Gmail suspension names the domain and when its last bad reading leaves the window', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await seed(
			t,
			{
				abuseStatusChangedBy: 'system',
				abuseStatusTrigger: { code: 'gmail_spam_rate', domain: 'news.example.com' },
			},
			{ sent: 1000, bounced: 0, complaints: 0 }
		);
		const readingDay = NOW - (NOW % DAY_MS) - 2 * DAY_MS;
		await t.run(async (ctx) => {
			const domainId = await ctx.db.insert(
				'domains',
				createTestDomain({ domain: 'news.example.com', status: 'verified' })
			);
			await ctx.db.insert('googlePostmasterStats', {
				domainId,
				domain: 'news.example.com',
				periodStart: readingDay,
				userReportedSpamRatio: 0.004,
				fetchedAt: NOW - DAY_MS,
				ingestedAt: NOW - DAY_MS,
			});
		});

		const read = await readEverySurface(t);
		expect(sameLiftEverywhere(read)).toEqual({
			mode: 'automatic',
			condition: {
				trigger: 'gmail_spam_rate',
				domain: 'news.example.com',
				currentPct: 0.4,
				limitPct: 0.1,
				isClear: false,
				clearsAt: new Date(readingDay + 30 * DAY_MS).toISOString(),
			},
		});
		expect(read.message).toContain(
			'It lifts by itself once no Gmail spam rate for news.example.com in the last 30 days is at or above 0.1%; the last reading over it leaves the window on 2026-12-18.'
		);
	});

	it('a suspension a platform admin imposed does not lift by itself', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await seed(t, { abuseStatusChangedBy: 'admin-1' }, { sent: 1000, bounced: 0, complaints: 3 });

		const read = await readEverySurface(t);
		expect(sameLiftEverywhere(read)).toEqual({ mode: 'admin', condition: null });
		expect(read.message).toBe(
			`Sending is suspended on this Owlat instance. It does not lift by itself. A platform admin of this instance can lift it in the operator console. Reason: ${REASON}`
		);
	});

	it('an instance that waits for a platform admin says so, even for a check-imposed suspension', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await seed(
			t,
			{
				abuseStatusChangedBy: 'system',
				abuseStatusTrigger: { code: 'complaint_rate' },
				isSendingResumeManual: true,
			},
			{ sent: 1000, bounced: 0, complaints: 3 }
		);

		const read = await readEverySurface(t);
		expect(sameLiftEverywhere(read)).toEqual({ mode: 'manual_setting', condition: null });
		expect(read.message).toContain(
			'It does not lift by itself: this instance waits for a platform admin to lift it, even after the rates recover.'
		);
	});

	it('under a manual-lift hold, a suspension on another metric is described by its own metric', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		// The bounce rate (12%) was over the line at a platform admin's lift and
		// is held; the complaint rate crossed later and suspended again.
		await seed(
			t,
			{
				abuseStatusChangedBy: 'system',
				abuseStatusTrigger: { code: 'complaint_rate' },
				reputationCheckHold: { until: NOW + 3 * DAY_MS, triggers: [{ code: 'bounce_rate' }] },
			},
			{ sent: 1000, bounced: 120, complaints: 3 }
		);

		const read = await readEverySurface(t);
		expect(sameLiftEverywhere(read)).toEqual({
			mode: 'automatic',
			condition: {
				trigger: 'complaint_rate',
				domain: null,
				currentPct: 0.3,
				limitPct: 0.2,
				isClear: false,
				clearsAt: null,
			},
		});
		// The hold is what a platform admin sees in the operator console, not a member.
		const text = JSON.stringify(read);
		expect(text).not.toContain(new Date(NOW + 3 * DAY_MS).toISOString());
		expect(text).not.toContain(String(NOW + 3 * DAY_MS));
	});
});
