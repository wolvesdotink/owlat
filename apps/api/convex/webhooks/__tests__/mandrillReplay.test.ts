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
import { MAX_EVENTS_PER_BATCH, mandrillReplayKey, mapMandrillEvent } from '../adapters/mandrill';
import { AUDIT_LOG_RETENTION_MS } from '../../lib/constants';
import { INBOUND_REPLAY_WINDOW_MS } from '../types';
import { dispatchOnce, IN_FLIGHT_LEASE_MS, InboundEventInFlightError } from '../inboundEventClaims';
import type * as SessionOrganization from '../../lib/sessionOrganization';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof SessionOrganization>('../../lib/sessionOrganization');
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

	it('still mirrors a reject older than the dedupe window when nobody removed the address', async () => {
		const t = setupTest();
		const email = 'manual-replay@example.com';
		await seedSend(t, 'm-week-old', email);

		// A failed batch an operator replays by hand a week later.
		await postBatch(t, [reject('m-week-old', email, INBOUND_REPLAY_WINDOW_MS + MINUTE)]);

		expect(await blockRows(t, email)).toHaveLength(1);
		expect(await claimRows(t)).toHaveLength(0);
	});

	it('refuses a re-add from a reject older than the audit retention, but fails the Send', async () => {
		const t = setupTest();
		const email = 'ancient@example.com';
		const { sendId } = await seedSend(t, 'm-ancient', email);

		// Removals that old are purged, so their absence proves nothing.
		await postBatch(t, [reject('m-ancient', email, AUDIT_LOG_RETENTION_MS + MINUTE)]);

		expect(await blockRows(t, email)).toHaveLength(0);
		const send = await t.run(async (ctx: { db: DatabaseWriter }) => await ctx.db.get(sendId));
		expect(send?.status).toBe('failed');
	});

	it('treats a sunset restore from the Remove button as an operator removal', async () => {
		const t = setupTest();
		const email = 'sunset@example.com';
		const blockedEmailId = await t.run(async (ctx: { db: DatabaseWriter }) => {
			await ctx.db.insert('contacts', createTestContact({ email, sunsetStage: 'suppressed' }));
			return await ctx.db.insert('blockedEmails', {
				email,
				reason: 'unengaged',
				createdAt: Date.now() - 60 * MINUTE,
			});
		});
		await t.withIdentity(operator).mutation(api.blockedEmails.remove, { blockedEmailId });
		expect(await blockRows(t, email)).toHaveLength(0);

		await seedSend(t, 'm-sunset', email);
		await postBatch(t, [reject('m-sunset', email, 2 * MINUTE)]);

		expect(await blockRows(t, email)).toHaveLength(0);
	});
});

// ═══ the same-second rule ══════════════════════════════════════════════════
//
// Mandrill stamps whole seconds, Owlat millis. An event stamped T0 happened in
// [T0, T0 + 1 s), so anything in that second counts as BEFORE the event and
// only the next second counts as after it.

const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);

describe('a tie inside the event second goes to the event', () => {
	let clock: ReturnType<typeof vi.spyOn> | undefined;
	beforeEach(() => {
		clock = vi.spyOn(Date, 'now').mockReturnValue(T0 + 10_000);
	});
	afterEach(() => clock?.mockRestore());

	async function contactWith(
		t: Harness,
		email: string,
		fields: { addedAt?: number; doiConfirmedAt?: number }
	) {
		return await t.run(async (ctx: { db: DatabaseWriter }) => {
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({
					email,
					...(fields.doiConfirmedAt !== undefined
						? { doiStatus: 'confirmed' as const, doiConfirmedAt: fields.doiConfirmedAt }
						: {}),
				})
			);
			const topicId = await ctx.db.insert('topics', createTestTopic());
			await ctx.db.insert('contactTopics', {
				contactId,
				topicId,
				addedAt: fields.addedAt ?? T0 - 60_000,
			});
			return contactId;
		});
	}

	const unsubAt = (t: Harness, email: string) =>
		t.mutation(internal.delivery.unsubscribeQueries.processUnsubscribeByEmail, {
			email,
			eventAt: T0,
		});

	it.each([
		['a subscription', { addedAt: T0 + 100 }],
		['a subscription at the last millisecond', { addedAt: T0 + 999 }],
		['a DOI confirmation', { doiConfirmedAt: T0 + 100 }],
	])('unsubscribes after %s in the same second', async (_label, fields) => {
		const t = setupTest();
		const contactId = await contactWith(t, 'tie@example.com', fields);

		expect(await unsubAt(t, 'tie@example.com')).not.toHaveProperty('skipped');
		const contact = await t.run(async (ctx: { db: DatabaseWriter }) => await ctx.db.get(contactId));
		expect(contact?.unsubscribedAt).toBeDefined();
	});

	it.each([
		['a subscription', { addedAt: T0 + 1000 }],
		['a DOI confirmation', { doiConfirmedAt: T0 + 1000 }],
	])('keeps %s from the next second', async (_label, fields) => {
		const t = setupTest();
		await contactWith(t, 'next@example.com', fields);

		expect(await unsubAt(t, 'next@example.com')).toEqual({
			success: true,
			skipped: 'resubscribed_after_event',
		});
	});

	it('re-adds after a removal in the same second, and not after one in the next', async () => {
		const t = setupTest();
		for (const [email, removedAt] of [
			['same-second@example.com', T0 + 500],
			['next-second@example.com', T0 + 1000],
		] as const) {
			await blockNow(t, email);
			clock?.mockReturnValue(removedAt);
			await removeByOperator(t, email);
			clock?.mockReturnValue(T0 + 10_000);
			await t.mutation(internal.blockedEmails.addFromEvent, {
				email,
				reason: 'bounced',
				eventAt: T0,
			});
		}

		expect(await blockRows(t, 'same-second@example.com')).toHaveLength(1);
		expect(await blockRows(t, 'next-second@example.com')).toHaveLength(0);
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

	it('applies an unsub older than the dedupe window under the same guard', async () => {
		const t = setupTest();
		const left = await seedSubscribed(t, 'left@example.com', 3 * INBOUND_REPLAY_WINDOW_MS);
		const back = await seedSubscribed(t, 'back@example.com', 0);
		const age = INBOUND_REPLAY_WINDOW_MS + MINUTE;

		await postBatch(t, [
			unsub('m-old-left', 'left@example.com', age),
			unsub('m-old-back', 'back@example.com', age),
		]);

		expect((await subscriptionState(t, left.contactId)).topicIds).toEqual([]);
		expect(await subscriptionState(t, back.contactId)).toEqual({
			unsubscribedAt: undefined,
			topicIds: [back.topicId],
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

	it("refuses a batch over Mandrill's documented 1,000 events", async () => {
		const t = setupTest();
		const events = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, (_, i) =>
			event('open', { _id: `m-${i}` })
		);
		expect((await postBatch(t, events)).status).toBe(400);
		expect((await postBatch(t, events.slice(1))).status).toBe(200);
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
		expect(await t.mutation(internal.webhooks.inboundEventClaims.claim, g)).toMatchObject({
			result: 'claimed',
		});

		await expect(dispatchOnce(actionCtx(t), g, async () => 'x')).rejects.toBeInstanceOf(
			InboundEventInFlightError
		);

		await t.run(async (ctx: { db: DatabaseWriter }) => {
			const [row] = await ctx.db.query('inboundEventClaims').collect();
			await ctx.db.patch(row!._id, { claimedAt: Date.now() - IN_FLIGHT_LEASE_MS - 1 });
		});
		expect(await dispatchOnce(actionCtx(t), g, async () => 'taken over')).toBe('taken over');
	});

	it('outlasts the longest action: the lease is longer than the 30-minute V8 action limit', () => {
		expect(IN_FLIGHT_LEASE_MS).toBeGreaterThan(30 * MINUTE);
	});

	it("does not let a taken-over worker release or complete its successor's claim", async () => {
		const t = setupTest();
		const clock = vi.spyOn(Date, 'now').mockReturnValue(T0);
		try {
			const g = { replayKey: 'mandrill:spam:live:1', eventAt: T0 };
			let entered!: () => void;
			const inside = new Promise<void>((resolve) => (entered = resolve));
			let fail!: (err: Error) => void;
			const gate = new Promise<void>((_, reject) => (fail = reject));
			const a = dispatchOnce(actionCtx(t), g, async () => {
				entered();
				await gate;
			});
			const aFailed = expect(a).rejects.toThrow('A failed');
			await inside;

			clock.mockReturnValue(T0 + IN_FLIGHT_LEASE_MS + 1);
			const b = await t.mutation(internal.webhooks.inboundEventClaims.claim, g);
			expect(b).toMatchObject({ result: 'claimed' });
			fail(new Error('A failed'));
			await aFailed;

			// A's release did not erase B's claim...
			expect(await t.mutation(internal.webhooks.inboundEventClaims.claim, g)).toEqual({
				result: 'duplicate_in_flight',
			});
			// ...and a stale token cannot complete it either.
			await t.mutation(internal.webhooks.inboundEventClaims.complete, {
				replayKey: g.replayKey,
				token: 'not-the-owner',
			});
			expect((await claimRows(t))[0]?.status).toBe('in_flight');
		} finally {
			clock.mockRestore();
		}
	});

	it('stays exclusive when the event window closes while the claim is in flight', async () => {
		const t = setupTest();
		const clock = vi.spyOn(Date, 'now').mockReturnValue(T0);
		try {
			// Both copies were parsed while the event was fresh, a second before the
			// window closed; the second dispatches after it.
			const g = {
				replayKey: 'mandrill:spam:edge:1',
				eventAt: T0 - INBOUND_REPLAY_WINDOW_MS + 1000,
			};
			let applied = 0;
			let entered!: () => void;
			const inside = new Promise<void>((resolve) => (entered = resolve));
			let finish!: () => void;
			const gate = new Promise<void>((resolve) => (finish = resolve));
			const a = dispatchOnce(actionCtx(t), g, async () => {
				applied++;
				entered();
				await gate;
			});
			await inside;

			clock.mockReturnValue(T0 + 1500);
			await expect(
				dispatchOnce(actionCtx(t), g, async () => {
					applied++;
				})
			).rejects.toBeInstanceOf(InboundEventInFlightError);
			finish();
			await a;

			// And once A completed, a late copy is a duplicate, not a fresh claim.
			clock.mockReturnValue(T0 + IN_FLIGHT_LEASE_MS - 1000);
			expect(
				await dispatchOnce(actionCtx(t), g, async () => {
					applied++;
				})
			).toBeUndefined();
			expect(applied).toBe(1);
		} finally {
			clock.mockRestore();
		}
	});

	it('stays bounded: expired claims are swept, never one a live run holds', async () => {
		const t = setupTest();
		const now = Date.now();
		const expiredAt = now - MINUTE;
		await t.run(async (ctx: { db: DatabaseWriter }) => {
			for (let i = 0; i < 3; i++) {
				await ctx.db.insert('inboundEventClaims', {
					replayKey: `mandrill:spam:done${i}:1`,
					token: `t${i}`,
					eventAt: expiredAt - INBOUND_REPLAY_WINDOW_MS - IN_FLIGHT_LEASE_MS,
					claimedAt: expiredAt - IN_FLIGHT_LEASE_MS,
					expiresAt: expiredAt,
					status: 'completed',
				});
			}
			await ctx.db.insert('inboundEventClaims', {
				replayKey: 'mandrill:spam:abandoned:1',
				token: 'dead',
				eventAt: expiredAt - INBOUND_REPLAY_WINDOW_MS,
				claimedAt: now - IN_FLIGHT_LEASE_MS - 1,
				expiresAt: expiredAt,
				status: 'in_flight',
			});
			await ctx.db.insert('inboundEventClaims', {
				replayKey: 'mandrill:spam:running:1',
				token: 'live',
				eventAt: expiredAt - INBOUND_REPLAY_WINDOW_MS,
				claimedAt: now - MINUTE,
				expiresAt: expiredAt,
				status: 'in_flight',
			});
		});

		// The claim hot path sweeps what it may before inserting its own row.
		await t.mutation(internal.webhooks.inboundEventClaims.claim, guard());
		expect((await claimRows(t)).map((row) => row.replayKey).sort()).toEqual([
			'mandrill:spam:running:1',
			'mandrill:unsub:m1:1',
		]);

		await t.run(async (ctx: { db: DatabaseWriter }) => {
			await ctx.db.insert('inboundEventClaims', {
				replayKey: 'mandrill:spam:left-behind:1',
				token: 'old',
				eventAt: expiredAt - INBOUND_REPLAY_WINDOW_MS - IN_FLIGHT_LEASE_MS,
				claimedAt: expiredAt - IN_FLIGHT_LEASE_MS,
				expiresAt: expiredAt,
				status: 'completed',
			});
		});
		const swept = await t.mutation(internal.webhooks.inboundEventClaims.cleanupExpired, {});
		expect(swept.deletedCount).toBe(1);
		expect((await claimRows(t)).map((row) => row.replayKey).sort()).toEqual([
			'mandrill:spam:running:1',
			'mandrill:unsub:m1:1',
		]);
	});
});
