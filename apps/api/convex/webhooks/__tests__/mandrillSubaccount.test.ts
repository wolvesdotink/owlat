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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { internalAction, type DatabaseWriter } from '../../_generated/server';
import { modules } from '../../__tests__/testModules';
import {
	createTestCampaign,
	createTestContact,
	createTestEmailSend,
} from '../../__tests__/factories';
import {
	_resetSendTransportCacheForTests,
	resolveSendTransport,
} from '../../lib/sendProviders/transports';
import {
	_resetMandrillConfigCacheForTests,
	mandrillSendProvider,
} from '../../lib/sendProviders/mandrill';
import { deadlineSweepCutoff } from '../../delivery/stuckSendSweep';
import { applySendResponseSuppression } from '../providerSuppression';
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

function setupTest(overrides: Record<string, () => Promise<unknown>> = {}) {
	const t = convexTest(schema, { ...modules, ...overrides });
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

describe('feedback that arrives before its Send can be matched', () => {
	beforeEach(() => {
		process.env['MANDRILL_SUBACCOUNT'] = 'owlat';
	});

	/** A Send that completion has not given its provider id yet. */
	async function seedUnboundSend(t: Harness, email: string, status: 'queued' | 'sent' = 'queued') {
		const sendId = await seedSend(t, 'placeholder', email, 'mandrill', status);
		await t.run(async (ctx: { db: DatabaseWriter }) => {
			await ctx.db.patch(sendId, { providerMessageId: undefined, providerType: undefined });
		});
		return sendId;
	}

	const hardBounce = (id: string, email: string) =>
		event(
			'hard_bounce',
			{ _id: id, email, diag: 'smtp;550 5.1.1 mailbox missing' },
			'rule-assigned'
		);

	async function unresolvedRows(t: Harness) {
		return await t.run(
			async (ctx: { db: DatabaseWriter }) => await ctx.db.query('unresolvedFeedback').collect()
		);
	}

	async function bindAndReplay(t: Harness, sendId: Id<'emailSends'>, providerMessageId: string) {
		await t.run(async (ctx: { db: DatabaseWriter }) => {
			await ctx.db.patch(sendId, { providerMessageId, providerType: 'mandrill', status: 'sent' });
		});
		const [row] = await unresolvedRows(t);
		return await t.mutation(internal.webhooks.unresolvedFeedback.replay, { feedbackId: row!._id });
	}

	it('keeps an early out-of-scope bounce and applies it once the Send has its id', async () => {
		const t = setupTest();
		const sendId = await seedUnboundSend(t, 'jane@example.com');

		await postBatch(t, [hardBounce('m-early', 'jane@example.com')]);

		const rows = await unresolvedRows(t);
		expect(rows).toHaveLength(1);
		// A salted hash, never the address itself.
		expect(rows[0]!.sendingScope?.recipientHash).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(rows[0])).not.toContain('jane@example.com');

		expect(await bindAndReplay(t, sendId, 'm-early')).toBe('replayed');
		expect(await sendStatus(t, sendId)).toBe('bounced');
	});

	it('refuses the replay when the Send that turns up went to someone else', async () => {
		const t = setupTest();
		const sendId = await seedUnboundSend(t, 'owlat-recipient@example.com');

		await postBatch(t, [hardBounce('m-other', 'jane@example.com')]);

		expect(await bindAndReplay(t, sendId, 'm-other')).toBe('refused');
		expect(await sendStatus(t, sendId)).toBe('sent');
		expect(await isBlocked(t, 'owlat-recipient@example.com')).toBe(false);
	});

	it('refuses the replay when the Send went out through another provider', async () => {
		const t = setupTest();
		const sendId = await seedUnboundSend(t, 'jane@example.com');

		await postBatch(t, [hardBounce('m-resend', 'jane@example.com')]);
		await t.run(async (ctx: { db: DatabaseWriter }) => {
			await ctx.db.patch(sendId, {
				providerMessageId: 'm-resend',
				providerType: 'resend',
				status: 'sent',
			});
		});
		const [row] = await unresolvedRows(t);

		expect(
			await t.mutation(internal.webhooks.unresolvedFeedback.replay, { feedbackId: row!._id })
		).toBe('refused');
		expect(await sendStatus(t, sendId)).toBe('sent');
	});
});

/**
 * A REJECT MANDRILL MADE IN THE SEND RESPONSE. A `rejected` result is our own
 * request refused off the reject list, so the governed dispatch records its
 * suppression there (`applySendResponseSuppression`), without touching the
 * Send. The later `reject` webhook matches no Send (a refused send stores no
 * id) and, when it comes from another subaccount, is dropped.
 */
describe('a reject Mandrill made in the send response', () => {
	const PROBE = makeFunctionReference<'action', { reason: string; to: string }, boolean>(
		'webhooks/sendResponseProbe:refuse'
	);

	/** The real send adapter against a mocked `rejected` answer, then the dispatch's write. */
	const probeModule = {
		'../webhooks/sendResponseProbe.ts': async () => ({
			refuse: internalAction({
				args: { reason: v.string(), to: v.string() },
				handler: async (ctx, { reason, to }) => {
					const realFetch = global.fetch;
					global.fetch = vi
						.fn()
						.mockResolvedValue(
							new Response(
								JSON.stringify([
									{ email: to, status: 'rejected', _id: 'refused-1', reject_reason: reason },
								]),
								{ status: 200 }
							)
						) as unknown as typeof fetch;
					let result;
					try {
						result = await mandrillSendProvider.sendEmail(resolveSendTransport('mandrill'), {
							to,
							from: 'Owlat <sender@example.com>',
							subject: 'Subject',
							html: '<p>Body</p>',
							text: 'Body',
						});
					} finally {
						global.fetch = realFetch;
						_resetMandrillConfigCacheForTests();
					}
					if (result.success || !result.suppression) return false;
					await applySendResponseSuppression(
						ctx,
						{ providerType: 'mandrill', recipient: to, at: Date.now() },
						result.suppression
					);
					return true;
				},
			}),
		}),
	};

	beforeEach(() => {
		process.env['MANDRILL_SUBACCOUNT'] = 'owlat';
		_resetMandrillConfigCacheForTests();
	});

	it.each(['hard-bounce', 'spam', 'custom', 'rule'])(
		'blocks the address on a %s refusal with no webhook at all',
		async (reason) => {
			const t = setupTest(probeModule);
			expect(await t.action(PROBE, { reason, to: 'jane@example.com' })).toBe(true);
			expect(await isBlocked(t, 'jane@example.com')).toBe(true);
		}
	);

	it('unsubscribes the contact on an unsub refusal', async () => {
		const t = setupTest(probeModule);
		await seedContact(t, 'leaver@example.com');

		await t.action(PROBE, { reason: 'unsub', to: 'leaver@example.com' });

		expect(await isUnsubscribed(t, 'leaver@example.com')).toBe(true);
		expect(await isBlocked(t, 'leaver@example.com')).toBe(false);
	});

	it.each(['unsigned', 'invalid-sender', 'test-mode-limit', 'invalid'])(
		'blocks no one on a sender-side %s refusal',
		async (reason) => {
			const t = setupTest(probeModule);
			expect(await t.action(PROBE, { reason, to: 'jane@example.com' })).toBe(false);
			expect(await isBlocked(t, 'jane@example.com')).toBe(false);
		}
	);

	it('ignores the later rule-assigned reject webhook, early or after the Send failed', async () => {
		const t = setupTest(probeModule);
		const sendId = await seedSend(t, 'placeholder', 'jane@example.com');
		await t.run(async (ctx: { db: DatabaseWriter }) => {
			await ctx.db.patch(sendId, { providerMessageId: undefined, providerType: undefined });
		});
		await t.action(PROBE, { reason: 'hard-bounce', to: 'jane@example.com' });

		// Early: the Send is still queued. Late: the completion failed it.
		await postBatch(t, [reject('refused-1', 'jane@example.com', 'rule-assigned')]);
		expect(await sendStatus(t, sendId)).toBe('queued');
		await t.run(async (ctx: { db: DatabaseWriter }) => {
			await ctx.db.patch(sendId, { status: 'failed' });
		});
		await postBatch(t, [reject('refused-1', 'jane@example.com', 'rule-assigned')]);

		const rows = await t.run(
			async (ctx: { db: DatabaseWriter }) =>
				await ctx.db
					.query('blockedEmails')
					.withIndex('by_email', (q) => q.eq('email', 'jane@example.com'))
					.collect()
		);
		expect(rows).toHaveLength(1);
		const claims = await t.run(
			async (ctx: { db: DatabaseWriter }) => await ctx.db.query('inboundEventClaims').collect()
		);
		expect(claims).toEqual([]);
	});

	it('leaves the Send to the lost-send sweep when its completion never lands', async () => {
		const t = setupTest(probeModule);
		const sendId = await seedSend(t, 'placeholder', 'jane@example.com');
		await t.run(async (ctx: { db: DatabaseWriter }) => {
			await ctx.db.patch(sendId, {
				providerMessageId: undefined,
				providerType: undefined,
				firstAttemptAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
			});
		});

		await t.action(PROBE, { reason: 'hard-bounce', to: 'jane@example.com' });
		const outcome = await t.mutation(internal.delivery.stuckSendSweep.failLostSend, {
			sendRef: { kind: 'campaign', id: sendId },
			mode: 'deadline',
			cutoff: deadlineSweepCutoff(Date.now()),
		});

		expect(outcome).toEqual({ isFailed: true, reason: null });
		expect(await sendStatus(t, sendId)).toBe('failed');
	});
});
