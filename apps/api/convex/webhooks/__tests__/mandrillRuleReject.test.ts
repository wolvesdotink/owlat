/**
 * A Mandrill `rule` reject fails the Send and blocks no one (#1249).
 *
 * Mandrill's rules engine can reject a message on its subject, sender, tags,
 * template or API key, and the "reject message" action writes nothing to the
 * denylist. One subject rule used to put every recipient of a campaign on
 * `blockedEmails` as `manual`, one send at a time. A `spam` reject is different:
 * it is the denylist entry a recipient's complaint left, so it keeps blocking.
 *
 * Both doors a reject reaches Owlat through are driven for real: the signed
 * webhook route against a seeded Send, and the send adapter's `rejected` answer
 * through `recordSendResponseRefusal`, the write the governed dispatch makes.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import schema from '../../schema';
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
import { recordSendResponseRefusal } from '../providerSuppression';

const WEBHOOK_KEY = 'mandrill-test-webhook-key';
const SITE_URL = 'https://owlat.example.convex.site';
const PATH = '/webhooks/mandrill';
const RECIPIENT = 'alice@example.com';

const PROBE = makeFunctionReference<'action', { reason: string; to: string }, boolean>(
	'webhooks/ruleRejectProbe:refuse'
);

/** The real send adapter against a mocked `rejected` answer, then the dispatch's write. */
const probeModule = {
	'../webhooks/ruleRejectProbe.ts': async () => ({
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
						subject: 'Weekly digest #12',
						html: '<p>Body</p>',
						text: 'Body',
					});
				} finally {
					global.fetch = realFetch;
					_resetMandrillConfigCacheForTests();
				}
				await recordSendResponseRefusal(ctx, { result, providerType: 'mandrill', recipient: to });
				return result.success;
			},
		}),
	}),
};

type Harness = ReturnType<typeof setupTest>;

function setupTest() {
	const t = convexTest(schema, { ...modules, ...probeModule });
	rateLimiterTest.register(t);
	return t;
}

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

/** Post a signed batch holding one `reject` for `id` with this reason. */
async function postReject(t: Harness, id: string, reason: string): Promise<void> {
	const ts = Math.floor((Date.now() - 60_000) / 1000);
	const events = [
		{
			event: 'reject',
			ts,
			msg: { ts, _id: id, email: RECIPIENT, state: 'rejected', reject_reason: reason },
		},
	];
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

async function seedSend(t: Harness, providerMessageId: string): Promise<Id<'emailSends'>> {
	return await t.run(async (ctx: { db: DatabaseWriter }) => {
		const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
		const contactId = await ctx.db.insert('contacts', createTestContact({ email: RECIPIENT }));
		return await ctx.db.insert(
			'emailSends',
			createTestEmailSend({
				campaignId,
				contactId,
				contactEmail: RECIPIENT,
				status: 'queued',
				providerType: 'mandrill',
				providerMessageId,
				sentAt: Date.now(),
			})
		);
	});
}

/** Everything a suppression could have written about the recipient. */
async function recipientState(t: Harness) {
	return await t.run(async (ctx: { db: DatabaseWriter }) => {
		const blocked = await ctx.db
			.query('blockedEmails')
			.withIndex('by_email', (q) => q.eq('email', RECIPIENT))
			.collect();
		const contact = await ctx.db
			.query('contacts')
			.withIndex('by_email', (q) => q.eq('email', RECIPIENT))
			.first();
		const audit = await ctx.db
			.query('auditLogs')
			.withIndex('by_action', (q) => q.eq('action', 'blocklist.provider_suppressed'))
			.collect();
		return {
			blockedReasons: blocked.map((row) => row.reason),
			unsubscribed: contact?.unsubscribedAt !== undefined,
			auditEvidence: audit.map((entry) => entry.details?.['evidence']),
		};
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
	_resetMandrillConfigCacheForTests();
});

afterEach(() => {
	process.env = { ...SAVED_ENV };
	_resetSendTransportCacheForTests();
});

describe('a rule reject on the webhook route', () => {
	it('fails the Send and blocks no one', async () => {
		const t = setupTest();
		const sendId = await seedSend(t, 'm-rule');

		await postReject(t, 'm-rule', 'rule');

		const send = await t.run(async (ctx: { db: DatabaseWriter }) => await ctx.db.get(sendId));
		expect(send?.status).toBe('failed');
		expect(await recipientState(t)).toEqual({
			blockedReasons: [],
			unsubscribed: false,
			auditEvidence: [],
		});
	});

	// The complaint-made denylist entry is recipient truth and still blocks.
	it('still blocks a spam reject as a complaint', async () => {
		const t = setupTest();
		const sendId = await seedSend(t, 'm-spam');

		await postReject(t, 'm-spam', 'spam');

		const send = await t.run(async (ctx: { db: DatabaseWriter }) => await ctx.db.get(sendId));
		expect(send?.status).toBe('failed');
		expect(await recipientState(t)).toEqual({
			blockedReasons: ['complained'],
			unsubscribed: false,
			auditEvidence: ['MANDRILL_REJECT_SPAM'],
		});
	});
});

describe('a rule refusal in the send response', () => {
	it('fails the send and blocks no one', async () => {
		const t = setupTest();
		await t.run(async (ctx: { db: DatabaseWriter }) => {
			await ctx.db.insert('contacts', createTestContact({ email: RECIPIENT }));
		});

		expect(await t.action(PROBE, { reason: 'rule', to: RECIPIENT })).toBe(false);

		expect(await recipientState(t)).toEqual({
			blockedReasons: [],
			unsubscribed: false,
			auditEvidence: [],
		});
	});

	it('still blocks a spam refusal as a complaint', async () => {
		const t = setupTest();

		expect(await t.action(PROBE, { reason: 'spam', to: RECIPIENT })).toBe(false);

		expect(await recipientState(t)).toEqual({
			blockedReasons: ['complained'],
			unsubscribed: false,
			auditEvidence: ['MANDRILL_REJECT_SPAM'],
		});
	});
});
