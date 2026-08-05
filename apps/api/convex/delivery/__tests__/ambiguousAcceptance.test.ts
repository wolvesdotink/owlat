/**
 * THE PARK — what happens to a Send whose acceptance is genuinely unknown on a
 * transport that cannot be asked again (plan D4).
 *
 * Mandrill's `send-raw` has no idempotency surface, so a lost response may sit
 * on top of an accepted and delivered message: replaying it (the MTA's
 * reconciliation, which is safe because its idempotency key IS the MTA message
 * id) would double-deliver. Before this posture the ambiguity reached
 * `completeSend` as a thrown worker error, the row went `failed` /
 * `WORKPOOL_FAILED`, and `failed` is terminal in `LEGAL_EDGES` — a definite
 * non-delivery claimed for a message that may well have been delivered, on a row
 * that could no longer accept any later transition.
 *
 * Four claims: the row stays `queued`, nothing is re-dispatched, nothing is
 * counted as a deferral, and the deadline — not a worker retry — is what
 * eventually closes it, with a code that names the actual condition.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import type { WorkId } from '@convex-dev/workpool';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';
import type { Id } from '../../_generated/dataModel';
import { internal } from '../../_generated/api';
import schema from '../../schema';
import { modules } from '../../__tests__/testModules';
import { seedAssignedSend } from '../../analytics/__tests__/transportOutcomesFixtures';

// The singleton-org lookup goes through the BetterAuth component, which is not
// registered in the convex-test harness.
vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org_ambiguous') };
});

const testWorkId = 'test-work-id' as WorkId;

/** The worker answer the `awaitingProviderFeedback` arm produces. */
function parkedResult(startedAt: number, sendId: Id<'emailSends'>) {
	return {
		kind: 'success' as const,
		returnValue: {
			success: false,
			acceptanceUnknown: true,
			awaitingProviderFeedback: true,
			providerType: 'mandrill',
			startedAt,
			retryState: { attempt: 1, startedAt, idempotencyKey: `send_${sendId}` },
		},
	};
}

async function scheduled(t: ReturnType<typeof convexTest>) {
	return await t.run(async (ctx) => await ctx.db.system.query('_scheduled_functions').collect());
}

describe('an ambiguous-acceptance send on a feedback-capable relay', () => {
	it('stays queued and arms the delivery deadline instead of terminalizing', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await t.run(async (ctx) => await seedAssignedSend(ctx));
		const startedAt = Date.now();

		await t.mutation(internal.delivery.sendCompletion.completeSend, {
			workId: testWorkId,
			result: parkedResult(startedAt, sendId),
			context: { sendRef: { kind: 'campaign', id: sendId } },
		});

		await t.run(async (ctx) => {
			const send = await ctx.db.get(sendId);
			// "We do not know yet" — the truth, and the only state a later
			// transition can still leave.
			expect(send?.status).toBe('queued');
			expect(send?.errorCode).toBeUndefined();
		});

		const jobs = await scheduled(t);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.name).toContain('expireUnconfirmedAcceptance');
		expect(jobs[0]?.scheduledTime).toBe(startedAt + GOVERNED_MTA_MAX_MESSAGE_AGE_MS);
	});

	it('never re-dispatches the attempt (D4) and never counts a deferral', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await t.run(async (ctx) => await seedAssignedSend(ctx));

		await t.mutation(internal.delivery.sendCompletion.completeSend, {
			workId: testWorkId,
			result: parkedResult(Date.now(), sendId),
			context: { sendRef: { kind: 'campaign', id: sendId } },
		});

		// The one thing that would double-deliver: the deferral path's re-entry.
		const jobs = await scheduled(t);
		expect(jobs.map((job) => job.name).join(' ')).not.toContain('retrySend');
		// An ambiguous timeout is OUR request outcome going missing, not a receiver
		// holding the message. `deferralCountedDay` is the per-day stamp the
		// deferral writer sets before it bumps gate 2's numerator; an unstamped row
		// proves the counter was left alone.
		await t.run(async (ctx) => {
			expect((await ctx.db.get(sendId))?.deferralCountedDay).toBeUndefined();
		});
	});
});

describe('closing a parked send at the deadline', () => {
	async function park(t: ReturnType<typeof convexTest>, startedAt: number) {
		const { sendId } = await t.run(async (ctx) => await seedAssignedSend(ctx));
		await t.mutation(internal.delivery.sendCompletion.completeSend, {
			workId: testWorkId,
			result: parkedResult(startedAt, sendId),
			context: { sendRef: { kind: 'campaign', id: sendId } },
		});
		return sendId;
	}

	it('is a no-op before the deadline — a stray wake-up must not close the question', async () => {
		const t = convexTest(schema, modules);
		const startedAt = Date.now();
		const sendId = await park(t, startedAt);

		await t.mutation(internal.delivery.sendCompletion.expireUnconfirmedAcceptance, {
			sendRef: { kind: 'campaign', id: sendId },
			startedAt,
		});

		await t.run(async (ctx) => {
			expect((await ctx.db.get(sendId))?.status).toBe('queued');
		});
	});

	it('terminalizes at the deadline with a code that names the condition', async () => {
		const t = convexTest(schema, modules);
		const startedAt = Date.now() - GOVERNED_MTA_MAX_MESSAGE_AGE_MS;
		const sendId = await park(t, startedAt);

		await t.mutation(internal.delivery.sendCompletion.expireUnconfirmedAcceptance, {
			sendRef: { kind: 'campaign', id: sendId },
			startedAt,
		});

		await t.run(async (ctx) => {
			const send = await ctx.db.get(sendId);
			expect(send?.status).toBe('failed');
			// NOT `WORKPOOL_FAILED`: that reads as "the send failed", which is
			// precisely the claim this posture refuses to make.
			expect(send?.errorCode).toBe('PROVIDER_ACCEPTANCE_UNCONFIRMED');
		});
	});

	it('leaves a send that something with better evidence already settled', async () => {
		const t = convexTest(schema, modules);
		const startedAt = Date.now() - GOVERNED_MTA_MAX_MESSAGE_AGE_MS;
		const sendId = await park(t, startedAt);
		// A provider webhook (or an operator) got there first.
		await t.run(async (ctx) => {
			await ctx.db.patch(sendId, { status: 'sent', sentAt: Date.now() });
		});

		await t.mutation(internal.delivery.sendCompletion.expireUnconfirmedAcceptance, {
			sendRef: { kind: 'campaign', id: sendId },
			startedAt,
		});

		await t.run(async (ctx) => {
			expect((await ctx.db.get(sendId))?.status).toBe('sent');
		});
	});
});
