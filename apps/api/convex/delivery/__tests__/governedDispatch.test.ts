import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';
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
	deliveryDomain: 'production' as const,
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
	afterEach(() => vi.useRealTimers());

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
			startedAt: expect.any(Number),
			deliveryDomain: 'production',
			mtaReconciliation: false,
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
		runMutation
			.mockResolvedValueOnce({ token: 'reentry-token', expiresAt: Date.now() })
			.mockResolvedValueOnce({ ok: true });
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
				deliveryDomain: 'production',
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
		runMutation
			.mockResolvedValueOnce({ token: 'reentry-token', expiresAt: Date.now() })
			.mockResolvedValueOnce({ ok: true });
		const startedAt = Date.now() - 100;
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
				startedAt,
				idempotencyKey: 'send_original',
			},
		});

		expect(result).toMatchObject({
			success: false,
			deferred: true,
			retryAfterMs: 5_000,
			retryState: {
				attempt: 3,
				startedAt,
				idempotencyKey: 'send_original',
			},
		});
	});

	it('replays a request-never-arrived ambiguity with the same MTA-only work identity', async () => {
		runMutation
			.mockResolvedValueOnce({ token: 'reentry-token-1', expiresAt: Date.now() })
			.mockResolvedValueOnce({ ok: true })
			.mockResolvedValueOnce({ token: 'reentry-token-2', expiresAt: Date.now() })
			.mockResolvedValueOnce({ ok: true });
		resolveLastMileRouting.mockResolvedValue({
			kind: 'ready',
			providerKind: 'mta',
			route: { ipPool: 'campaign' },
			organizationId: 'org-1',
			routingLease: 'lease-1',
		});
		sendProviderDispatch
			.mockResolvedValueOnce({
				result: {
					success: false,
					errorCode: 'SERVER_ERROR',
					errorMessage: 'request outcome unknown',
					acceptanceUnknown: true,
				},
				providerType: 'mta',
				latencyMs: 10,
				attempts: 3,
			})
			.mockResolvedValueOnce({
				result: { success: true, id: 'send_send-row-1' },
				providerType: 'mta',
				latencyMs: 5,
				attempts: 1,
			});

		const unknown = await dispatchGovernedEmail(ctx, baseRequest);
		expect(unknown).toMatchObject({
			success: false,
			acceptanceUnknown: true,
			retryState: { acceptanceReconciliation: true, workAttemptId: expect.any(String) },
		});
		if (!('acceptanceUnknown' in unknown)) throw new Error('expected ambiguity');
		const accepted = await dispatchGovernedEmail(ctx, {
			...baseRequest,
			retryState: unknown.retryState,
		});

		const firstExtras = sendProviderDispatch.mock.calls[0]![3] as { workAttemptId: string };
		const secondExtras = sendProviderDispatch.mock.calls[1]![3] as { workAttemptId: string };
		expect(secondExtras.workAttemptId).toBe(firstExtras.workAttemptId);
		expect(resolveLastMileRouting.mock.calls[1]![1]).toMatchObject({
			workAttemptId: firstExtras.workAttemptId,
			mtaReconciliation: true,
		});
		expect(accepted).toMatchObject({ success: true, acceptedForDelivery: true });
	});

	it.each([
		{ offset: GOVERNED_MTA_MAX_MESSAGE_AGE_MS - 1, accepted: true },
		{ offset: GOVERNED_MTA_MAX_MESSAGE_AGE_MS, accepted: false },
		{ offset: GOVERNED_MTA_MAX_MESSAGE_AGE_MS + 1, accepted: false },
	])(
		'enforces the cumulative delivery deadline at offset $offset',
		async ({ offset, accepted }) => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-03-01T00:00:00Z'));
			const now = Date.now();
			resolveLastMileRouting.mockResolvedValue({ kind: 'defer', retryAfterMs: 30_000 });
			const request = {
				...baseRequest,
				retryState: {
					attempt: 2,
					startedAt: now - offset,
					idempotencyKey: 'send_original',
				},
			};

			if (accepted) {
				await expect(dispatchGovernedEmail(ctx, request)).resolves.toMatchObject({
					success: false,
					deferred: true,
					retryState: { startedAt: now - offset },
				});
				expect(resolveLastMileRouting).toHaveBeenCalledOnce();
			} else {
				await expect(dispatchGovernedEmail(ctx, request)).rejects.toThrow(
					'Governed delivery deadline expired.'
				);
				expect(resolveLastMileRouting).not.toHaveBeenCalled();
			}
		}
	);
});
