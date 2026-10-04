/**
 * Mandrill replay safety (#1228).
 *
 * Mandrill signs a webhook with no timestamp and gives an event no id, so the
 * same signed batch verifies every time it arrives. Two events act on an
 * ADDRESS whatever the Send's state — `reject` mirrors a suppression into the
 * blocklist, `unsub` unsubscribes a contact — and replayed after an operator
 * unblocked the address, or after the contact re-subscribed, either one used to
 * undo that decision.
 *
 * Every case drives the REAL route (`t.fetch('/webhooks/mandrill')`, signed
 * byte-for-byte from Mandrill's documentation) and asserts on the database,
 * except the claim protocol's failure paths, which need a handler that throws.
 */

import { convexTest } from 'convex-test';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import type { ActionCtx, DatabaseWriter } from '../../_generated/server';
import { modules } from '../../__tests__/testModules';
import {
	createTestCampaign,
	createTestContact,
	createTestEmailSend,
	createTestTopic,
} from '../../__tests__/factories';
import { mandrillReplayKey, mapMandrillEvent } from '../adapters/mandrill';
import { INBOUND_REPLAY_WINDOW_MS } from '../types';
import { dispatchOnce, IN_FLIGHT_LEASE_MS, InboundEventInFlightError } from '../inboundEventClaims';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../../lib/sessionOrganization')>(
		'../../lib/sessionOrganization'
	);
	const session = () => ({ userId: 'operator-1', role: 'admin' as const });
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session()),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('operator-1'),
		getMutationContext: vi.fn(async () => session()),
		requireOrgPermission: vi.fn(async () => session()),
	};
});

const operator = { subject: 'operator-1', tokenIdentifier: 'test|operator-1' };
const WEBHOOK_KEY = 'mandrill-test-webhook-key';
const SITE_URL = 'https://owlat.example.convex.site';
const PATH = '/webhooks/mandrill';
const MINUTE = 60_000;

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

async function postBatch(t: Harness, events: unknown[]): Promise<Response> {
	const body = new URLSearchParams({ mandrill_events: JSON.stringify(events) }).toString();
	const params = new URLSearchParams(body);
	let base = `${SITE_URL}${PATH}`;
	for (const name of [...params.keys()].sort()) base += name + params.get(name);
	return await t.fetch(PATH, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'X-Mandrill-Signature': await hmacSha1Base64(WEBHOOK_KEY, base),
		},
		body,
	});
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

/** A Mandrill event stamped `ageMs` before now, in Mandrill's whole seconds. */
function event(name: string, msg: Record<string, unknown>, ageMs = MINUTE) {
	const ts = Math.floor((Date.now() - ageMs) / 1000);
	return { event: name, ts, msg: { ts, ...msg } };
}

async function seedSend(t: Harness, providerMessageId: string, email: string) {
	return await t.run(async (ctx: { db: DatabaseWriter }) => {
		const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
		const contactId = await ctx.db.insert('contacts', createTestContact({ email }));
		const sendId = await ctx.db.insert(
			'emailSends',
			createTestEmailSend({
				campaignId,
				contactId,
				contactEmail: email,
				status: 'queued',
				providerType: 'mandrill',
				providerMessageId,
				sentAt: Date.now(),
			})
		);
		return { contactId, sendId };
	});
}

async function blockRows(t: Harness, email: string) {
	return await t.run(
		async (ctx: { db: DatabaseWriter }) =>
			await ctx.db
				.query('blockedEmails')
				.withIndex('by_email', (q) => q.eq('email', email))
				.collect()
	);
}

/** The operator's "Remove" on the suppression screen, through the real mutation. */
async function removeByOperator(t: Harness, email: string, removedAgoMs = 0) {
	const [row] = await blockRows(t, email);
	if (!row) throw new Error(`${email} is not blocked`);
	await t.withIdentity(operator).mutation(api.blockedEmails.remove, { blockedEmailId: row._id });
	if (removedAgoMs === 0) return;
	await t.run(async (ctx: { db: DatabaseWriter }) => {
		const entry = await ctx.db
			.query('auditLogs')
			.withIndex('by_action_and_created_at', (q) => q.eq('action', 'blocklist.removed'))
			.order('desc')
			.first();
		await ctx.db.patch(entry!._id, { createdAt: Date.now() - removedAgoMs });
	});
}

async function blockNow(t: Harness, email: string) {
	await t.mutation(internal.blockedEmails.addFromEvent, { email, reason: 'bounced' });
}

const reject = (id: string, email: string, ageMs?: number) =>
	event('reject', { _id: id, email, state: 'rejected', reject_reason: 'hard-bounce' }, ageMs);

async function claimRows(t: Harness) {
	return await t.run(
		async (ctx: { db: DatabaseWriter }) => await ctx.db.query('inboundEventClaims').collect()
	);
}

// ═══ reject vs. an operator's removal ═════════════════════════════════════

describe('a reject never undoes an operator removal it predates', () => {
	it('ignores a replayed reject batch after the operator unblocked the address', async () => {
		const t = setupTest();
		const email = 'replayed@example.com';
		await seedSend(t, 'm-replay', email);
		const batch = [reject('m-replay', email)];

		expect((await postBatch(t, batch)).status).toBe(200);
		expect(await blockRows(t, email)).toHaveLength(1);
		await removeByOperator(t, email);

		expect((await postBatch(t, batch)).status).toBe(200);
		expect(await blockRows(t, email)).toHaveLength(0);
	});

	it('keeps the address unblocked when an older reject arrives late, and still fails the Send', async () => {
		const t = setupTest();
		const email = 'late@example.com';
		const { sendId } = await seedSend(t, 'm-late', email);
		await blockNow(t, email);
		await removeByOperator(t, email);

		// First delivery of an event Mandrill stamped two minutes BEFORE the removal.
		expect((await postBatch(t, [reject('m-late', email, 2 * MINUTE)])).status).toBe(200);

		expect(await blockRows(t, email)).toHaveLength(0);
		const send = await t.run(async (ctx: { db: DatabaseWriter }) => await ctx.db.get(sendId));
		expect(send?.status).toBe('failed');
		expect(send?.errorCode).toBe('MANDRILL_REJECT_HARD_BOUNCE');
	});

	it('still applies a reject newer than the removal', async () => {
		const t = setupTest();
		const email = 'newer@example.com';
		await seedSend(t, 'm-newer', email);
		await blockNow(t, email);
		await removeByOperator(t, email, 10 * MINUTE);

		await postBatch(t, [reject('m-newer', email, MINUTE)]);

		expect(await blockRows(t, email)).toHaveLength(1);
	});

	it('only consults removals of the same address', async () => {
		const t = setupTest();
		await blockNow(t, 'other@example.com');
		await removeByOperator(t, 'other@example.com');
		await seedSend(t, 'm-unrelated', 'mine@example.com');

		await postBatch(t, [reject('m-unrelated', 'mine@example.com', 2 * MINUTE)]);

		expect(await blockRows(t, 'mine@example.com')).toHaveLength(1);
	});

	it('suppresses nobody for a reject older than the replay window, but fails the Send', async () => {
		const t = setupTest();
		const email = 'stale@example.com';
		const { sendId } = await seedSend(t, 'm-stale', email);

		await postBatch(t, [reject('m-stale', email, INBOUND_REPLAY_WINDOW_MS + MINUTE)]);

		expect(await blockRows(t, email)).toHaveLength(0);
		const send = await t.run(async (ctx: { db: DatabaseWriter }) => await ctx.db.get(sendId));
		expect(send?.status).toBe('failed');
		expect(await claimRows(t)).toHaveLength(0);
	});
});

// ═══ unsub vs. a re-subscribe ══════════════════════════════════════════════

async function seedSubscribed(t: Harness, email: string, addedAgoMs = 30 * MINUTE) {
	return await t.run(async (ctx: { db: DatabaseWriter }) => {
		const contactId = await ctx.db.insert('contacts', createTestContact({ email }));
		const topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
		await ctx.db.insert('contactTopics', {
			contactId,
			topicId,
			addedAt: Date.now() - addedAgoMs,
		});
		return { contactId, topicId };
	});
}

async function resubscribe(t: Harness, contactId: Id<'contacts'>, topicId: Id<'topics'>) {
	await t.mutation(internal.topics.subscription.subscribe, {
		contactId,
		topicId,
		source: 'admin',
		skipDoi: true,
	});
}

async function subscriptionState(t: Harness, contactId: Id<'contacts'>) {
	return await t.run(async (ctx: { db: DatabaseWriter }) => ({
		unsubscribedAt: (await ctx.db.get(contactId))?.unsubscribedAt,
		topicIds: (
			await ctx.db
				.query('contactTopics')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.collect()
		).map((membership) => membership.topicId),
	}));
}

const unsub = (id: string, email: string, ageMs?: number) =>
	event('unsub', { _id: id, email }, ageMs);

describe('an unsub never undoes a re-subscribe it predates', () => {
	it('ignores a replayed unsub batch after the contact re-subscribed', async () => {
		const t = setupTest();
		const email = 'comeback@example.com';
		const { contactId, topicId } = await seedSubscribed(t, email);
		const batch = [unsub('m-unsub', email)];

		await postBatch(t, batch);
		expect((await subscriptionState(t, contactId)).unsubscribedAt).toBeDefined();
		await resubscribe(t, contactId, topicId);

		expect((await postBatch(t, batch)).status).toBe(200);
		expect(await subscriptionState(t, contactId)).toEqual({
			unsubscribedAt: undefined,
			topicIds: [topicId],
		});
	});

	it('keeps a contact subscribed when an older unsub arrives late', async () => {
		const t = setupTest();
		const email = 'resubscribed@example.com';
		// Subscribed just now, after the event Mandrill stamped two minutes ago.
		const { contactId, topicId } = await seedSubscribed(t, email, 0);

		await postBatch(t, [unsub('m-late-unsub', email, 2 * MINUTE)]);

		expect(await subscriptionState(t, contactId)).toEqual({
			unsubscribedAt: undefined,
			topicIds: [topicId],
		});
	});

	it('ignores an older unsub after a double opt-in confirmed since', async () => {
		const t = setupTest();
		const email = 'confirmed@example.com';
		const { contactId, topicId } = await seedSubscribed(t, email);
		await t.run(async (ctx: { db: DatabaseWriter }) => {
			await ctx.db.patch(contactId, { doiStatus: 'confirmed', doiConfirmedAt: Date.now() });
		});

		await postBatch(t, [unsub('m-doi', email, 2 * MINUTE)]);

		expect((await subscriptionState(t, contactId)).topicIds).toEqual([topicId]);
	});

	it('still removes what the contact was on when they left, keeping later subscriptions', async () => {
		const t = setupTest();
		const email = 'partial@example.com';
		const { contactId, topicId: before } = await seedSubscribed(t, email, 30 * MINUTE);
		const after = await t.run(async (ctx: { db: DatabaseWriter }) => {
			const id = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
			await ctx.db.insert('contactTopics', { contactId, topicId: id, addedAt: Date.now() });
			return id;
		});

		await postBatch(t, [unsub('m-partial', email, 2 * MINUTE)]);

		const state = await subscriptionState(t, contactId);
		expect(state.topicIds).toEqual([after]);
		expect(state.topicIds).not.toContain(before);
		expect(state.unsubscribedAt).toBeUndefined();
	});

	it('still applies an unsub newer than every subscription', async () => {
		const t = setupTest();
		const email = 'leaving@example.com';
		const { contactId } = await seedSubscribed(t, email, 30 * MINUTE);

		await postBatch(t, [unsub('m-fresh', email, MINUTE)]);

		const state = await subscriptionState(t, contactId);
		expect(state.unsubscribedAt).toBeDefined();
		expect(state.topicIds).toEqual([]);
	});

	it('drops an unsub older than the replay window', async () => {
		const t = setupTest();
		const email = 'old-unsub@example.com';
		const { contactId, topicId } = await seedSubscribed(t, email, 3 * INBOUND_REPLAY_WINDOW_MS);

		await postBatch(t, [unsub('m-old', email, INBOUND_REPLAY_WINDOW_MS + MINUTE)]);

		expect(await subscriptionState(t, contactId)).toEqual({
			unsubscribedAt: undefined,
			topicIds: [topicId],
		});
	});
});

// ═══ spam ═════════════════════════════════════════════════════════════════

describe('a replayed spam event', () => {
	it('is applied once: an unresolved complaint is not counted again', async () => {
		const t = setupTest();
		const batch = [event('spam', { _id: 'm-not-ours', email: 'someone@example.com' })];

		await postBatch(t, batch);
		await postBatch(t, batch);

		const rows = await t.run(
			async (ctx: { db: DatabaseWriter }) => await ctx.db.query('unresolvedFeedback').collect()
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.occurrences).toBe(1);
	});
});

// ═══ the replay key ═══════════════════════════════════════════════════════

describe('mandrillReplayKey', () => {
	const now = Date.UTC(2026, 9, 4, 12, 0, 0);
	const ts = now / 1000 - 60;

	it('is derived from the event, the message id and ts, and holds no address', () => {
		const key = mandrillReplayKey(
			{ event: 'reject', ts, msg: { _id: 'abc123', email: 'person@example.com' } },
			now
		);
		expect(key).toBe(`mandrill:reject:abc123:${ts * 1000}`);
		expect(key).not.toContain('person');
		expect(key).not.toContain('@');
	});

	it('differs per event name for one message', () => {
		const msg = { _id: 'abc123' };
		expect(mandrillReplayKey({ event: 'reject', ts, msg }, now)).not.toBe(
			mandrillReplayKey({ event: 'unsub', ts, msg }, now)
		);
	});

	it('is absent without a ts, outside the window, from the future, or for an odd id', () => {
		const msg = { _id: 'abc123' };
		expect(mandrillReplayKey({ event: 'reject', msg }, now)).toBeUndefined();
		const stale = (now - INBOUND_REPLAY_WINDOW_MS - 1000) / 1000;
		expect(mandrillReplayKey({ event: 'reject', ts: stale, msg }, now)).toBeUndefined();
		expect(mandrillReplayKey({ event: 'reject', ts: now / 1000 + 3600, msg }, now)).toBeUndefined();
		expect(
			mandrillReplayKey({ event: 'reject', ts, msg: { _id: 'not an id@example.com' } }, now)
		).toBeUndefined();
	});

	it('maps an unstamped unsub to nothing and an unstamped reject without its suppression', () => {
		expect(mapMandrillEvent({ event: 'unsub', msg: { _id: 'a1', email: 'x@example.com' } })).toBe(
			null
		);
		const failed = mapMandrillEvent({
			event: 'reject',
			msg: { _id: 'a1', email: 'x@example.com', reject_reason: 'hard-bounce' },
		});
		expect(failed).toMatchObject({ kind: 'email.failed' });
		expect(failed).not.toHaveProperty('suppression');
		expect(failed).not.toHaveProperty('replayKey');
	});
});

// ═══ the claim protocol ═══════════════════════════════════════════════════

function actionCtx(t: Harness): ActionCtx {
	// The real mutations behind the action-side helper, run against this harness.
	const runMutation = t.mutation.bind(t);
	return { runMutation } as unknown as ActionCtx;
}

describe('inbound event claims', () => {
	const guard = () => ({ replayKey: 'mandrill:unsub:m1:1', eventAt: Date.now() });

	it('applies a key once', async () => {
		const t = setupTest();
		const apply = vi.fn(async () => 'applied');
		const g = guard();

		expect(await dispatchOnce(actionCtx(t), g, apply)).toBe('applied');
		expect(await dispatchOnce(actionCtx(t), g, apply)).toBeUndefined();
		expect(apply).toHaveBeenCalledTimes(1);
	});

	it('gives the claim back when the handler throws, so the redelivery applies', async () => {
		const t = setupTest();
		const g = guard();
		await expect(
			dispatchOnce(actionCtx(t), g, async () => {
				throw new Error('transient');
			})
		).rejects.toThrow('transient');

		const apply = vi.fn(async () => 'applied');
		expect(await dispatchOnce(actionCtx(t), g, apply)).toBe('applied');
	});

	it('fails a copy retryably while its twin is still in flight, then takes over a dead lease', async () => {
		const t = setupTest();
		const g = guard();
		expect(await t.mutation(internal.webhooks.inboundEventClaims.claim, g)).toBe('claimed');

		await expect(dispatchOnce(actionCtx(t), g, async () => 'x')).rejects.toBeInstanceOf(
			InboundEventInFlightError
		);

		await t.run(async (ctx: { db: DatabaseWriter }) => {
			const [row] = await ctx.db.query('inboundEventClaims').collect();
			await ctx.db.patch(row!._id, { claimedAt: Date.now() - IN_FLIGHT_LEASE_MS - 1 });
		});
		expect(await dispatchOnce(actionCtx(t), g, async () => 'taken over')).toBe('taken over');
	});

	it('stays bounded: claims expire one window after their event and are swept', async () => {
		const t = setupTest();
		const old = Date.now() - INBOUND_REPLAY_WINDOW_MS - MINUTE;
		for (let i = 0; i < 5; i++) {
			await t.mutation(internal.webhooks.inboundEventClaims.claim, {
				replayKey: `mandrill:spam:old${i}:1`,
				eventAt: old,
			});
		}
		await t.mutation(internal.webhooks.inboundEventClaims.claim, guard());
		// The hot path swept the expired rows it found before inserting.
		expect((await claimRows(t)).map((row) => row.replayKey)).toEqual(['mandrill:unsub:m1:1']);

		await t.run(async (ctx: { db: DatabaseWriter }) => {
			await ctx.db.insert('inboundEventClaims', {
				replayKey: 'mandrill:spam:left-behind:1',
				eventAt: old,
				claimedAt: old,
				expiresAt: old + INBOUND_REPLAY_WINDOW_MS,
				status: 'completed',
			});
		});
		const swept = await t.mutation(internal.webhooks.inboundEventClaims.cleanupExpired, {});
		expect(swept.deletedCount).toBe(1);
		expect((await claimRows(t)).map((row) => row.replayKey)).toEqual(['mandrill:unsub:m1:1']);
	});
});
