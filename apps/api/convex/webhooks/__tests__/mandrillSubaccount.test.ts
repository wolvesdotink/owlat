/**
 * Mandrill webhook events from other subaccounts (#1243).
 *
 * A Mandrill webhook carries every subaccount's events. `unsub` and `reject`
 * act on an ADDRESS without a matching Send, so on a shared account another
 * subaccount's opt-outs and blacklist rules used to unsubscribe or block Owlat
 * contacts. An event from outside the subaccounts Owlat sends under is now
 * applied only when it matches one of our Sends (message id, provider and
 * recipient); everything else from outside is ignored.
 *
 * Every case drives the REAL route (`t.fetch('/webhooks/mandrill')`, signed the
 * way Mandrill documents) and asserts on the database.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import type { DatabaseWriter } from '../../_generated/server';
import { modules } from '../../__tests__/testModules';
import {
	createTestCampaign,
	createTestContact,
	createTestEmailSend,
} from '../../__tests__/factories';
import { _resetSendTransportCacheForTests } from '../../lib/sendProviders/transports';
import { ownMandrillSubaccounts } from '../../lib/sendProviders/mandrill/subaccounts';

const WEBHOOK_KEY = 'mandrill-test-webhook-key';
const SITE_URL = 'https://owlat.example.convex.site';
const PATH = '/webhooks/mandrill';

async function hmacSha1Base64(secret: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-1' },
		false,
		['sign']
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
	return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

type Harness = ReturnType<typeof setupTest>;

function setupTest() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

async function postBatch(t: Harness, events: unknown[]): Promise<void> {
	const body = new URLSearchParams({ mandrill_events: JSON.stringify(events) }).toString();
	const params = new URLSearchParams(body);
	let base = `${SITE_URL}${PATH}`;
	for (const name of [...params.keys()].sort()) base += name + params.get(name);
	const response = await t.fetch(PATH, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'X-Mandrill-Signature': await hmacSha1Base64(WEBHOOK_KEY, base),
		},
		body,
	});
	expect(response.status).toBe(200);
}

/** A Mandrill event stamped a minute ago, sent under `subaccount` (omitted when undefined). */
function event(name: string, msg: Record<string, unknown>, subaccount?: unknown) {
	const ts = Math.floor((Date.now() - 60_000) / 1000);
	return {
		event: name,
		ts,
		msg: { ts, ...msg, ...(subaccount === undefined ? {} : { subaccount }) },
	};
}

const unsub = (id: string, email: string, subaccount?: unknown) =>
	event('unsub', { _id: id, email }, subaccount);

const reject = (id: string, email: string, subaccount?: unknown) =>
	event('reject', { _id: id, email, state: 'rejected', reject_reason: 'custom' }, subaccount);

const spam = (id: string, email: string, subaccount?: unknown) =>
	event('spam', { _id: id, email }, subaccount);

async function seedContact(t: Harness, email: string) {
	return await t.run(
		async (ctx: { db: DatabaseWriter }) =>
			await ctx.db.insert('contacts', createTestContact({ email }))
	);
}

async function seedSend(
	t: Harness,
	providerMessageId: string,
	email: string,
	providerType = 'mandrill',
	status: 'queued' | 'sent' = 'queued'
) {
	return await t.run(async (ctx: { db: DatabaseWriter }) => {
		const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
		const contactId = await ctx.db.insert('contacts', createTestContact({ email }));
		return await ctx.db.insert(
			'emailSends',
			createTestEmailSend({
				campaignId,
				contactId,
				contactEmail: email,
				status,
				providerType,
				providerMessageId,
				sentAt: Date.now(),
			})
		);
	});
}

async function sendStatus(t: Harness, sendId: Id<'emailSends'>) {
	return await t.run(async (ctx: { db: DatabaseWriter }) => (await ctx.db.get(sendId))?.status);
}

async function isUnsubscribed(t: Harness, email: string): Promise<boolean> {
	return await t.run(async (ctx: { db: DatabaseWriter }) => {
		const contact = await ctx.db
			.query('contacts')
			.withIndex('by_email', (q) => q.eq('email', email))
			.first();
		return contact?.unsubscribedAt !== undefined;
	});
}

async function isBlocked(t: Harness, email: string): Promise<boolean> {
	return await t.run(async (ctx: { db: DatabaseWriter }) => {
		const rows = await ctx.db
			.query('blockedEmails')
			.withIndex('by_email', (q) => q.eq('email', email))
			.collect();
		return rows.length > 0;
	});
}

const SAVED_ENV = { ...process.env };

beforeEach(() => {
	process.env['MANDRILL_WEBHOOK_KEY'] = WEBHOOK_KEY;
	process.env['CONVEX_SITE_URL'] = SITE_URL;
	process.env['MANDRILL_API_KEY'] = 'mandrill-primary-key';
	delete process.env['MANDRILL_SUBACCOUNT'];
	delete process.env['SEND_TRANSPORT_INSTANCES'];
	delete process.env['RATE_LIMIT_TRUSTED_PROXY'];
	_resetSendTransportCacheForTests();
});

afterEach(() => {
	process.env = { ...SAVED_ENV };
	_resetSendTransportCacheForTests();
});

describe('with MANDRILL_SUBACCOUNT set', () => {
	beforeEach(() => {
		process.env['MANDRILL_SUBACCOUNT'] = 'owlat';
	});

	it("ignores another subaccount's unsub", async () => {
		const t = setupTest();
		await seedContact(t, 'jane@example.com');

		await postBatch(t, [unsub('m-app-unsub', 'jane@example.com', 'app')]);

		expect(await isUnsubscribed(t, 'jane@example.com')).toBe(false);
	});

	it("ignores another subaccount's reject and blocks no one", async () => {
		const t = setupTest();
		await seedContact(t, 'jane@example.com');

		await postBatch(t, [reject('m-app-reject', 'jane@example.com', 'app')]);

		expect(await isBlocked(t, 'jane@example.com')).toBe(false);
	});

	it('ignores an event with no subaccount, which came from the account default', async () => {
		const t = setupTest();
		await seedContact(t, 'jane@example.com');

		await postBatch(t, [
			unsub('m-default-unsub', 'jane@example.com'),
			reject('m-default-reject', 'jane@example.com', null),
		]);

		expect(await isUnsubscribed(t, 'jane@example.com')).toBe(false);
		expect(await isBlocked(t, 'jane@example.com')).toBe(false);
	});

	it('ignores an event whose subaccount is not a string', async () => {
		const t = setupTest();
		await seedContact(t, 'jane@example.com');

		await postBatch(t, [reject('m-odd', 'jane@example.com', { id: 'owlat' })]);

		expect(await isBlocked(t, 'jane@example.com')).toBe(false);
	});

	it('applies unsub and reject from its own subaccount', async () => {
		const t = setupTest();
		await seedContact(t, 'leaver@example.com');
		const sendId = await seedSend(t, 'm-own-reject', 'blocked@example.com');

		await postBatch(t, [
			unsub('m-own-unsub', 'leaver@example.com', 'owlat'),
			reject('m-own-reject', 'blocked@example.com', 'owlat'),
		]);

		expect(await isUnsubscribed(t, 'leaver@example.com')).toBe(true);
		expect(await isBlocked(t, 'blocked@example.com')).toBe(true);
		const send = await t.run(async (ctx: { db: DatabaseWriter }) => await ctx.db.get(sendId));
		expect(send?.status).toBe('failed');
	});

	// After the setting changed from `old-owlat` to `owlat`, people still
	// unsubscribe from and complain about mail sent under the old one.
	it('applies an unsub and a complaint on a matched Send from a previous subaccount', async () => {
		const t = setupTest();
		await seedSend(t, 'm-old-unsub', 'leaver@example.com');
		const complainedId = await seedSend(
			t,
			'm-old-spam',
			'complainer@example.com',
			'mandrill',
			'sent'
		);

		await postBatch(t, [
			unsub('m-old-unsub', 'leaver@example.com', 'old-owlat'),
			spam('m-old-spam', 'complainer@example.com', 'old-owlat'),
		]);

		expect(await isUnsubscribed(t, 'leaver@example.com')).toBe(true);
		expect(await isBlocked(t, 'complainer@example.com')).toBe(true);
		expect(await sendStatus(t, complainedId)).toBe('complained');
	});

	it('ignores a foreign event whose id matches a Send to a different recipient', async () => {
		const t = setupTest();
		const sendId = await seedSend(t, 'm-shared-id', 'owlat-recipient@example.com');
		await seedContact(t, 'jane@example.com');

		await postBatch(t, [
			reject('m-shared-id', 'jane@example.com', 'app'),
			unsub('m-shared-id', 'jane@example.com', 'app'),
		]);

		expect(await isBlocked(t, 'jane@example.com')).toBe(false);
		expect(await isUnsubscribed(t, 'jane@example.com')).toBe(false);
		expect(await sendStatus(t, sendId)).toBe('queued');
	});

	it('ignores a foreign event whose id matches a Send another provider sent', async () => {
		const t = setupTest();
		const sendId = await seedSend(t, 'm-resend-id', 'jane@example.com', 'resend');

		await postBatch(t, [reject('m-resend-id', 'jane@example.com', 'app')]);

		expect(await isBlocked(t, 'jane@example.com')).toBe(false);
		expect(await sendStatus(t, sendId)).toBe('queued');
	});
});

describe('with MANDRILL_SUBACCOUNT unset', () => {
	it('applies events with no subaccount exactly as before', async () => {
		const t = setupTest();
		await seedContact(t, 'leaver@example.com');
		await seedSend(t, 'm-plain-reject', 'blocked@example.com');

		await postBatch(t, [
			unsub('m-plain-unsub', 'leaver@example.com'),
			reject('m-plain-reject', 'blocked@example.com', null),
		]);

		expect(await isUnsubscribed(t, 'leaver@example.com')).toBe(true);
		expect(await isBlocked(t, 'blocked@example.com')).toBe(true);
	});

	it('also applies an empty-string subaccount, which the send path reads as none', async () => {
		const t = setupTest();
		await seedContact(t, 'leaver@example.com');

		await postBatch(t, [unsub('m-empty-unsub', 'leaver@example.com', '')]);

		expect(await isUnsubscribed(t, 'leaver@example.com')).toBe(true);
	});

	// A Mandrill rule can move Owlat's own mail into a subaccount on Mandrill's
	// side, so a tagged event that matches one of our Sends is ours.
	it('applies a tagged unsub and reject that match Owlat Sends', async () => {
		const t = setupTest();
		await seedSend(t, 'm-rule-unsub', 'leaver@example.com');
		const rejectedId = await seedSend(t, 'm-rule-reject', 'blocked@example.com');

		await postBatch(t, [
			unsub('m-rule-unsub', 'leaver@example.com', 'rule-assigned'),
			reject('m-rule-reject', 'blocked@example.com', 'rule-assigned'),
		]);

		expect(await isUnsubscribed(t, 'leaver@example.com')).toBe(true);
		expect(await isBlocked(t, 'blocked@example.com')).toBe(true);
		expect(await sendStatus(t, rejectedId)).toBe('failed');
	});

	it('ignores unsub and reject that name a subaccount and match no Send', async () => {
		const t = setupTest();
		await seedContact(t, 'jane@example.com');

		await postBatch(t, [
			unsub('m-app-unsub', 'jane@example.com', 'app'),
			reject('m-app-reject', 'jane@example.com', 'app'),
		]);

		expect(await isUnsubscribed(t, 'jane@example.com')).toBe(false);
		expect(await isBlocked(t, 'jane@example.com')).toBe(false);
	});
});

describe('with a named Mandrill transport', () => {
	beforeEach(() => {
		process.env['MANDRILL_API_KEY'] = 'mandrill-primary-key';
		process.env['MANDRILL_SUBACCOUNT'] = 'owlat';
		process.env['SEND_TRANSPORT_INSTANCES'] = 'mandrill#eu';
		process.env['MANDRILL_API_KEY__EU'] = 'mandrill-eu-key';
		process.env['MANDRILL_SUBACCOUNT__EU'] = 'owlat-eu';
	});

	it('accepts the subaccount of every configured Mandrill transport', () => {
		expect([...ownMandrillSubaccounts()].sort()).toEqual(['owlat', 'owlat-eu']);
	});

	it("applies the named transport's events and still ignores a foreign one", async () => {
		const t = setupTest();
		await seedContact(t, 'eu@example.com');
		await seedContact(t, 'jane@example.com');

		await postBatch(t, [
			unsub('m-eu-unsub', 'eu@example.com', 'owlat-eu'),
			unsub('m-app-unsub', 'jane@example.com', 'app'),
		]);

		expect(await isUnsubscribed(t, 'eu@example.com')).toBe(true);
		expect(await isUnsubscribed(t, 'jane@example.com')).toBe(false);
	});
});

describe('with only a named Mandrill transport configured', () => {
	beforeEach(() => {
		delete process.env['MANDRILL_API_KEY'];
		process.env['SEND_TRANSPORT_INSTANCES'] = 'mandrill#eu';
		process.env['MANDRILL_API_KEY__EU'] = 'mandrill-eu-key';
		process.env['MANDRILL_SUBACCOUNT__EU'] = 'owlat-eu';
	});

	it('leaves the unconfigured default out of scope', () => {
		expect([...ownMandrillSubaccounts()]).toEqual(['owlat-eu']);
	});

	it("ignores another sender's account-default unsub and applies the named subaccount's", async () => {
		const t = setupTest();
		await seedContact(t, 'jane@example.com');
		await seedContact(t, 'eu@example.com');

		await postBatch(t, [
			unsub('m-default-unsub', 'jane@example.com'),
			unsub('m-eu-unsub', 'eu@example.com', 'owlat-eu'),
		]);

		expect(await isUnsubscribed(t, 'jane@example.com')).toBe(false);
		expect(await isUnsubscribed(t, 'eu@example.com')).toBe(true);
	});
});
