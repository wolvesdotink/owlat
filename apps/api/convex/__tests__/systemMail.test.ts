import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../_generated/server';
import { attemptSystemEmail } from '../systemMail';
import { EmailErrorCode } from '../lib/sendProviders';

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('system mail attempt outcomes', () => {
	it('marks an SES readiness-check failure as safely retryable before dispatch', async () => {
		vi.stubEnv('EMAIL_PROVIDER', 'ses');
		const ctx = {
			runQuery: vi.fn(async () => {
				throw new Error('readiness service unavailable');
			}),
		} as unknown as ActionCtx;

		await expect(
			attemptSystemEmail(ctx, {
				to: 'admin@example.test',
				from: 'Owlat <noreply@example.test>',
				subject: 'Deliverability regression',
				html: '<p>Regression</p>',
				idempotencyKey: 'stable-attempt-key',
			})
		).resolves.toEqual({
			status: 'failed',
			provider: 'ses',
			errorCode: EmailErrorCode.SERVER_ERROR,
			errorMessage: 'readiness service unavailable',
			retryDisposition: 'safe_to_retry',
		});
	});
});
