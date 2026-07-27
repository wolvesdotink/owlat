import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from '../../_generated/api';
import type { ActionCtx } from '../../_generated/server';
import schema from '../../schema';
import {
	createTestCampaign,
	createTestContact,
	createTestEmailSend,
} from '../../__tests__/factories';
import { dispatchInboundEvent } from '../../webhooks/dispatcher';

/**
 * END-TO-END BOUNCE ATTRIBUTION — the half of named surface (a) that the pure
 * VERP fixtures cannot reach.
 *
 * The whole point of stamping our VERP envelope sender on a relay send is that
 * the DSN the relay generates comes back to OUR bounce server. The MTA decodes
 * the signed token, attributes it to the send's providerMessageId, and emits an
 * `email.bounced` event — which, being raised by our own MTA, carries
 * `providerType: 'mta'` unconditionally. The Send row, however, records the
 * transport the message actually LEFT through: `smtp`.
 *
 * If the lifecycle routes on the EVENT's provider and then refuses any row that
 * does not say `mta`, every relayed bounce is dropped as `send_not_found`, the
 * relay arm produces no bounce data, and the measurement bias this feature
 * exists to remove survives it. So the flow is exercised through the real
 * dispatcher against real table writes.
 */

const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		module,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };

const RELAY_MESSAGE_ID = 'relay-message-id-abc';

/**
 * An `ActionCtx` backed by the convex-test harness, so the dispatcher's
 * `ctx.runMutation` reaches the REAL mutations and writes real rows. Only the
 * two members the bounce/complaint handlers use are provided; anything else
 * would be an unexercised stub pretending to be coverage.
 */
function actionCtx(t: ReturnType<typeof convexTest>): ActionCtx {
	// The harness's `mutation`/`query` are generically typed over a specific
	// function reference; the dispatcher hands them whichever reference its
	// table picked, which no single instantiation can describe. Widen the
	// harness once, here, rather than casting at each forwarding call.
	const harness = t as unknown as {
		mutation: (reference: unknown, args: unknown) => Promise<unknown>;
		query: (reference: unknown, args: unknown) => Promise<unknown>;
	};
	return {
		runMutation: (reference: unknown, args: unknown) => harness.mutation(reference, args),
		runQuery: (reference: unknown, args: unknown) => harness.query(reference, args),
	} as unknown as ActionCtx;
}

/** A queued campaign send that left through the RELAY, not the owned MTA. */
async function seedRelaySend(t: ReturnType<typeof convexTest>, status: 'queued' | 'sent') {
	return await t.run(async (ctx) => {
		const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
		const contactId = await ctx.db.insert('contacts', createTestContact());
		return await ctx.db.insert(
			'emailSends',
			createTestEmailSend({
				campaignId,
				contactId,
				status,
				providerType: 'smtp',
				providerMessageId: RELAY_MESSAGE_ID,
				contactEmail: 'subscriber@gmail.com',
				...(status === 'sent' ? { sentAt: Date.now() } : {}),
			})
		);
	});
}

describe('a relayed bounce arriving on our own VERP stream', () => {
	it('transitions the SMTP send and keeps its own providerType', async () => {
		const t = convexTest(schema, modules);
		const sendId = await seedRelaySend(t, 'sent');

		await dispatchInboundEvent(actionCtx(t), {
			kind: 'email.bounced',
			// Our own bounce server raised this: the MTA adapter stamps
			// `providerType: 'mta'` on every event it emits, whatever transport the
			// message originally left through.
			providerType: 'mta',
			providerMessageId: RELAY_MESSAGE_ID,
			bounceType: 'hard',
			bounceMessage: '550 5.1.1 unknown recipient',
			at: Date.now(),
		});

		const send = await t.run(async (ctx) => await ctx.db.get(sendId));
		expect(send?.status).toBe('bounced');
		// The transport that actually carried the message is NOT rewritten by the
		// attribution: the arm the outcome is credited to must stay the relay.
		expect(send?.providerType).toBe('smtp');
	});

	it('attributes a relayed COMPLAINT (FBL) the same way', async () => {
		const t = convexTest(schema, modules);
		const sendId = await seedRelaySend(t, 'sent');

		await dispatchInboundEvent(actionCtx(t), {
			kind: 'email.complained',
			providerType: 'mta',
			providerMessageId: RELAY_MESSAGE_ID,
			at: Date.now(),
		});

		const send = await t.run(async (ctx) => await ctx.db.get(sendId));
		expect(send?.status).toBe('complained');
		expect(send?.providerType).toBe('smtp');
	});

	it('still refuses a report whose id matches no send', async () => {
		const t = convexTest(schema, modules);
		await seedRelaySend(t, 'sent');

		const outcome = await t.mutation(
			internal.delivery.sendLifecycle.transitionMtaByProviderMessageId,
			{
				providerMessageId: 'some-other-id',
				transition: { to: 'bounced', at: Date.now(), bounceType: 'hard' },
			}
		);
		expect(outcome).toEqual({ ok: false, reason: 'send_not_found' });
	});

	it('does NOT extend the queued-terminal relaxation to the relay arm', async () => {
		// Only the direct-MX path binds a provisional identity while the row is
		// still `queued`, so only it may go queued → bounced without an
		// intervening `sent`. A relay row in `queued` is not a legal edge, and
		// silently allowing it would let a stray report terminalize a send whose
		// dispatch is still in flight.
		const t = convexTest(schema, modules);
		const sendId = await seedRelaySend(t, 'queued');

		const outcome = await t.mutation(
			internal.delivery.sendLifecycle.transitionMtaByProviderMessageId,
			{
				providerMessageId: RELAY_MESSAGE_ID,
				transition: { to: 'bounced', at: Date.now(), bounceType: 'hard' },
			}
		);
		expect(outcome.ok).toBe(false);
		expect((await t.run(async (ctx) => await ctx.db.get(sendId)))?.status).toBe('queued');
	});
});
