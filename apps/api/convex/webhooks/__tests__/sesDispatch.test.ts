import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * SES feedback → dispatcher integration.
 *
 * Replays SNS fixtures through `sesAdapter.parseEvent` and then
 * `dispatchInboundEvent`, asserting SES events land on the SAME downstream
 * mutations the MTA / Resend webhooks feed (suppression + reputation via the
 * Send lifecycle, direct blocklist for a redacted complaint), and that SNS
 * redelivery is deterministic (a duplicate delivery dispatches identically —
 * the downstream mutation is idempotent by providerMessageId). The SNS
 * subscription handshake is confirmed by a host-pinned GET.
 *
 * Uses the same `_generated/api` proxy mock as dispatcher.test.ts so
 * `internal.*` references compare by value.
 */

vi.mock('../../_generated/api', () => {
	const makeRef = (path: string): unknown =>
		new Proxy(
			{},
			{
				get(_t, prop: string | symbol) {
					if (typeof prop === 'symbol') return undefined;
					if (prop === 'toString') return () => path;
					return makeRef(`${path}.${prop}`);
				},
			}
		);
	return { internal: makeRef('internal'), api: makeRef('api') };
});

import { dispatchInboundEvent } from '../dispatcher';
import { sesAdapter } from '../adapters/ses';
import type { ActionCtx } from '../../_generated/server';

const ref = (r: unknown): string => `${r as string}`;

interface RunMutationCall {
	ref: string;
	args: unknown;
}

function makeCtx() {
	const runMutationCalls: RunMutationCall[] = [];
	const ctx = {
		runMutation: vi.fn(async (r: unknown, args: unknown) => {
			runMutationCalls.push({ ref: ref(r), args });
			return { ok: true };
		}),
		scheduler: { runAfter: vi.fn(async () => undefined) },
	} as unknown as ActionCtx;
	return { ctx, runMutationCalls };
}

function notification(sesMessage: Record<string, unknown>): string {
	return JSON.stringify({
		Type: 'Notification',
		MessageId: 'sns-1',
		Timestamp: '2026-07-10T00:00:00.000Z',
		TopicArn: 'arn',
		Message: JSON.stringify(sesMessage),
	});
}

const parse = (raw: string) => {
	const e = sesAdapter.parseEvent(raw);
	if (!e) throw new Error('fixture did not parse to an event');
	return e;
};

describe('SES feedback dispatch', () => {
	it('routes a hard bounce into the Send lifecycle (suppression + reputation path)', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		await dispatchInboundEvent(
			ctx,
			parse(
				notification({
					notificationType: 'Bounce',
					mail: { messageId: 'ses-msg-1' },
					bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'a@b.com' }] },
				})
			)
		);
		expect(runMutationCalls).toHaveLength(1);
		expect(runMutationCalls[0]!.ref).toBe(
			'internal.delivery.sendLifecycle.transitionByProviderMessageId'
		);
		expect(runMutationCalls[0]!.args).toMatchObject({
			providerMessageId: 'ses-msg-1',
			transition: { to: 'bounced', bounceType: 'hard' },
		});
	});

	it('routes an attributed complaint into the Send lifecycle', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		await dispatchInboundEvent(
			ctx,
			parse(
				notification({
					notificationType: 'Complaint',
					mail: { messageId: 'ses-msg-2' },
					complaint: { complainedRecipients: [{ emailAddress: 'a@b.com' }] },
				})
			)
		);
		expect(runMutationCalls[0]!.ref).toBe(
			'internal.delivery.sendLifecycle.transitionByProviderMessageId'
		);
		expect(runMutationCalls[0]!.args).toMatchObject({ transition: { to: 'complained' } });
	});

	it('suppresses a redacted complaint directly by address (no recoverable message id)', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		await dispatchInboundEvent(
			ctx,
			parse(
				notification({
					notificationType: 'Complaint',
					mail: {},
					complaint: { complainedRecipients: [{ emailAddress: 'redacted@b.com' }] },
				})
			)
		);
		expect(runMutationCalls[0]!.ref).toBe('internal.blockedEmails.addFromEvent');
		expect(runMutationCalls[0]!.args).toMatchObject({
			email: 'redacted@b.com',
			reason: 'complained',
		});
	});

	it('dispatches a duplicate delivery deterministically (idempotent redelivery)', async () => {
		const { ctx, runMutationCalls } = makeCtx();
		const raw = notification({ notificationType: 'Delivery', mail: { messageId: 'ses-msg-3' } });
		await dispatchInboundEvent(ctx, parse(raw));
		await dispatchInboundEvent(ctx, parse(raw));
		expect(runMutationCalls).toHaveLength(2);
		expect(runMutationCalls[0]!.ref).toBe(
			'internal.delivery.sendLifecycle.transitionByProviderMessageId'
		);
		// Identical args on redelivery → the idempotent downstream mutation is a no-op the second time.
		expect(runMutationCalls[0]).toEqual(runMutationCalls[1]);
		expect(runMutationCalls[0]!.args).toMatchObject({
			providerMessageId: 'ses-msg-3',
			transition: { to: 'delivered' },
		});
	});
});

describe('SNS subscription confirmation', () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it('confirms the subscription by GET-ing the pinned SubscribeURL', async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const { ctx } = makeCtx();
		await dispatchInboundEvent(
			ctx,
			parse(
				JSON.stringify({
					Type: 'SubscriptionConfirmation',
					SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t',
				})
			)
		);
		expect(fetchMock).toHaveBeenCalledWith(
			'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=t'
		);
	});
});
