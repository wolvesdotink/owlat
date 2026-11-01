/**
 * What the open pixel and the click redirect write, around the per-IP
 * `emailTracking` budget: a request always spends one token, and only a request
 * inside the budget records its open or click. The response never depends on
 * either.
 */

import { convexTest, type TestConvex } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { createTestContact } from '../../__tests__/factories';
import { modules as allModules } from './helpers/convexModules';

// `http.ts` pulls every route in; the AI modules it reaches cannot load here.
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!/sesActions|agentSecurity|agentContext|agentClassifier|agentDrafter|agentRouter|agent\/walker|agent\/steps\/(index|shared|classify|draft)|knowledgeExtraction|files\/processing|visualizationAgent|llmProvider/.test(
				path
			)
	)
);

const SECRET = 'tracking-writes-secret';
const TRACKING_CAPACITY = 150;
const SAVED_ENV = { ...process.env };
const TARGET = 'https://example.com/landing';
const READER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

beforeEach(() => {
	// The bucket refills with the clock; a frozen clock keeps its level exact.
	// Only `Date` is faked, so convex-test's own scheduling keeps real timers.
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(Date.UTC(2026, 9, 1, 12, 0, 0));
	process.env['UNSUBSCRIBE_SECRET'] = SECRET;
	delete process.env['RATE_LIMIT_TRUSTED_PROXY'];
});

afterEach(() => {
	vi.useRealTimers();
	process.env = { ...SAVED_ENV };
});

function setupTest(): TestConvex<typeof schema> {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

function base64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function clickPath(emailSendId: string, href: string): Promise<string> {
	const encodedUrl = base64Url(new TextEncoder().encode(href));
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(SECRET),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const mac = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(`${emailSendId}.${encodedUrl}`)
	);
	return `/t/c/${emailSendId}/${encodedUrl}/${base64Url(new Uint8Array(mac))}`;
}

async function seedEmailSend(t: TestConvex<typeof schema>): Promise<Id<'emailSends'>> {
	const now = Date.now();
	return await t.run(async (ctx) => {
		const campaignId = await ctx.db.insert('campaigns', {
			name: 'Tracking Campaign',
			status: 'sending',
			fromName: 'Owlat',
			fromEmail: 'sender@owlat.example',
			subject: 'Subject',
			statsSent: 0,
			statsDelivered: 0,
			statsOpened: 0,
			statsClicked: 0,
			statsBounced: 0,
			statsUnsubscribed: 0,
			isABTest: false,
			searchableText: 'tracking campaign',
			createdAt: now,
			updatedAt: now,
		} as never);
		const contactId = await ctx.db.insert('contacts', createTestContact() as never);
		return await ctx.db.insert('emailSends', {
			campaignId,
			contactId,
			contactEmail: 'recipient@example.com',
			status: 'delivered',
			queuedAt: now,
			openCount: 0,
		} as never);
	});
}

/** Spend `count` of the shared `unknown` bucket's tokens. */
async function spendTrackingTokens(t: TestConvex<typeof schema>, count: number): Promise<void> {
	for (let spent = 0; spent < count; spent += 1) {
		await t.mutation(internal.lib.publicRateLimit.checkPublicRateLimit, {
			limitType: 'emailTracking',
			key: 'unknown',
		});
	}
}

const open = (t: TestConvex<typeof schema>, emailSendId: string) =>
	t.fetch(`/t/o/${emailSendId}`, { method: 'GET', headers: { 'User-Agent': READER_AGENT } });

const click = async (t: TestConvex<typeof schema>, emailSendId: string) =>
	t.fetch(await clickPath(emailSendId, TARGET), {
		method: 'GET',
		redirect: 'manual',
		headers: { 'User-Agent': READER_AGENT },
	});

describe('tracking writes under the per-IP budget', () => {
	it('serves the pixel but records no open once the budget is spent', async () => {
		const t = setupTest();
		const emailSendId = await seedEmailSend(t);
		await spendTrackingTokens(t, TRACKING_CAPACITY);

		const res = await open(t, emailSendId);

		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/gif');
		const send = await t.run((ctx) => ctx.db.get(emailSendId));
		expect(send?.status).toBe('delivered');
		expect(send?.openCount).toBe(0);
	});

	it('redirects but records no click once the budget is spent', async () => {
		const t = setupTest();
		const emailSendId = await seedEmailSend(t);
		await spendTrackingTokens(t, TRACKING_CAPACITY);

		const res = await click(t, emailSendId);

		expect(res.status).toBe(302);
		expect(res.headers.get('Location')).toBe(TARGET);
		const send = await t.run((ctx) => ctx.db.get(emailSendId));
		expect(send?.status).toBe('delivered');
		expect(send?.clickedAt).toBeUndefined();
	});

	it('records the open that spends the last token', async () => {
		const t = setupTest();
		const emailSendId = await seedEmailSend(t);
		await spendTrackingTokens(t, TRACKING_CAPACITY - 1);

		await open(t, emailSendId);

		const send = await t.run((ctx) => ctx.db.get(emailSendId));
		expect(send?.status).toBe('opened');
		expect(send?.openCount).toBe(1);
	});

	it('spends a token on an open for an id that is not a send, and records nothing', async () => {
		const t = setupTest();
		const emailSendId = await seedEmailSend(t);
		const contactId = await t.run((ctx) => ctx.db.insert('contacts', createTestContact() as never));
		await spendTrackingTokens(t, TRACKING_CAPACITY - 1);

		const res = await open(t, contactId);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/gif');

		// The not-a-send open took the last token, so this real open is over budget.
		await open(t, emailSendId);
		const send = await t.run((ctx) => ctx.db.get(emailSendId));
		expect(send?.openCount).toBe(0);
	});

	it('spends a token on a click whose signature does not verify', async () => {
		const t = setupTest();
		const emailSendId = await seedEmailSend(t);
		await spendTrackingTokens(t, TRACKING_CAPACITY - 1);

		const forged = await t.fetch(
			`/t/c/${emailSendId}/${base64Url(new TextEncoder().encode(TARGET))}/forged`,
			{ method: 'GET', redirect: 'manual' }
		);
		expect(forged.status).toBe(302);
		expect(forged.headers.get('Location')).toBe('/');

		const res = await click(t, emailSendId);
		expect(res.headers.get('Location')).toBe(TARGET);
		const send = await t.run((ctx) => ctx.db.get(emailSendId));
		expect(send?.clickedAt).toBeUndefined();
	});
});
