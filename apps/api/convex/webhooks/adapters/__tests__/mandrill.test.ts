/**
 * Mandrill webhook adapter + route (plan D10, piece P2.1).
 *
 * Two layers, because the piece has two failure modes and they are not the same
 * kind of bug:
 *
 *   1. THE SCHEME. `X-Mandrill-Signature` is base64(HMAC-SHA1(webhook key, the
 *      exact webhook URL + every decoded POST param in alphabetical key order)).
 *      Signed here byte-for-byte from Mandrill's documentation rather than by
 *      calling the adapter's own helper, so a change to the construction fails
 *      these tests instead of agreeing with itself. Wrong key, wrong URL,
 *      missing header and unset env var each have their own case.
 *   2. THE JOIN. Every event in the D10 table is replayed through the REAL
 *      route — `t.fetch('/webhooks/mandrill')` → rate limit → signature → audit
 *      store → batch parse → dispatcher → Send lifecycle — against a seeded
 *      send row, and the assertion is on the row and its blocklist/counter
 *      side-effects, never on an intermediate call. Nothing is stubbed between
 *      the wire and the database.
 *
 * The adversarial cases are the ones the plan's risk table names: batches
 * arrive out of order or twice (`§7 risk: webhook batches arrive out of order /
 * replayed`), and an id we cannot resolve must never 5xx.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import schema from '../../../schema';
import type { Id } from '../../../_generated/dataModel';
import type { DatabaseWriter } from '../../../_generated/server';
import { modules } from '../../../__tests__/testModules';
import {
	createTestCampaign,
	createTestContact,
	createTestEmailSend,
	createTestTopic,
} from '../../../__tests__/factories';
import { startOfDayUtc } from '../../../lib/clock';
import {
	classifyMandrillBounce,
	mandrillSignedUrlCandidates,
	mapMandrillEvent,
	parseMandrillBatch,
	verifyMandrillSignature,
} from '../mandrill';

const WEBHOOK_KEY = 'mandrill-test-webhook-key';
const SITE_URL = 'https://owlat.example.convex.site';
const PATH = '/webhooks/mandrill';
/** The URL an operator pastes into Mandrill — CONVEX_SITE_URL + the route. */
const SIGNED_URL = `${SITE_URL}${PATH}`;
/** The URL convex-test's router actually presents to the http action. */
const REQUEST_URL = `https://some.convex.site${PATH}`;

// ─── Mandrill's signing scheme, mirrored from the documentation ─────────────

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

function formBody(events: unknown[]): string {
	return new URLSearchParams({ mandrill_events: JSON.stringify(events) }).toString();
}

async function signBody(
	body: string,
	{ url = SIGNED_URL, key = WEBHOOK_KEY }: { url?: string; key?: string } = {}
): Promise<string> {
	const params = new URLSearchParams(body);
	let base = url;
	for (const name of [...params.keys()].sort()) base += name + params.get(name);
	return await hmacSha1Base64(key, base);
}

// ─── Harness ───────────────────────────────────────────────────────────────

const SAVED_ENV = { ...process.env };

beforeEach(() => {
	process.env['MANDRILL_WEBHOOK_KEY'] = WEBHOOK_KEY;
	process.env['CONVEX_SITE_URL'] = SITE_URL;
	delete process.env['RATE_LIMIT_TRUSTED_PROXY'];
});

afterEach(() => {
	process.env = { ...SAVED_ENV };
});

function setupTest() {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	return t;
}

type Harness = ReturnType<typeof setupTest>;

/** POST a batch through the real route, signed unless told otherwise. */
async function postBatch(
	t: Harness,
	events: unknown[],
	options: { signature?: string | null; url?: string; key?: string } = {}
): Promise<Response> {
	return await postRaw(t, formBody(events), options);
}

async function postRaw(
	t: Harness,
	body: string,
	options: { signature?: string | null; url?: string; key?: string } = {}
): Promise<Response> {
	const signature =
		options.signature === undefined
			? await signBody(body, { url: options.url, key: options.key })
			: options.signature;
	return await t.fetch(PATH, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			...(signature === null ? {} : { 'X-Mandrill-Signature': signature }),
		},
		body,
	});
}

interface SeededSend {
	sendId: Id<'emailSends'>;
	contactId: Id<'contacts'>;
	email: string;
}

/** A campaign send already dispatched through Mandrill, joinable by its `_id`. */
async function seedMandrillSend(
	t: Harness,
	options: { providerMessageId: string; status?: string; email?: string } = {
		providerMessageId: 'msg-1',
	}
): Promise<SeededSend> {
	return await t.run(async (ctx: { db: DatabaseWriter }) => {
		const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
		const contact = createTestContact(options.email ? { email: options.email } : {});
		const contactId = await ctx.db.insert('contacts', contact);
		const email = contact.email as string;
		const sendId = await ctx.db.insert(
			'emailSends',
			createTestEmailSend({
				campaignId,
				contactId,
				contactEmail: email,
				status: options.status ?? 'sent',
				providerType: 'mandrill',
				providerMessageId: options.providerMessageId,
				sentAt: Date.now(),
			})
		);
		return { sendId, contactId, email };
	});
}

async function readSend(t: Harness, sendId: Id<'emailSends'>) {
	return await t.run(async (ctx: { db: DatabaseWriter }) => await ctx.db.get(sendId));
}

/** A Mandrill message event, with the fields the adapter reads. */
function event(
	name: string,
	msg: Record<string, unknown>,
	ts = Math.floor(Date.UTC(2026, 7, 4, 12, 0, 0) / 1000)
): Record<string, unknown> {
	return { event: name, ts, msg: { ts, ...msg } };
}

// ═══ 1. The signing scheme ═════════════════════════════════════════════════

describe('Mandrill signature verification', () => {
	const body = formBody([event('send', { _id: 'm-1' })]);

	it('accepts a signature over the configured webhook URL', async () => {
		const signature = await signBody(body);
		expect(await verifyMandrillSignature([SIGNED_URL], body, signature, WEBHOOK_KEY)).toBe(true);
	});

	it('rejects a signature made with a different key', async () => {
		const signature = await signBody(body, { key: 'not-the-webhook-key' });
		expect(await verifyMandrillSignature([SIGNED_URL], body, signature, WEBHOOK_KEY)).toBe(false);
	});

	it('rejects a signature made over a different URL', async () => {
		const signature = await signBody(body, { url: 'https://evil.example.com/webhooks/mandrill' });
		expect(await verifyMandrillSignature([SIGNED_URL], body, signature, WEBHOOK_KEY)).toBe(false);
	});

	it('rejects a tampered body', async () => {
		const signature = await signBody(body);
		const tampered = formBody([event('send', { _id: 'm-2' })]);
		expect(await verifyMandrillSignature([SIGNED_URL], tampered, signature, WEBHOOK_KEY)).toBe(
			false
		);
	});

	it('accepts when the signature matches ANY candidate URL (proxied deployment)', async () => {
		const signature = await signBody(body, { url: REQUEST_URL });
		expect(
			await verifyMandrillSignature([SIGNED_URL, REQUEST_URL], body, signature, WEBHOOK_KEY)
		).toBe(true);
	});

	it('prefers CONVEX_SITE_URL and keeps the request URL as a fallback candidate', () => {
		expect(mandrillSignedUrlCandidates(REQUEST_URL)).toEqual([SIGNED_URL, REQUEST_URL]);
	});

	it('falls back to the request URL alone when CONVEX_SITE_URL is unset', () => {
		delete process.env['CONVEX_SITE_URL'];
		expect(mandrillSignedUrlCandidates(REQUEST_URL)).toEqual([REQUEST_URL]);
	});
});

describe('POST /webhooks/mandrill — rejects', () => {
	it('401s a request with no X-Mandrill-Signature header', async () => {
		const t = setupTest();
		const res = await postBatch(t, [event('send', { _id: 'm-1' })], { signature: null });
		expect(res.status).toBe(401);
	});

	it('401s a request signed with the wrong key', async () => {
		const t = setupTest();
		const res = await postBatch(t, [event('send', { _id: 'm-1' })], { key: 'wrong-key' });
		expect(res.status).toBe(401);
	});

	it('401s a request signed over the wrong URL', async () => {
		const t = setupTest();
		const res = await postBatch(t, [event('send', { _id: 'm-1' })], {
			url: 'https://attacker.example.com/webhooks/mandrill',
		});
		expect(res.status).toBe(401);
	});

	it('503s (fail-closed) when MANDRILL_WEBHOOK_KEY is unset', async () => {
		delete process.env['MANDRILL_WEBHOOK_KEY'];
		const t = setupTest();
		const body = formBody([event('send', { _id: 'm-1' })]);
		const res = await postRaw(t, body, { signature: await signBody(body) });
		expect(res.status).toBe(503);
	});

	it('applies no state change on a rejected request', async () => {
		const t = setupTest();
		const { sendId } = await seedMandrillSend(t, { providerMessageId: 'm-1', status: 'sent' });
		await postBatch(t, [event('hard_bounce', { _id: 'm-1', diag: 'smtp;550 user unknown' })], {
			signature: null,
		});
		expect((await readSend(t, sendId))?.status).toBe('sent');
	});
});

// ═══ 2. Verification pings ═════════════════════════════════════════════════

describe('Mandrill webhook verification pings', () => {
	it('answers the unsigned HEAD URL probe with 200 and dispatches nothing', async () => {
		const t = setupTest();
		const { sendId } = await seedMandrillSend(t, { providerMessageId: 'm-1', status: 'sent' });
		const res = await t.fetch(PATH, { method: 'HEAD' });
		expect(res.status).toBe(200);
		expect((await readSend(t, sendId))?.status).toBe('sent');
	});

	it('answers a signed empty batch with 200 and dispatches nothing', async () => {
		const t = setupTest();
		const { sendId } = await seedMandrillSend(t, { providerMessageId: 'm-1', status: 'sent' });
		const res = await postBatch(t, []);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true, ignored: true });
		expect((await readSend(t, sendId))?.status).toBe('sent');
	});
});

// ═══ 3. Batch fan-out ══════════════════════════════════════════════════════

describe('Mandrill batch fan-out', () => {
	it('processes three events in order, each moving its own send row', async () => {
		const t = setupTest();
		const first = await seedMandrillSend(t, { providerMessageId: 'm-a', status: 'queued' });
		const second = await seedMandrillSend(t, { providerMessageId: 'm-b', status: 'sent' });
		const third = await seedMandrillSend(t, { providerMessageId: 'm-c', status: 'sent' });

		const res = await postBatch(t, [
			event('send', { _id: 'm-a' }),
			event('hard_bounce', { _id: 'm-b', diag: 'smtp;550 5.1.1 user unknown' }),
			event('spam', { _id: 'm-c' }),
		]);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true, processed: 3 });
		expect((await readSend(t, first.sendId))?.status).toBe('sent');
		expect((await readSend(t, second.sendId))?.status).toBe('bounced');
		expect((await readSend(t, third.sendId))?.status).toBe('complained');
	});

	it('applies a deferral-then-bounce timeline for ONE message in batch order', async () => {
		const t = setupTest();
		const { sendId } = await seedMandrillSend(t, { providerMessageId: 'm-1', status: 'sent' });

		const res = await postBatch(t, [
			event('deferral', { _id: 'm-1', diag: 'smtp;451 4.7.1 try again later' }),
			event('soft_bounce', { _id: 'm-1', bounce_description: 'mailbox_full' }),
		]);

		expect(res.status).toBe(200);
		const send = await readSend(t, sendId);
		expect(send?.status).toBe('bounced');
		expect(send?.bounceType).toBe('soft');
		// The deferral observation stamped its day even though it moved no state.
		expect(send?.deferralCountedDay).toBeDefined();
	});
});

// ═══ 4. The D10 event table, end to end ════════════════════════════════════

describe('Mandrill event mapping (D10 table)', () => {
	it('`send` reconciles a send whose acceptance was left unknown by an ambiguous timeout', async () => {
		// D4: a Mandrill API timeout is terminal-but-undecided, so the send stays
		// `queued` with its provider identity bound and NOTHING claims it was
		// accepted. This event is the acceptance — the D4↔D10 handshake.
		const t = setupTest();
		const { sendId } = await seedMandrillSend(t, {
			providerMessageId: 'ambiguous-1',
			status: 'queued',
		});
		const res = await postBatch(t, [event('send', { _id: 'ambiguous-1' })]);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true, kind: 'email.sent' });
		const send = await readSend(t, sendId);
		expect(send?.status).toBe('sent');
		expect(send?.providerType).toBe('mandrill');
	});

	it('`hard_bounce` bounces the row hard AND blocklists the recipient', async () => {
		const t = setupTest();
		const { sendId, email } = await seedMandrillSend(t, {
			providerMessageId: 'm-hard',
			status: 'sent',
		});
		const res = await postBatch(t, [
			event('hard_bounce', {
				_id: 'm-hard',
				email,
				bounce_description: 'bad_mailbox',
				diag: 'smtp;550 5.1.1 The email account that you tried to reach does not exist',
			}),
		]);

		expect(res.status).toBe(200);
		const send = await readSend(t, sendId);
		expect(send?.status).toBe('bounced');
		expect(send?.bounceType).toBe('hard');

		const blocked = await t.run(
			async (ctx: { db: DatabaseWriter }) =>
				await ctx.db
					.query('blockedEmails')
					.withIndex('by_email', (q) => q.eq('email', email))
					.first()
		);
		expect(blocked?.reason).toBe('bounced');
		expect(blocked?.bounceType).toBe('hard');
	});

	it('`soft_bounce` bounces the row soft and does not blocklist', async () => {
		const t = setupTest();
		const { sendId, email } = await seedMandrillSend(t, {
			providerMessageId: 'm-soft',
			status: 'sent',
		});
		await postBatch(t, [
			event('soft_bounce', { _id: 'm-soft', email, bounce_description: 'mailbox_full' }),
		]);

		const send = await readSend(t, sendId);
		expect(send?.status).toBe('bounced');
		expect(send?.bounceType).toBe('soft');
		const blocked = await t.run(
			async (ctx: { db: DatabaseWriter }) =>
				await ctx.db
					.query('blockedEmails')
					.withIndex('by_email', (q) => q.eq('email', email))
					.first()
		);
		expect(blocked).toBeNull();
	});

	it('`spam` complains the row and blocklists the complainer', async () => {
		const t = setupTest();
		const { sendId, email } = await seedMandrillSend(t, {
			providerMessageId: 'm-spam',
			status: 'sent',
		});
		await postBatch(t, [event('spam', { _id: 'm-spam', email })]);

		expect((await readSend(t, sendId))?.status).toBe('complained');
		const blocked = await t.run(
			async (ctx: { db: DatabaseWriter }) =>
				await ctx.db
					.query('blockedEmails')
					.withIndex('by_email', (q) => q.eq('email', email))
					.first()
		);
		expect(blocked?.reason).toBe('complained');
	});

	it('`deferral` records the deferred transport outcome without moving the send', async () => {
		const t = setupTest();
		const at = Date.UTC(2026, 7, 4, 12, 0, 0);
		const { sendId } = await seedMandrillSend(t, { providerMessageId: 'm-defer', status: 'sent' });

		const res = await postBatch(t, [
			event('deferral', { _id: 'm-defer', diag: 'smtp;451 4.7.1 greylisted' }, at / 1000),
		]);

		expect(res.status).toBe(200);
		const send = await readSend(t, sendId);
		// The send is UNMOVED: the relay still owns the message and its terminal edge.
		expect(send?.status).toBe('sent');
		expect(send?.deferralCountedDay).toBe(startOfDayUtc(at));

		const scheduled = await t.run(
			async (ctx: { db: DatabaseWriter }) =>
				await ctx.db.system.query('_scheduled_functions').collect()
		);
		expect(
			scheduled.some(
				(job: { name: string; args: unknown[] }) =>
					job.name.includes('recordOutcomeForSend') &&
					(job.args[0] as { event?: string })?.event === 'deferred'
			)
		).toBe(true);
	});

	it('`deferral` counts once per send per UTC day, however many arrive', async () => {
		const t = setupTest();
		const at = Date.UTC(2026, 7, 4, 12, 0, 0);
		await seedMandrillSend(t, { providerMessageId: 'm-defer', status: 'sent' });

		const deferral = event('deferral', { _id: 'm-defer' }, at / 1000);
		await postBatch(t, [deferral]);
		await postBatch(t, [deferral]);

		const outcomeWrites = await t.run(async (ctx: { db: DatabaseWriter }) =>
			(await ctx.db.system.query('_scheduled_functions').collect()).filter(
				(job: { name: string; args: unknown[] }) =>
					job.name.includes('recordOutcomeForSend') &&
					(job.args[0] as { event?: string })?.event === 'deferred'
			)
		);
		expect(outcomeWrites).toHaveLength(1);
	});

	it('`unsub` routes through the public one-click unsubscribe path', async () => {
		const t = setupTest();
		const { contactId, email } = await seedMandrillSend(t, {
			providerMessageId: 'm-unsub',
			status: 'sent',
		});
		const topicId = await t.run(async (ctx: { db: DatabaseWriter }) => {
			const id = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
			await ctx.db.insert('contactTopics', { contactId, topicId: id, addedAt: Date.now() });
			return id;
		});

		const res = await postBatch(t, [event('unsub', { _id: 'm-unsub', email })]);
		expect(res.status).toBe(200);

		const { contact, membership } = await t.run(async (ctx: { db: DatabaseWriter }) => ({
			contact: await ctx.db.get(contactId),
			membership: await ctx.db
				.query('contactTopics')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.first(),
		}));
		// The same three things a click on our own one-click link produces.
		expect(contact?.unsubscribedAt).toBeDefined();
		expect(membership).toBeNull();
		expect(topicId).toBeDefined();
	});

	it('`unsub` for an address with no contact acknowledges without crashing', async () => {
		const t = setupTest();
		const res = await postBatch(t, [event('unsub', { _id: 'm-x', email: 'nobody@example.com' })]);
		expect(res.status).toBe(200);
	});

	it('`reject` fails the send and carries the P2.2 suppression seam', async () => {
		const t = setupTest();
		const { sendId, email } = await seedMandrillSend(t, {
			providerMessageId: 'm-reject',
			status: 'queued',
		});
		const res = await postBatch(t, [
			event('reject', { _id: 'm-reject', email, state: 'rejected', reject_reason: 'hard-bounce' }),
		]);

		expect(res.status).toBe(200);
		const send = await readSend(t, sendId);
		expect(send?.status).toBe('failed');
		expect(send?.errorCode).toBe('MANDRILL_REJECT_HARD_BOUNCE');
		// `email.failed` applies NO suppression by itself — that is P2.2's job, and
		// the payload it needs is on the event.
		const parsedEvent = mapMandrillEvent({
			event: 'reject',
			ts: 1,
			msg: { _id: 'm-reject', email, reject_reason: 'hard-bounce' },
		});
		expect(parsedEvent).toMatchObject({
			kind: 'email.failed',
			recipient: email,
			errorCode: 'MANDRILL_REJECT_HARD_BOUNCE',
		});
	});

	it('acknowledges `open` and `click` without touching the send (D3)', async () => {
		const t = setupTest();
		const { sendId } = await seedMandrillSend(t, { providerMessageId: 'm-eng', status: 'sent' });
		const res = await postBatch(t, [
			event('open', { _id: 'm-eng' }),
			event('click', { _id: 'm-eng', url: 'https://example.com' }),
		]);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true, ignored: true });
		const send = await readSend(t, sendId);
		expect(send?.status).toBe('sent');
		expect(send?.openedAt).toBeUndefined();
	});
});

// ═══ 5. Adversarial ════════════════════════════════════════════════════════

describe('Mandrill webhook — adversarial', () => {
	it('acknowledges an event for an unknown _id without crashing', async () => {
		const t = setupTest();
		const res = await postBatch(t, [
			event('hard_bounce', { _id: 'never-sent-by-us', diag: 'smtp;550 user unknown' }),
		]);
		expect(res.status).toBe(200);
	});

	it('400s malformed JSON in mandrill_events', async () => {
		const t = setupTest();
		const body = new URLSearchParams({ mandrill_events: '[{"event":' }).toString();
		const res = await postRaw(t, body);
		expect(res.status).toBe(400);
	});

	it('400s a body with no mandrill_events parameter at all', async () => {
		const t = setupTest();
		const res = await postRaw(t, new URLSearchParams({ nonsense: '1' }).toString());
		expect(res.status).toBe(400);
	});

	it('400s a mandrill_events payload that is not an array', async () => {
		const t = setupTest();
		const body = new URLSearchParams({ mandrill_events: '{"event":"send"}' }).toString();
		const res = await postRaw(t, body);
		expect(res.status).toBe(400);
	});

	it('is idempotent under replay: a redelivered batch causes no second transition', async () => {
		const t = setupTest();
		const { sendId, email } = await seedMandrillSend(t, {
			providerMessageId: 'm-replay',
			status: 'sent',
		});
		const batch = [
			event('hard_bounce', {
				_id: 'm-replay',
				email,
				diag: 'smtp;550 5.1.1 user unknown',
			}),
		];

		const first = await postBatch(t, batch);
		const bouncedAt = (await readSend(t, sendId))?.bouncedAt;
		const second = await postBatch(t, batch);

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		const send = await readSend(t, sendId);
		expect(send?.status).toBe('bounced');
		expect(send?.bounceType).toBe('hard');
		expect(send?.bouncedAt).toBe(bouncedAt);

		const blocked = await t.run(
			async (ctx: { db: DatabaseWriter }) =>
				await ctx.db
					.query('blockedEmails')
					.withIndex('by_email', (q) => q.eq('email', email))
					.collect()
		);
		expect(blocked).toHaveLength(1);
	});

	it('skips unjoinable and unknown items inside an otherwise valid batch', async () => {
		const t = setupTest();
		const { sendId } = await seedMandrillSend(t, { providerMessageId: 'm-ok', status: 'sent' });
		const res = await postBatch(t, [
			{ type: 'blacklist', action: 'add', reject: { email: 'x@example.com' } },
			event('hard_bounce', { diag: 'no id at all' }),
			event('some_future_event', { _id: 'm-ok' }),
			event('spam', { _id: 'm-ok' }),
		]);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true, kind: 'email.complained' });
		expect((await readSend(t, sendId))?.status).toBe('complained');
	});

	it('processes a large batch without dropping the tail', async () => {
		const t = setupTest();
		const seeded = await Promise.all(
			Array.from({ length: 25 }, (_, i) =>
				seedMandrillSend(t, { providerMessageId: `bulk-${i}`, status: 'queued' })
			)
		);
		const res = await postBatch(
			t,
			seeded.map((_, i) => event('send', { _id: `bulk-${i}` }))
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true, processed: 25 });
		const statuses = await Promise.all(
			seeded.map(async (s) => (await readSend(t, s.sendId))?.status)
		);
		expect(statuses.every((s) => s === 'sent')).toBe(true);
	});
});

// ═══ 6. Pure mapping ═══════════════════════════════════════════════════════

describe('mapMandrillEvent / parseMandrillBatch', () => {
	it('converts Mandrill unix SECONDS into millisecond instants', () => {
		const mapped = mapMandrillEvent({ event: 'send', ts: 1_770_000_000, msg: { _id: 'm-1' } });
		expect(mapped).toMatchObject({ kind: 'email.sent', at: 1_770_000_000_000 });
	});

	it('keeps only the events Owlat acts on', () => {
		const events = parseMandrillBatch(
			formBody([
				event('open', { _id: 'm-1' }),
				event('click', { _id: 'm-1' }),
				event('send', { _id: 'm-1' }),
			])
		);
		expect(events.map((e) => e.kind)).toEqual(['email.sent']);
	});

	it('carries the richest diagnostic as the bounce message', () => {
		const mapped = mapMandrillEvent({
			event: 'soft_bounce',
			ts: 1,
			msg: { _id: 'm-1', bounce_description: 'mailbox_full', diag: 'smtp;452 over quota' },
		});
		expect(mapped).toMatchObject({ bounceMessage: 'smtp;452 over quota', bounceType: 'soft' });
	});

	/**
	 * `msg._id` IS THE ONLY JOIN KEY, and that is a constraint the D4 park depends
	 * on rather than an oversight (`delivery/sendCompletion.ts`).
	 *
	 * An ambiguous API timeout is exactly the case where the row never learned an
	 * `_id`, so nothing here can reattach it: Mandrill's `send-raw` takes no
	 * caller-supplied correlator that its webhooks echo back (`metadata` is a
	 * `messages/send` parameter — sending it on `send-raw` would be a guess whose
	 * failure mode is silence), and the rest of `msg` describes the recipient, not
	 * the send. Guessing from `email` would join whichever queued send to that
	 * address happened to be found. So an item with no `_id` is ACKNOWLEDGED and
	 * dropped, and the parked row waits out its deadline instead.
	 */
	it('joins on msg._id ALONE — never on the recipient, never on a guess', () => {
		const richButUnjoinable = {
			ts: 1,
			msg: { email: 'subscriber@example.com', state: 'sent', sender: 'news@example.com' },
		};
		for (const name of ['send', 'deferral', 'hard_bounce', 'soft_bounce', 'spam', 'reject']) {
			expect(mapMandrillEvent({ ...richButUnjoinable, event: name })).toBeNull();
		}
		// `unsub` is the documented exception: it is keyed by ADDRESS by design,
		// because it reports who left rather than which message did something.
		expect(mapMandrillEvent({ ...richButUnjoinable, event: 'unsub' })).toMatchObject({
			kind: 'email.unsubscribed',
			recipient: 'subscriber@example.com',
		});
	});

	it('normalizes a reject reason into a stable error code', () => {
		expect(
			mapMandrillEvent({
				event: 'reject',
				ts: 1,
				msg: { _id: 'm-1', reject_reason: 'invalid-sender' },
			})
		).toMatchObject({ errorCode: 'MANDRILL_REJECT_INVALID_SENDER' });
		expect(mapMandrillEvent({ event: 'reject', ts: 1, msg: { _id: 'm-1' } })).toMatchObject({
			errorCode: 'MANDRILL_REJECT',
		});
	});
});

describe('classifyMandrillBounce', () => {
	it('always trusts a hard_bounce', () => {
		expect(classifyMandrillBounce('hard_bounce', '')).toBe('hard');
		expect(classifyMandrillBounce('hard_bounce', 'try again later')).toBe('hard');
	});

	it('takes a soft_bounce at its word for genuinely transient text', () => {
		expect(classifyMandrillBounce('soft_bounce', 'smtp;452 mailbox full')).toBe('soft');
		expect(classifyMandrillBounce('soft_bounce', 'greylisted, try again')).toBe('soft');
		expect(classifyMandrillBounce('soft_bounce', '')).toBe('soft');
	});

	it('hardens a soft_bounce whose diagnostic is unambiguously permanent', () => {
		expect(classifyMandrillBounce('soft_bounce', 'smtp;550 5.1.1 user unknown')).toBe('hard');
		expect(classifyMandrillBounce('soft_bounce', 'mailbox unavailable')).toBe('hard');
	});
});
