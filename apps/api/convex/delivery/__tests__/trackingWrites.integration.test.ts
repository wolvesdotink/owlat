/**
 * What the open pixel and the click redirect write, around the tracking
 * budgets: a request always spends one token, and only a request inside the
 * budget records its open or click. A request for an existing Send spends that
 * Send's own `emailTrackingSend` budget; anything else spends the caller's
 * `emailTracking` budget, which is one shared `unknown` bucket when no proxy is
 * trusted. The response never depends on either.
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
const SHARED_CAPACITY = 150;
const SEND_CAPACITY = 100;
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
async function spendSharedTokens(t: TestConvex<typeof schema>, count: number): Promise<void> {
	for (let spent = 0; spent < count; spent += 1) {
		await t.mutation(internal.lib.publicRateLimit.checkPublicRateLimit, {
			limitType: 'emailTracking',
			key: 'unknown',
		});
	}
}

/** Whether the shared `unknown` bucket still has a token (spending it). */
async function sharedBucketHasToken(t: TestConvex<typeof schema>): Promise<boolean> {
	const { ok } = await t.mutation(internal.lib.publicRateLimit.checkPublicRateLimit, {
		limitType: 'emailTracking',
		key: 'unknown',
	});
	return ok;
}

const open = (t: TestConvex<typeof schema>, emailSendId: string) =>
	t.fetch(`/t/o/${emailSendId}`, { method: 'GET', headers: { 'User-Agent': READER_AGENT } });

const click = async (t: TestConvex<typeof schema>, emailSendId: string) =>
	t.fetch(await clickPath(emailSendId, TARGET), {
		method: 'GET',
		redirect: 'manual',
		headers: { 'User-Agent': READER_AGENT },
	});

describe('tracking writes under the per-send budget', () => {
	it('records an open even when the shared address bucket is spent', async () => {
		const t = setupTest();
		const emailSendId = await seedEmailSend(t);
		await spendSharedTokens(t, SHARED_CAPACITY);

		const res = await open(t, emailSendId);

		expect(res.status).toBe(200);
		const send = await t.run((ctx) => ctx.db.get(emailSendId));
		expect(send?.status).toBe('opened');
		expect(send?.openCount).toBe(1);
	});

	it("does not let one send's spent budget drop another send's open", async () => {
		const t = setupTest();
		const busy = await seedEmailSend(t);
		const quiet = await seedEmailSend(t);
		// A proxy or scanner fetching one recipient's pixel over and over, with no
		// client address known: more than the old shared bucket held.
		for (let hit = 0; hit < SHARED_CAPACITY; hit += 1) await open(t, busy);

		await open(t, quiet);

		expect((await t.run((ctx) => ctx.db.get(busy)))?.openCount).toBe(SEND_CAPACITY);
		const send = await t.run((ctx) => ctx.db.get(quiet));
		expect(send?.status).toBe('opened');
		expect(send?.openCount).toBe(1);
	});

	it("serves the pixel and redirects but records nothing once the send's budget is spent", async () => {
		const t = setupTest();
		const emailSendId = await seedEmailSend(t);
		for (let hit = 0; hit < SEND_CAPACITY; hit += 1) await open(t, emailSendId);

		const pixel = await open(t, emailSendId);
		const redirect = await click(t, emailSendId);

		expect(pixel.status).toBe(200);
		expect(pixel.headers.get('Content-Type')).toBe('image/gif');
		expect(redirect.status).toBe(302);
		expect(redirect.headers.get('Location')).toBe(TARGET);
		const send = await t.run((ctx) => ctx.db.get(emailSendId));
		expect(send?.openCount).toBe(SEND_CAPACITY);
		expect(send?.clickedAt).toBeUndefined();
	});

	it('charges an open for an id that is not a send to the shared bucket, and records nothing', async () => {
		const t = setupTest();
		const emailSendId = await seedEmailSend(t);
		const contactId = await t.run((ctx) => ctx.db.insert('contacts', createTestContact() as never));
		await spendSharedTokens(t, SHARED_CAPACITY - 1);

		const res = await open(t, contactId);
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('image/gif');

		expect(await sharedBucketHasToken(t)).toBe(false);
		await open(t, emailSendId);
		expect((await t.run((ctx) => ctx.db.get(emailSendId)))?.openCount).toBe(1);
	});

	it('charges a click whose signature does not verify to the shared bucket, not the send', async () => {
		const t = setupTest();
		const emailSendId = await seedEmailSend(t);
		await spendSharedTokens(t, SHARED_CAPACITY - 1);

		const forged = await t.fetch(
			`/t/c/${emailSendId}/${base64Url(new TextEncoder().encode(TARGET))}/forged`,
			{ method: 'GET', redirect: 'manual' }
		);
		expect(forged.status).toBe(302);
		expect(forged.headers.get('Location')).toBe('/');
		expect(await sharedBucketHasToken(t)).toBe(false);

		const res = await click(t, emailSendId);
		expect(res.headers.get('Location')).toBe(TARGET);
		expect((await t.run((ctx) => ctx.db.get(emailSendId)))?.clickedAt).toBeTypeOf('number');
	});
});
