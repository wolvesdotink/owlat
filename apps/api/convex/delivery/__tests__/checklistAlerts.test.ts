import { describe, expect, it, vi } from 'vitest';
import {
	REGRESSION_EMAIL_RETRY_DELAYS_MS,
	deliverRegressionEmailHandler,
	regressionEmailRetryDelay,
	type RegressionEmailDependencies,
} from '../checklistAlerts';

describe('deliverability regression email retry policy', () => {
	it('uses bounded backoff before declaring transient delivery failure unavailable', () => {
		expect(REGRESSION_EMAIL_RETRY_DELAYS_MS).toEqual([60_000, 300_000, 900_000]);
		expect(regressionEmailRetryDelay(0)).toBe(60_000);
		expect(regressionEmailRetryDelay(1)).toBe(300_000);
		expect(regressionEmailRetryDelay(2)).toBe(900_000);
		expect(regressionEmailRetryDelay(3)).toBeNull();
		expect(regressionEmailRetryDelay(100)).toBeNull();
	});

	function harness(
		recipients: string[],
		sendEmail: RegressionEmailDependencies['sendEmail'] = vi.fn(async () => undefined)
	) {
		const runMutation = vi.fn(async () => true);
		const runAfter = vi.fn(async () => undefined);
		const ctx = {
			runQuery: vi.fn(async () => ({ message: 'PTR regressed <unsafe>' })),
			runMutation,
			scheduler: { runAfter },
		} as never;
		const dependencies: RegressionEmailDependencies = {
			loadRecipients: vi.fn(async () => recipients),
			sendEmail,
		};
		return { ctx, dependencies, runMutation, runAfter };
	}

	it('marks no-recipient terminal without scheduling a retry', async () => {
		const test = harness([]);
		await expect(
			deliverRegressionEmailHandler(
				test.ctx,
				{ organizationId: 'org', identity: 'incident' },
				test.dependencies
			)
		).resolves.toMatchObject({ reason: 'no_admin_recipient' });
		expect(test.runAfter).not.toHaveBeenCalled();
		expect(test.runMutation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ state: 'unavailable' })
		);
	});

	it('retries transient delivery rejection and marks success sent', async () => {
		const rejected = harness(
			['admin@example.test'],
			vi.fn(async () => Promise.reject('busy'))
		);
		await expect(
			deliverRegressionEmailHandler(
				rejected.ctx,
				{ organizationId: 'org', identity: 'incident', attempt: 0 },
				rejected.dependencies
			)
		).resolves.toMatchObject({ reason: 'retry_scheduled' });
		expect(rejected.runAfter).toHaveBeenCalledWith(
			60_000,
			expect.anything(),
			expect.objectContaining({ attempt: 1 })
		);
		expect(rejected.runMutation).not.toHaveBeenCalled();

		const delivered = harness(['admin@example.test']);
		await expect(
			deliverRegressionEmailHandler(
				delivered.ctx,
				{ organizationId: 'org', identity: 'incident' },
				delivered.dependencies
			)
		).resolves.toEqual({ sent: true });
		expect(delivered.runMutation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ state: 'sent' })
		);
	});

	it('marks unavailable only after the transient retry budget is exhausted', async () => {
		const test = harness(
			['admin@example.test'],
			vi.fn(async () => Promise.reject('busy'))
		);
		await expect(
			deliverRegressionEmailHandler(
				test.ctx,
				{ organizationId: 'org', identity: 'incident', attempt: 3 },
				test.dependencies
			)
		).resolves.toMatchObject({ reason: 'delivery_failed' });
		expect(test.runAfter).not.toHaveBeenCalled();
		expect(test.runMutation).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ state: 'unavailable' })
		);
	});

	it('retries a transient recipient-directory failure', async () => {
		const test = harness([]);
		test.dependencies.loadRecipients = vi.fn(async () => Promise.reject('directory unavailable'));
		await expect(
			deliverRegressionEmailHandler(
				test.ctx,
				{ organizationId: 'org', identity: 'incident' },
				test.dependencies
			)
		).resolves.toMatchObject({ reason: 'retry_scheduled' });
		expect(test.runAfter).toHaveBeenCalledWith(
			60_000,
			expect.anything(),
			expect.objectContaining({ attempt: 1 })
		);
	});
});
