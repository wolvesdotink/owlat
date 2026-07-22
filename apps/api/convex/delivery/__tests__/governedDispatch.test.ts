import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../_generated/server';

const resolveLastMileRouting = vi.hoisted(() => vi.fn());
const sendProviderDispatch = vi.hoisted(() => vi.fn());

vi.mock('../lastMileRouting', () => ({ resolveLastMileRouting }));
vi.mock('../../lib/sendProviders/dispatch', () => ({ sendProviderDispatch }));

import { dispatchGovernedEmail } from '../governedDispatch';

const runMutation = vi.fn().mockResolvedValue({ token: 'reentry-token', expiresAt: Date.now() });
const ctx = { runMutation } as unknown as ActionCtx;
const envelopeInput = {
	kind: 'campaign',
	emailSendId: 'send-row-1',
	organizationId: 'org-1',
} as const;
const baseRequest = {
	envelopeInput,
	messageType: 'campaign' as const,
	to: 'recipient@example.com',
	from: 'sender@example.com',
	organizationId: 'org-1',
	sendRef: { kind: 'campaign' as const, id: 'send-row-1' as never },
	message: {
		subject: 'Subject',
		html: '<p>Body</p>',
		text: 'Body',
	},
};

describe('dispatchGovernedEmail', () => {
	beforeEach(() => {
		resolveLastMileRouting.mockReset();
		sendProviderDispatch.mockReset();
		runMutation.mockClear();
	});

	it('returns a typed retry envelope without dispatching when routing defers', async () => {
		resolveLastMileRouting.mockResolvedValue({ kind: 'defer', retryAfterMs: 30_000 });

		const result = await dispatchGovernedEmail(ctx, baseRequest);

		expect(resolveLastMileRouting).toHaveBeenCalledWith(ctx, {
			messageType: 'campaign',
			to: 'recipient@example.com',
			from: 'sender@example.com',
			providerType: undefined,
			ipPool: undefined,
			organizationId: 'org-1',
			idempotencyKey: 'send_send-row-1',
			workAttemptId: expect.any(String),
			routingReentryToken: 'reentry-token',
		});
		expect(sendProviderDispatch).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			success: false,
			deferred: true,
			retryAfterMs: 30_000,
			envelopeInput,
			retryState: { attempt: 2, idempotencyKey: 'send_send-row-1' },
		});
	});

	it('binds the governed MTA route, lease, pool, and stable idempotency key', async () => {
		resolveLastMileRouting.mockResolvedValue({
			kind: 'ready',
			providerKind: 'mta',
			route: { ipPool: 'campaign' },
			organizationId: 'org-1',
			routingLease: 'lease-1',
		});
		sendProviderDispatch.mockResolvedValue({
			result: { success: true, id: 'mta-dedup-sentinel' },
			providerType: 'mta',
			latencyMs: 12,
			attempts: 1,
		});

		const result = await dispatchGovernedEmail(ctx, baseRequest);

		expect(sendProviderDispatch).toHaveBeenCalledWith(
			ctx,
			'mta',
			{
				to: 'recipient@example.com',
				from: 'sender@example.com',
				replyTo: undefined,
				...baseRequest.message,
			},
			{
				messageId: 'send_send-row-1',
				workAttemptId: expect.any(String),
				routingReentryToken: 'reentry-token',
				organizationId: 'org-1',
				messageType: 'campaign',
				routingLease: 'lease-1',
				allowWarmupOverflow: false,
				ipPool: 'campaign',
				routingReentry: {
					envelopeInput,
					retryState: {
						attempt: 2,
						startedAt: expect.any(Number),
						idempotencyKey: 'send_send-row-1',
					},
				},
			}
		);
		expect(result).toEqual({
			success: true,
			providerMessageId: 'send_send-row-1',
			providerType: 'mta',
			sendLatencyMs: 12,
			acceptedForDelivery: true,
		});
	});

	it('preserves the original retry key when the provider rejects a stale lease', async () => {
		resolveLastMileRouting.mockResolvedValue({
			kind: 'ready',
			providerKind: 'mta',
			route: null,
			organizationId: 'org-1',
			routingLease: 'lease-2',
		});
		sendProviderDispatch.mockResolvedValue({
			result: {
				success: false,
				errorCode: 'ROUTING_DEFERRED',
				errorMessage: 'lease changed',
				retryAfterMs: 5_000,
			},
			providerType: 'mta',
			latencyMs: 3,
			attempts: 1,
		});

		const result = await dispatchGovernedEmail(ctx, {
			...baseRequest,
			retryState: {
				attempt: 2,
				startedAt: 100,
				idempotencyKey: 'send_original',
			},
		});

		expect(result).toMatchObject({
			success: false,
			deferred: true,
			retryAfterMs: 5_000,
			retryState: {
				attempt: 3,
				startedAt: 100,
				idempotencyKey: 'send_original',
			},
		});
	});
});
