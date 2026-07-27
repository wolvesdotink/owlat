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

	it('holds a send under a safety pause without spending its routing attempts', async () => {
		// Eight 60-second attempts would terminalize the send ~7 minutes in —
		// inside a single deliverability signal's own 10-minute freshness window,
		// so the "pause" would still destroy the mail, just later.
		resolveLastMileRouting.mockResolvedValue({
			kind: 'defer',
			retryAfterMs: 600_000,
			isPolicyHold: true,
		});

		const result = await dispatchGovernedEmail(ctx, {
			...baseRequest,
			retryState: { attempt: 4, startedAt: Date.now(), idempotencyKey: 'send_send-row-1' },
		});

		expect(result).toMatchObject({
			success: false,
			deferred: true,
			retryAfterMs: 600_000,
			retryState: { attempt: 4 },
		});
	});

	it('still spends an attempt on ordinary routing churn', async () => {
		resolveLastMileRouting.mockResolvedValue({ kind: 'defer', retryAfterMs: 30_000 });

		const result = await dispatchGovernedEmail(ctx, {
			...baseRequest,
			retryState: { attempt: 4, startedAt: Date.now(), idempotencyKey: 'send_send-row-1' },
		});

		expect(result).toMatchObject({ deferred: true, retryState: { attempt: 5 } });
	});

	it('gives a routing re-entry successor a work attempt of its own', async () => {
		// A re-entry successor that inherited `workAttemptId` would dedupe against
		// the intake receipt of the job that just surrendered ownership: the MTA
		// answers `deduplicated: true`, Convex marks the Send accepted for
		// delivery, no MTA work exists, and the Send waits `queued` for a webhook
		// that can never arrive. The handoff is always pre-SMTP, so the
		// reconciliation the flag was waiting on is resolved too.
		runMutation
			.mockResolvedValueOnce({ token: 'reentry-token', expiresAt: Date.now() })
			.mockResolvedValueOnce({ ok: true });
		resolveLastMileRouting.mockResolvedValue({
			kind: 'ready',
			providerKind: 'mta',
			route: { ipPool: 'campaign' },
			routingLease: { token: 'lease-1' },
		});
		sendProviderDispatch.mockResolvedValue({
			result: { success: true, id: 'send_send-row-1' },
			providerType: 'mta',
			latencyMs: 5,
			attempts: 1,
		});

		await dispatchGovernedEmail(ctx, {
			...baseRequest,
			retryState: {
				attempt: 2,
				startedAt: Date.now(),
				idempotencyKey: 'send_send-row-1',
				workAttemptId: 'work-attempt-from-the-unknown-acceptance',
				acceptanceReconciliation: true,
			},
		});

		// This attempt still reuses the identity it is reconciling…
		const extras = sendProviderDispatch.mock.calls[0]![3] as {
			workAttemptId: string;
			routingReentry: { retryState: Record<string, unknown> };
		};
		expect(extras.workAttemptId).toBe('work-attempt-from-the-unknown-acceptance');

		// …but what it hands a successor must not carry that identity onward, and
		// the snapshot digest must cover the same bytes the MTA will echo.
		const snapshotArgs = runMutation.mock.calls[0]![1] as {
			retryState: Record<string, unknown>;
		};
		expect(Object.keys(snapshotArgs.retryState).sort()).toEqual([
			'attempt',
			'idempotencyKey',
			'startedAt',
		]);
		expect(extras.routingReentry.retryState).toEqual(snapshotArgs.retryState);
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
	describe('relay arm — the custom return path (plan G-08)', () => {
		function relayRouting(stampRelayVerpReturnPath: boolean) {
			resolveLastMileRouting.mockResolvedValue({
				kind: 'ready',
				providerKind: 'smtp',
				route: null,
				organizationId: 'org-1',
				stampRelayVerpReturnPath,
			});
			sendProviderDispatch.mockResolvedValue({
				result: { success: true, id: 'relay-message-id' },
				providerType: 'smtp',
				latencyMs: 7,
				attempts: 1,
			});
		}

		function dispatchedExtras(): unknown {
			// Indexed rather than `.at(-1)`: convex/tsconfig.json's `lib` stops at
			// ES2021, so `Array.prototype.at` is not in the type set here.
			const calls = sendProviderDispatch.mock.calls;
			return calls[calls.length - 1]?.[3];
		}

		it('passes customReturnPath through to SmtpExtras when the relay is PROVEN', async () => {
			relayRouting(true);
			await dispatchGovernedEmail(ctx, baseRequest);
			expect(sendProviderDispatch).toHaveBeenCalledWith(ctx, 'smtp', expect.anything(), {
				customReturnPath: true,
			});
			expect(dispatchedExtras()).toEqual({ customReturnPath: true });
		});

		it('fails closed to the composer envelope sender when it is not proven', async () => {
			relayRouting(false);
			await dispatchGovernedEmail(ctx, baseRequest);
			expect(dispatchedExtras()).toEqual({ customReturnPath: false });
		});

		it('reads the capability from the ROUTING result — no extra query per send', async () => {
			// The routing pass already ran a query; a second round trip on the hot
			// send path to read a deployment-scoped fact would be pure overhead. The
			// ctx here deliberately has NO runQuery, so a reintroduced read throws.
			relayRouting(true);
			await expect(dispatchGovernedEmail(ctx, baseRequest)).resolves.toMatchObject({
				success: true,
				providerType: 'smtp',
			});
			expect((ctx as unknown as { runQuery?: unknown }).runQuery).toBeUndefined();
		});
	});
});
