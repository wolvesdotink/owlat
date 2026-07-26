import { describe, expect, it, vi } from 'vitest';
import {
	REGRESSION_EMAIL_RETRY_DELAYS_MS,
	deliverRegressionEmailHandler,
	loadDeliverabilityAlertAdminRecipients,
	regressionEmailRetryDelay,
	type RegressionEmailDependencies,
} from '../checklistAlerts';
import type { SystemMailAttemptOutcome } from '../../lib/systemMailOutcome';
import { EmailErrorCode } from '../../lib/sendProviders';

function acceptedMail(): SystemMailAttemptOutcome {
	return {
		status: 'accepted',
		provider: 'mta',
		providerMessageId: 'message-id',
		latencyMs: 1,
		attempts: 1,
	};
}

function failedMail(
	provider: 'mta' | 'resend' | 'ses',
	errorCode: EmailErrorCode,
	retryDisposition: 'safe_to_retry' | 'terminal'
): SystemMailAttemptOutcome {
	return {
		status: 'failed',
		provider,
		errorCode,
		errorMessage: 'send failed',
		retryDisposition,
	};
}

describe('deliverability regression email retry policy', () => {
	it('loads every owner and admin in an organization at the 50-member limit', async () => {
		const members = Array.from({ length: 50 }, (_, index) => ({
			userId: `user-${index.toString().padStart(2, '0')}`,
			role: index < 25 ? 'owner' : 'admin',
		}));
		const runQuery = vi.fn(async (_query, args: Record<string, unknown>) => {
			if (args['model'] === 'member') {
				const where = args['where'] as Array<{ field: string; value: string }>;
				const role = where.find((condition) => condition.field === 'role')?.value;
				return { page: members.filter((member) => member.role === role) };
			}
			const where = args['where'] as Array<{ field: string; value: string }>;
			const userId = where.find((condition) => condition.field === '_id')?.value;
			return { email: `${userId}@example.test` };
		});

		await expect(
			loadDeliverabilityAlertAdminRecipients({ runQuery } as never, 'org')
		).resolves.toEqual(
			members.map(({ userId }) => ({
				userId,
				email: `${userId}@example.test`,
			}))
		);
		expect(runQuery).toHaveBeenCalledTimes(52);
		expect(runQuery).toHaveBeenNthCalledWith(
			1,
			expect.anything(),
			expect.objectContaining({
				paginationOpts: { cursor: null, numItems: 50 },
			})
		);
		expect(runQuery).toHaveBeenNthCalledWith(
			2,
			expect.anything(),
			expect.objectContaining({
				paginationOpts: { cursor: null, numItems: 50 },
			})
		);
	});

	it('uses bounded backoff before declaring transient delivery failure unavailable', () => {
		expect(REGRESSION_EMAIL_RETRY_DELAYS_MS).toEqual([60_000, 300_000, 900_000]);
		expect(regressionEmailRetryDelay(0)).toBe(60_000);
		expect(regressionEmailRetryDelay(1)).toBe(300_000);
		expect(regressionEmailRetryDelay(2)).toBe(900_000);
		expect(regressionEmailRetryDelay(3)).toBeNull();
		expect(regressionEmailRetryDelay(100)).toBeNull();
	});

	function harness(options?: {
		recipients?: Array<{ userId: string; email?: string }>;
		claims?: Array<{ userId: string; email: string; attemptCount: number }>;
		preparedState?: 'pending' | 'sent' | 'unavailable';
		completion?: { state: 'pending' | 'sent' | 'unavailable'; retryScheduled: boolean };
		sendEmail?: RegressionEmailDependencies['sendEmail'];
		boundaryFailureRetryDisposition?: RegressionEmailDependencies['boundaryFailureRetryDisposition'];
	}) {
		const runQuery = vi.fn(
			async (): Promise<{ emailDirectoryAttemptCount?: number } | null> => ({
				emailDirectoryAttemptCount: 0,
			})
		);
		const runMutation = vi
			.fn()
			.mockResolvedValueOnce({
				message: 'PTR regressed <unsafe>',
				claims: options?.claims ?? [],
				state: options?.preparedState ?? 'unavailable',
			})
			.mockResolvedValueOnce(options?.completion ?? { state: 'sent', retryScheduled: false });
		const ctx = { runQuery, runMutation } as never;
		const dependencies: RegressionEmailDependencies = {
			loadRecipients: vi.fn(async () => options?.recipients ?? []),
			sendEmail: options?.sendEmail ?? vi.fn(async () => acceptedMail()),
			boundaryFailureRetryDisposition:
				options?.boundaryFailureRetryDisposition ?? vi.fn((): 'terminal' => 'terminal'),
			now: vi.fn(() => 10_000),
			randomId: vi.fn(() => 'attempt-token'),
		};
		return { ctx, dependencies, runQuery, runMutation };
	}

	it('records no eligible administrator as unavailable without sending', async () => {
		const test = harness();
		await expect(
			deliverRegressionEmailHandler(
				test.ctx,
				{ organizationId: 'org', identity: 'incident' },
				test.dependencies
			)
		).resolves.toEqual({ sent: false, reason: 'no_admin_recipient' });
		expect(test.dependencies.sendEmail).not.toHaveBeenCalled();
		expect(test.runMutation).toHaveBeenCalledTimes(1);
	});

	it('uses stable user identity and binds transport idempotency to the current address', async () => {
		const first = harness({
			recipients: [{ userId: 'user-1', email: 'old@example.test' }],
			claims: [{ userId: 'user-1', email: 'old@example.test', attemptCount: 1 }],
		});
		await deliverRegressionEmailHandler(
			first.ctx,
			{ organizationId: 'org', identity: 'incident' },
			first.dependencies
		);
		const firstPayload = vi.mocked(first.dependencies.sendEmail).mock.calls[0]?.[1];

		const second = harness({
			recipients: [{ userId: 'user-1', email: 'new@example.test' }],
			claims: [{ userId: 'user-1', email: 'new@example.test', attemptCount: 2 }],
		});
		await deliverRegressionEmailHandler(
			second.ctx,
			{ organizationId: 'org', identity: 'incident' },
			second.dependencies
		);
		const secondPayload = vi.mocked(second.dependencies.sendEmail).mock.calls[0]?.[1];

		expect(firstPayload).toMatchObject({ to: 'old@example.test' });
		expect(secondPayload).toMatchObject({ to: 'new@example.test' });
		expect(secondPayload?.idempotencyKey).not.toBe(firstPayload?.idempotencyKey);
		expect(firstPayload?.html).toContain('&lt;unsafe&gt;');
	});

	it('persists partial results and retries only the failed stable user id', async () => {
		const sendEmail = vi.fn(async (_ctx, payload: { to: string }) => {
			if (payload.to === 'failed@example.test') {
				return failedMail('mta', EmailErrorCode.SERVER_ERROR, 'safe_to_retry');
			}
			return acceptedMail();
		});
		const test = harness({
			recipients: [
				{ userId: 'sent-user', email: 'sent@example.test' },
				{ userId: 'failed-user', email: 'failed@example.test' },
			],
			claims: [
				{ userId: 'sent-user', email: 'sent@example.test', attemptCount: 1 },
				{ userId: 'failed-user', email: 'failed@example.test', attemptCount: 1 },
			],
			completion: { state: 'pending', retryScheduled: true },
			sendEmail,
		});

		await expect(
			deliverRegressionEmailHandler(
				test.ctx,
				{ organizationId: 'org', identity: 'incident' },
				test.dependencies
			)
		).resolves.toEqual({ sent: true, reason: 'retry_scheduled' });
		expect(test.runMutation).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({
				attemptToken: 'attempt-token',
				results: [
					{ userId: 'sent-user', isSuccess: true },
					{ userId: 'failed-user', isSuccess: false, retryAt: 70_000 },
				],
			})
		);
	});

	it('does not retry an ambiguous SES outcome that could already have delivered', async () => {
		const test = harness({
			recipients: [{ userId: 'user-1', email: 'admin@example.test' }],
			claims: [{ userId: 'user-1', email: 'admin@example.test', attemptCount: 1 }],
			completion: { state: 'unavailable', retryScheduled: false },
			sendEmail: vi.fn(async () => failedMail('ses', EmailErrorCode.AMBIGUOUS_TIMEOUT, 'terminal')),
		});

		await expect(
			deliverRegressionEmailHandler(
				test.ctx,
				{ organizationId: 'org', identity: 'incident' },
				test.dependencies
			)
		).resolves.toEqual({ sent: false, reason: 'delivery_failed' });
		expect(test.runMutation).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({
				results: [{ userId: 'user-1', isSuccess: false }],
			})
		);
	});

	it('retries a typed SES server rejection known to occur before acceptance', async () => {
		const test = harness({
			recipients: [{ userId: 'user-1', email: 'admin@example.test' }],
			claims: [{ userId: 'user-1', email: 'admin@example.test', attemptCount: 1 }],
			completion: { state: 'pending', retryScheduled: true },
			sendEmail: vi.fn(async () => failedMail('ses', EmailErrorCode.SERVER_ERROR, 'safe_to_retry')),
		});

		await expect(
			deliverRegressionEmailHandler(
				test.ctx,
				{ organizationId: 'org', identity: 'incident' },
				test.dependencies
			)
		).resolves.toEqual({ sent: false, reason: 'retry_scheduled' });
		expect(test.runMutation).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({
				results: [{ userId: 'user-1', isSuccess: false, retryAt: 70_000 }],
			})
		);
	});

	it('does not retry a permanent recipient rejection', async () => {
		const test = harness({
			recipients: [{ userId: 'user-1', email: 'invalid@example.test' }],
			claims: [{ userId: 'user-1', email: 'invalid@example.test', attemptCount: 1 }],
			completion: { state: 'unavailable', retryScheduled: false },
			sendEmail: vi.fn(async () => failedMail('mta', EmailErrorCode.INVALID_RECIPIENT, 'terminal')),
		});

		await deliverRegressionEmailHandler(
			test.ctx,
			{ organizationId: 'org', identity: 'incident' },
			test.dependencies
		);
		expect(test.runMutation).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({
				results: [{ userId: 'user-1', isSuccess: false }],
			})
		);
	});

	it.each([
		{ provider: 'mta', disposition: 'safe_to_retry' as const, isRetried: true },
		{ provider: 'resend', disposition: 'safe_to_retry' as const, isRetried: true },
		{ provider: 'ses', disposition: 'terminal' as const, isRetried: false },
		{ provider: 'plugin', disposition: 'terminal' as const, isRetried: false },
	])(
		'classifies a generic $provider action-boundary failure without parsing its message',
		async ({ disposition, isRetried }) => {
			const test = harness({
				recipients: [{ userId: 'user-1', email: 'admin@example.test' }],
				claims: [{ userId: 'user-1', email: 'admin@example.test', attemptCount: 1 }],
				completion: isRetried
					? { state: 'pending', retryScheduled: true }
					: { state: 'unavailable', retryScheduled: false },
				sendEmail: vi.fn(async () => {
					throw new Error('generic action boundary failure');
				}),
				boundaryFailureRetryDisposition: vi.fn(() => disposition),
			});

			await expect(
				deliverRegressionEmailHandler(
					test.ctx,
					{ organizationId: 'org', identity: 'incident' },
					test.dependencies
				)
			).resolves.toMatchObject(
				isRetried ? { reason: 'retry_scheduled' } : { reason: 'delivery_failed' }
			);
			expect(test.runMutation).toHaveBeenLastCalledWith(
				expect.anything(),
				expect.objectContaining({
					results: [
						{
							userId: 'user-1',
							isSuccess: false,
							...(isRetried ? { retryAt: 70_000 } : {}),
						},
					],
				})
			);
		}
	);

	it('durably schedules recipient-directory retries and stops at the bound', async () => {
		const retrying = harness();
		retrying.dependencies.loadRecipients = vi.fn(async () => {
			throw new Error('directory unavailable');
		});
		retrying.runMutation.mockReset().mockResolvedValue({
			state: 'pending',
			retryScheduled: true,
		});
		await expect(
			deliverRegressionEmailHandler(
				retrying.ctx,
				{ organizationId: 'org', identity: 'incident' },
				retrying.dependencies
			)
		).resolves.toEqual({ sent: false, reason: 'retry_scheduled' });
		expect(retrying.runMutation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ retryAt: 70_000 })
		);

		const exhausted = harness();
		exhausted.runQuery.mockResolvedValue({ emailDirectoryAttemptCount: 3 });
		exhausted.dependencies.loadRecipients = retrying.dependencies.loadRecipients;
		exhausted.runMutation.mockReset().mockResolvedValue({
			state: 'unavailable',
			retryScheduled: false,
		});
		await expect(
			deliverRegressionEmailHandler(
				exhausted.ctx,
				{ organizationId: 'org', identity: 'incident' },
				exhausted.dependencies
			)
		).resolves.toEqual({ sent: false, reason: 'delivery_failed' });
		expect(exhausted.runMutation).toHaveBeenCalledWith(
			expect.anything(),
			expect.not.objectContaining({ retryAt: expect.anything() })
		);
	});

	it('cancels immediately after the alert resolves', async () => {
		const test = harness();
		test.runQuery.mockResolvedValue(null);
		await expect(
			deliverRegressionEmailHandler(
				test.ctx,
				{ organizationId: 'org', identity: 'incident' },
				test.dependencies
			)
		).resolves.toEqual({ sent: false, reason: 'not_pending' });
		expect(test.dependencies.loadRecipients).not.toHaveBeenCalled();
		expect(test.runMutation).not.toHaveBeenCalled();
	});
});
