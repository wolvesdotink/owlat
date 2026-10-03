/**
 * Bounces and complaints whose message id matches no send are kept (#1194).
 *
 * They used to be logged and dropped. These tests pin what happens to them now:
 * one stored row per event, a replay that applies the ordinary transition once
 * the id resolves and then never again, automatic replays that stop, a purge
 * at the retention horizon, an operator count, and erasure with the contact
 * whose address a row names.
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
import type { InboundEvent } from '../webhooks/types';
import { permanentlyDeleteContactWithRelations } from '../lib/contactMutations';
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

const orphanBounce = (providerMessageId: string): InboundEvent => ({
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
			bounceMessage: 'smtp; 550 5.1.1 user unknown',
			isSuppressed: false,
			status: 'open',
			occurrences: 1,
			replayAttempts: 0,
		});
		expect(row?.recipient).toBeUndefined();
		expect(await t.run(async (ctx) => await ctx.db.query('blockedEmails').collect())).toEqual([]);
	});

	it('suppresses an unknown-id complaint that passes the provenance rule, and stores it', async () => {
		const t = newHarness();
		await dispatch(t, {
			kind: 'email.complained',
			providerMessageId: 'ses-ghost',
			recipient: 'Complainer@Example.com',
			providerType: 'ses',
			at: Date.now(),
		});

		expect(await blockedReason(t, 'complainer@example.com')).toBe('complained');
		expect(await rows(t)).toEqual([
			expect.objectContaining({
				kind: 'complaint',
				recipient: 'complainer@example.com',
				isSuppressed: true,
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
				recipient: 'preview@example.com',
				deliveryDomain: 'member_test',
				isSuppressed: false,
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
		expect(resolved?.bounceMessage).toBeUndefined();
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

describe('counting, retention and erasure', () => {
	it('status counts the last 30 days without reading logs', async () => {
		const t = newHarness();
		await dispatch(t, orphanBounce('ses-1'));
		await dispatch(t, {
			kind: 'email.complained',
			providerMessageId: 'ses-2',
			recipient: 'c@example.com',
			providerType: 'ses',
			at: Date.now(),
		});

		const status = await t.query(internal.webhooks.unresolvedFeedback.status, {});
		expect(status.last30Days).toEqual({
			total: 2,
			bounces: 1,
			complaints: 1,
			suppressed: 1,
			open: 2,
			isCapped: false,
		});
		expect(status.openCount).toBe(2);
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

	it('is erased with the contact whose address it names', async () => {
		const t = newHarness();
		const contactId = await t.run(
			async (ctx) =>
				await ctx.db.insert('contacts', createTestContact({ email: 'erase-me@example.com' }))
		);
		await dispatch(t, {
			kind: 'email.complained',
			providerMessageId: 'ses-erase',
			recipient: 'Erase-Me@example.com',
			providerType: 'ses',
			at: Date.now(),
		});
		await dispatch(t, {
			kind: 'email.complained',
			providerMessageId: 'ses-keep',
			recipient: 'someone-else@example.com',
			providerType: 'ses',
			at: Date.now(),
		});

		await t.run(async (ctx) => await permanentlyDeleteContactWithRelations(ctx, contactId));

		expect((await rows(t)).map((r) => r.providerMessageId)).toEqual(['ses-keep']);
	});

	it('is erased by the persisted erasure walker too', async () => {
		const t = newHarness();
		await t.run(
			async (ctx) =>
				await ctx.db.insert(
					'contacts',
					createTestContact({ email: 'walk-me@example.com', deletedAt: Date.now() - 40 * DAY })
				)
		);
		await dispatch(t, {
			kind: 'email.complained',
			providerMessageId: 'ses-walk',
			recipient: 'walk-me@example.com',
			providerType: 'ses',
			at: Date.now(),
		});

		await t.mutation(internal.contacts.contacts.cleanupSoftDeletedContacts, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		expect(await rows(t)).toEqual([]);
	});
});
