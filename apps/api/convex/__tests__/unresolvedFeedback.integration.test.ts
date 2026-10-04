/**
 * Bounces and complaints whose message id matches no send are kept (#1194).
 *
 * They used to be logged and dropped. These tests pin what happens to them now:
 * one stored row per event, a replay that applies the ordinary transition once
 * the id resolves and then never again, automatic replays that stop, a purge
 * at the retention horizon, an operator count, and rows that hold no address.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestConvex } from 'convex-test';
import type schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { createTestCampaign, createTestContact, createTestEmailSend } from './factories';
import { newHarness } from './testModules';
import { dispatchInboundEvent } from '../webhooks/dispatcher';
import type { ActionCtx } from '../_generated/server';
import type { InboundEvent, InboundEventOf } from '../webhooks/types';
import { AUTOMATIC_REPLAY_ATTEMPTS, RETENTION_MS } from '../webhooks/unresolvedFeedback';

type T = TestConvex<typeof schema>;

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** Run an inbound event through the real dispatcher on the harness's mutations. */
function dispatch(t: T, event: InboundEvent): Promise<void> {
	const actionCtx = {
		runMutation: (mutation: Parameters<ActionCtx['runMutation']>[0], args: unknown) =>
			t.mutation(mutation, args as never),
	} as unknown as ActionCtx;
	return dispatchInboundEvent(actionCtx, event);
}

async function rows(t: T) {
	return await t.run(async (ctx) => await ctx.db.query('unresolvedFeedback').collect());
}

async function blockedReason(t: T, email: string) {
	return await t.run(async (ctx) => {
		const row = await ctx.db
			.query('blockedEmails')
			.withIndex('by_email', (q) => q.eq('email', email))
			.first();
		return row?.reason ?? null;
	});
}

/** A sent campaign Send, with or without its provider id. */
async function seedSentSend(
	t: T,
	providerMessageId: string | undefined
): Promise<{ campaignId: Id<'campaigns'>; sendId: Id<'emailSends'>; email: string }> {
	return await t.run(async (ctx) => {
		const campaignId = await ctx.db.insert('campaigns', createTestCampaign({ status: 'sending' }));
		const contact = createTestContact();
		const contactId = await ctx.db.insert('contacts', contact);
		const sendId = await ctx.db.insert(
			'emailSends',
			createTestEmailSend({
				campaignId,
				contactId,
				contactEmail: contact.email,
				status: 'sent',
				sentAt: Date.now(),
				providerType: 'ses',
				providerMessageId,
			})
		);
		return { campaignId, sendId, email: contact.email };
	});
}

async function statsBounced(t: T, campaignId: Id<'campaigns'>): Promise<number> {
	return await t.run(async (ctx) => {
		const shards = await ctx.db
			.query('campaignStatShards')
			.withIndex('by_campaign_and_shard', (q) => q.eq('campaignId', campaignId))
			.collect();
		return shards.reduce((sum, shard) => sum + (shard.statsBounced ?? 0), 0);
	});
}

const orphanBounce = (providerMessageId: string): InboundEventOf<'email.bounced'> => ({
	kind: 'email.bounced',
	providerMessageId,
	at: Date.now(),
	bounceType: 'hard',
	bounceMessage: 'smtp; 550 5.1.1 user unknown',
	providerType: 'ses',
});

describe('storing unresolved feedback', () => {
	it('stores an unknown-id bounce and suppresses nothing', async () => {
		const t = newHarness();
		await dispatch(t, orphanBounce('ses-ghost'));

		const [row, ...rest] = await rows(t);
		expect(rest).toHaveLength(0);
		expect(row).toMatchObject({
			kind: 'bounce',
			providerMessageId: 'ses-ghost',
			providerType: 'ses',
			bounceType: 'hard',
			bounceStatusCode: '5.1.1',
			suppression: 'not_applicable',
			status: 'open',
			occurrences: 1,
			replayAttempts: 0,
		});
		expect(await t.run(async (ctx) => await ctx.db.query('blockedEmails').collect())).toEqual([]);
	});

	it('blocks the complainer of an unknown-id complaint attributed to this deployment, and stores it', async () => {
		const t = newHarness();
		await dispatch(t, {
			kind: 'email.complained',
			providerMessageId: 'mta-ghost',
			recipient: 'Complainer@Example.com',
			providerType: 'mta',
			deliveryDomain: 'production',
			at: Date.now(),
		});

		expect(await blockedReason(t, 'complainer@example.com')).toBe('complained');
		expect(await rows(t)).toEqual([
			expect.objectContaining({
				kind: 'complaint',
				suppression: 'suppressed',
			}),
		]);
	});

	it('stores but blocks no one for a foreign or unattributed complaint', async () => {
		// Another deployment's mail, reported through a shared SES account: the
		// signature is genuine, the id matches nothing here, and nothing in the
		// event proves this deployment sent it.
		const t = newHarness();
		await dispatch(t, {
			kind: 'email.complained',
			providerMessageId: 'ses-foreign',
			recipient: 'someone@example.com',
			providerType: 'ses',
			at: Date.now(),
		});

		expect(await blockedReason(t, 'someone@example.com')).toBeNull();
		expect(await rows(t)).toEqual([
			expect.objectContaining({
				kind: 'complaint',
				suppression: 'unattributed',
			}),
		]);
	});

	it('stores but does not suppress an unknown-id complaint that fails the provenance rule', async () => {
		const t = newHarness();
		await dispatch(t, {
			kind: 'email.complained',
			providerMessageId: 'mta-ghost',
			recipient: 'preview@example.com',
			providerType: 'mta',
			deliveryDomain: 'member_test',
			at: Date.now(),
		});

		expect(await blockedReason(t, 'preview@example.com')).toBeNull();
		expect(await rows(t)).toEqual([
			expect.objectContaining({
				kind: 'complaint',
				deliveryDomain: 'member_test',
				suppression: 'unattributed',
			}),
		]);
	});

	it('keeps one row per event when the provider redelivers it', async () => {
		const t = newHarness();
		await dispatch(t, orphanBounce('ses-ghost'));
		await dispatch(t, orphanBounce('ses-ghost'));

		const stored = await rows(t);
		expect(stored).toHaveLength(1);
		expect(stored[0]?.occurrences).toBe(2);
	});
});

describe('replaying unresolved feedback', () => {
	it('applies the normal transition once the id resolves, and marks the row done', async () => {
		const t = newHarness();
		await dispatch(t, orphanBounce('ses-late'));
		const [row] = await rows(t);

		// The id was lost (#1184); a repair writes it back afterwards.
		const { campaignId, sendId } = await seedSentSend(t, 'ses-late');

		const first = await t.mutation(internal.webhooks.unresolvedFeedback.replay, {
			feedbackId: row!._id,
		});
		expect(first).toBe('replayed');
		const send = await t.run(async (ctx) => await ctx.db.get(sendId));
		expect(send).toMatchObject({ status: 'bounced', bounceType: 'hard' });
		expect(await statsBounced(t, campaignId)).toBe(1);
		const [resolved] = await rows(t);
		expect(resolved).toMatchObject({ status: 'resolved', resolution: 'replayed' });
		expect(resolved?.nextReplayAt).toBeUndefined();

		// A second replay, by an operator or a racing cron, applies nothing.
		const second = await t.mutation(internal.webhooks.unresolvedFeedback.replay, {
			feedbackId: row!._id,
		});
		expect(second).toBe('skipped');
		expect(await statsBounced(t, campaignId)).toBe(1);
	});

	it('resolves the row as refused when the Send is found but already terminal', async () => {
		const t = newHarness();
		await dispatch(t, orphanBounce('ses-done'));
		const [row] = await rows(t);
		const { sendId } = await seedSentSend(t, 'ses-done');
		await t.run(async (ctx) => await ctx.db.patch(sendId, { status: 'failed' }));

		const result = await t.mutation(internal.webhooks.unresolvedFeedback.replay, {
			feedbackId: row!._id,
		});
		expect(result).toBe('refused');
		expect((await rows(t))[0]).toMatchObject({ status: 'resolved', resolution: 'refused' });
	});

	it('the cron retries a row a few times over the first day, then leaves it to an operator', async () => {
		const t = newHarness();
		await dispatch(t, orphanBounce('ses-never'));

		// Not due yet.
		expect(await t.mutation(internal.webhooks.unresolvedFeedback.replayDue, {})).toEqual({
			scheduled: 0,
		});

		for (let attempt = 1; attempt <= AUTOMATIC_REPLAY_ATTEMPTS; attempt++) {
			vi.advanceTimersByTime(DAY + MINUTE);
			expect(await t.mutation(internal.webhooks.unresolvedFeedback.replayDue, {})).toEqual({
				scheduled: 1,
			});
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			expect((await rows(t))[0]?.replayAttempts).toBe(attempt);
		}

		const [row] = await rows(t);
		expect(row).toMatchObject({ status: 'open', replayAttempts: AUTOMATIC_REPLAY_ATTEMPTS });
		expect(row?.nextReplayAt).toBeUndefined();
		vi.advanceTimersByTime(7 * DAY);
		expect(await t.mutation(internal.webhooks.unresolvedFeedback.replayDue, {})).toEqual({
			scheduled: 0,
		});

		// An operator replay still runs, and does not spend an attempt.
		const result = await t.mutation(internal.webhooks.unresolvedFeedback.replay, {
			feedbackId: row!._id,
		});
		expect(result).toBe('unmatched');
		expect((await rows(t))[0]?.replayAttempts).toBe(AUTOMATIC_REPLAY_ATTEMPTS);
	});

	it('the cron picks up a row whose send got its id after the webhook raced it', async () => {
		const t = newHarness();
		await dispatch(t, orphanBounce('ses-race'));
		const { sendId } = await seedSentSend(t, 'ses-race');

		vi.advanceTimersByTime(11 * MINUTE);
		await t.mutation(internal.webhooks.unresolvedFeedback.replayDue, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		expect((await t.run(async (ctx) => await ctx.db.get(sendId)))?.status).toBe('bounced');
		expect((await rows(t))[0]).toMatchObject({ status: 'resolved', resolution: 'replayed' });
	});

	it('a hard bounce escalates a stored soft one, and the replay applies the hard bounce', async () => {
		const t = newHarness();
		const softAt = Date.now();
		await dispatch(t, {
			...orphanBounce('ses-escalate'),
			bounceType: 'soft',
			bounceMessage: '452 mailbox full',
			at: softAt,
		});
		vi.advanceTimersByTime(MINUTE);
		const hardAt = Date.now();
		await dispatch(t, { ...orphanBounce('ses-escalate'), at: hardAt });
		// A later soft bounce never downgrades it again.
		await dispatch(t, {
			...orphanBounce('ses-escalate'),
			bounceType: 'soft',
			bounceMessage: '421 try later',
			at: hardAt + MINUTE,
		});

		const [row, ...rest] = await rows(t);
		expect(rest).toHaveLength(0);
		expect(row).toMatchObject({
			bounceType: 'hard',
			bounceStatusCode: '5.1.1',
			at: hardAt,
			occurrences: 3,
		});

		const { sendId, email } = await seedSentSend(t, 'ses-escalate');
		await t.mutation(internal.webhooks.unresolvedFeedback.replay, { feedbackId: row!._id });

		expect(await t.run(async (ctx) => await ctx.db.get(sendId))).toMatchObject({
			status: 'bounced',
			bounceType: 'hard',
		});
		// The hard bounce's own suppression happened.
		expect(await blockedReason(t, email)).toBe('bounced');
	});

	it('schedules every automatic replay from when the row was first seen', async () => {
		const t = newHarness();
		const firstSeenAt = Date.now();
		await dispatch(t, orphanBounce('ses-schedule'));
		const deadlines = [10 * MINUTE, 60 * MINUTE, 6 * 60 * MINUTE, DAY].map(
			(offset) => firstSeenAt + offset
		);

		expect((await rows(t))[0]?.nextReplayAt).toBe(deadlines[0]);
		for (let attempt = 1; attempt <= AUTOMATIC_REPLAY_ATTEMPTS; attempt++) {
			// Each tick lands a little late, the way a 10-minute cron does.
			vi.setSystemTime(deadlines[attempt - 1]! + 7 * MINUTE);
			await t.mutation(internal.webhooks.unresolvedFeedback.replayDue, {});
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			const [row] = await rows(t);
			expect(row?.replayAttempts).toBe(attempt);
			expect(row?.nextReplayAt).toBe(deadlines[attempt]);
		}
	});

	it('replayOpen walks every open row', async () => {
		const t = newHarness();
		for (const id of ['a', 'b', 'c']) await dispatch(t, orphanBounce(`ses-${id}`));
		await seedSentSend(t, 'ses-a');
		await seedSentSend(t, 'ses-c');

		await t.mutation(internal.webhooks.unresolvedFeedback.replayOpen, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const byId = Object.fromEntries((await rows(t)).map((r) => [r.providerMessageId, r.status]));
		expect(byId).toEqual({ 'ses-a': 'resolved', 'ses-b': 'open', 'ses-c': 'resolved' });
	});
});

describe('counting, retention and privacy', () => {
	it('status counts the last 30 days without reading logs', async () => {
		const t = newHarness();
		await dispatch(t, orphanBounce('ses-1'));
		await dispatch(t, {
			kind: 'email.complained',
			providerMessageId: 'mta-2',
			recipient: 'c@example.com',
			providerType: 'mta',
			deliveryDomain: 'production',
			at: Date.now(),
		});
		await dispatch(t, {
			kind: 'email.complained',
			providerMessageId: 'ses-3',
			recipient: 'd@example.com',
			providerType: 'ses',
			at: Date.now(),
		});

		const status = await t.query(internal.webhooks.unresolvedFeedback.status, {});
		expect(status.last30Days).toEqual({
			total: 3,
			bounces: 1,
			complaints: 2,
			suppressed: 1,
			unattributed: 1,
			withoutMessageId: 0,
			open: 3,
			isCapped: false,
		});
		expect(status.openCount).toBe(3);
		expect(JSON.stringify(status)).not.toContain('c@example.com');
	});

	it('deletes rows past the retention horizon and keeps younger ones', async () => {
		const t = newHarness();
		await dispatch(t, orphanBounce('ses-old'));
		vi.advanceTimersByTime(RETENTION_MS - DAY);
		await dispatch(t, orphanBounce('ses-young'));
		vi.advanceTimersByTime(2 * DAY);

		expect(await t.mutation(internal.webhooks.unresolvedFeedback.purgeExpired, {})).toEqual({
			deleted: 1,
		});
		expect((await rows(t)).map((r) => r.providerMessageId)).toEqual(['ses-young']);
	});

	// #1194 round 3: the table keeps no personal data. A diagnostic routinely
	// quotes the recipient; only its status code survives.
	it('stores no field that contains the recipient address, not even from a diagnostic quoting it', async () => {
		const t = newHarness();
		const address = 'quoted.person@example.com';
		await dispatch(t, {
			...orphanBounce('ses-quoted'),
			bounceMessage: `smtp; 550 5.1.1 <${address}>: Recipient address rejected: User unknown`,
		});
		await dispatch(t, {
			kind: 'email.complained',
			providerMessageId: 'ses-named',
			recipient: address,
			providerType: 'ses',
			at: Date.now(),
		});

		const stored = await rows(t);
		expect(stored).toHaveLength(2);
		expect(stored[0]?.bounceStatusCode).toBe('5.1.1');
		for (const row of stored) {
			expect(JSON.stringify(row).toLowerCase()).not.toContain(address);
			expect(JSON.stringify(row).toLowerCase()).not.toContain('example.com');
		}
	});

	it('still blocks an attributed complainer at receive time without storing the address', async () => {
		const t = newHarness();
		const address = 'attributed.person@example.com';
		await dispatch(t, {
			kind: 'email.complained',
			providerMessageId: 'mta-attributed',
			recipient: address,
			providerType: 'mta',
			deliveryDomain: 'production',
			at: Date.now(),
		});

		expect(await blockedReason(t, address)).toBe('complained');
		const [row] = await rows(t);
		expect(row?.suppression).toBe('suppressed');
		expect(JSON.stringify(row).toLowerCase()).not.toContain(address);
	});
});

// #1227: a complaint with no message id (RFC 5965 redaction) blocks an address
// on the same proof as one whose id matches no send.
describe('complaints that arrive without a message id', () => {
	const redacted = (
		event: Omit<InboundEventOf<'email.complained'>, 'kind' | 'at'>
	): InboundEventOf<'email.complained'> => ({ kind: 'email.complained', at: Date.now(), ...event });

	it('counts an unattributed one, blocks no one and keeps no address', async () => {
		// Another deployment's mail, reported through a shared SES account with
		// the Message-ID missing: a genuine signature, and no proof of the sender.
		const t = newHarness();
		const address = 'shared.account@example.com';
		await dispatch(t, redacted({ recipient: address, providerType: 'ses' }));

		expect(await blockedReason(t, address)).toBeNull();
		const [row, ...rest] = await rows(t);
		expect(rest).toHaveLength(0);
		expect(row).toMatchObject({
			kind: 'complaint',
			providerType: 'ses',
			suppression: 'unattributed',
			status: 'resolved',
			resolution: 'no_message_id',
			occurrences: 1,
		});
		expect(row?.providerMessageId).toBeUndefined();
		expect(row?.nextReplayAt).toBeUndefined();
		expect(JSON.stringify(row).toLowerCase()).not.toContain('example.com');
	});

	it('blocks an attributed one at receive time and stores nothing', async () => {
		const t = newHarness();
		await dispatch(
			t,
			redacted({
				recipient: 'Attributed@Example.com',
				providerType: 'mta',
				deliveryDomain: 'production',
			})
		);

		expect(await blockedReason(t, 'attributed@example.com')).toBe('complained');
		expect(await rows(t)).toEqual([]);
	});

	it('is counted but never replayed or left in the open backlog', async () => {
		const t = newHarness();
		await dispatch(t, redacted({ recipient: 'a@example.com', providerType: 'resend' }));
		await dispatch(t, redacted({ recipient: 'b@example.com', providerType: 'resend' }));
		await dispatch(t, orphanBounce('ses-open'));
		const [first] = await rows(t);

		expect(
			await t.mutation(internal.webhooks.unresolvedFeedback.replay, { feedbackId: first!._id })
		).toBe('skipped');
		await t.mutation(internal.webhooks.unresolvedFeedback.replayOpen, {});
		vi.advanceTimersByTime(2 * DAY);
		await t.mutation(internal.webhooks.unresolvedFeedback.replayDue, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const status = await t.query(internal.webhooks.unresolvedFeedback.status, {});
		expect(status.last30Days).toMatchObject({
			total: 3,
			complaints: 2,
			unattributed: 2,
			withoutMessageId: 2,
			open: 1,
		});
		expect(status.openCount).toBe(1);
		expect(status.sample.map((r) => r.providerMessageId)).toEqual(['ses-open']);
		for (const row of (await rows(t)).filter((r) => r.kind === 'complaint')) {
			expect(row).toMatchObject({ status: 'resolved', replayAttempts: 0 });
		}
	});
});
