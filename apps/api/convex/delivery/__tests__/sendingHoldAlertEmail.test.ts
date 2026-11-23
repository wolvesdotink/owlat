import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailErrorCode } from '../../lib/sendProviders';
import type { SystemMailAttemptOutcome } from '../../lib/systemMailOutcome';
import {
	deliverSendingHoldEmailHandler,
	sendingHoldEmail,
	type SendingHoldEmailDependencies,
} from '../sendingHoldAlertEmail';
import type { SendingHoldAlert } from '../sendingHoldAlerts';

const RAISED: SendingHoldAlert = {
	kind: 'raised',
	alertId: 'sending_hold:1000',
	holdStatus: 'suspended',
	reason: 'Auto-suspended: <bounce> rate',
	lift: JSON.stringify({ mode: 'admin', condition: null }),
	nextAction: 'It does not lift by itself. A platform admin lifts it in the Operator console.',
	at: 1000,
	emailMayNotArrive: false,
};

function failed(retryDisposition: 'safe_to_retry' | 'terminal'): SystemMailAttemptOutcome {
	return {
		status: 'failed',
		provider: 'resend',
		errorCode: EmailErrorCode.SERVER_ERROR,
		errorMessage: 'down',
		retryDisposition,
	};
}

function harness(outcome: SystemMailAttemptOutcome, isCurrent = true) {
	const runAfter = vi.fn(async () => undefined);
	const runQuery = vi.fn(async () => isCurrent);
	const ctx = { runQuery, scheduler: { runAfter } } as never;
	const deps: SendingHoldEmailDependencies = {
		loadRecipients: vi.fn(async () => [
			{ userId: 'owner', email: 'owner@example.com' },
			{ userId: 'admin', email: 'admin@example.com' },
			{ userId: 'no-address' },
		]),
		sendEmail: vi.fn(async (_ctx, payload) =>
			payload.to === 'admin@example.com'
				? outcome
				: ({
						status: 'accepted',
						provider: 'resend',
						providerMessageId: 'id',
						latencyMs: 1,
						attempts: 1,
					} as const)
		),
	};
	return { ctx, deps, runAfter, runQuery };
}

describe('sending hold alert email', () => {
	beforeEach(() => vi.stubEnv('DEFAULT_FROM_DOMAIN', 'mail.example.com'));
	afterEach(() => vi.unstubAllEnvs());

	it('says queued marketing mail is dropped after its 4-day delivery limit', () => {
		expect(sendingHoldEmail(RAISED).html).toContain(
			'Mail still waiting 4 days after its send started is not sent.'
		);
		expect(
			sendingHoldEmail({
				kind: 'resolved',
				alertId: RAISED.alertId,
				holdStatus: 'suspended',
				reason: 'Auto-cleared',
				resolution: 'automatic',
				at: 2000,
			}).html
		).toContain('unless their send started more than 4 days ago');
	});

	it('escapes the stored reason', () => {
		expect(sendingHoldEmail(RAISED).html).toContain('Reason: Auto-suspended: &lt;bounce&gt; rate');
	});

	it('retries a failure the transport calls safe, for that recipient alone', async () => {
		const test = harness(failed('safe_to_retry'));
		await expect(
			deliverSendingHoldEmailHandler(test.ctx, { alert: RAISED }, test.deps)
		).resolves.toEqual({ accepted: 1, retrying: 1 });
		expect(test.runAfter).toHaveBeenCalledTimes(1);
		expect(test.runAfter).toHaveBeenCalledWith(60_000, expect.anything(), {
			alert: RAISED,
			userId: 'admin',
			attempt: 1,
		});
	});

	it('does not retry a terminal failure', async () => {
		const test = harness(failed('terminal'));
		await expect(
			deliverSendingHoldEmailHandler(test.ctx, { alert: RAISED }, test.deps)
		).resolves.toEqual({ accepted: 1, retrying: 0 });
		expect(test.runAfter).not.toHaveBeenCalled();
	});

	it('drops a retry once sending is no longer as the email says', async () => {
		const test = harness(failed('safe_to_retry'), false);
		await expect(
			deliverSendingHoldEmailHandler(
				test.ctx,
				{ alert: RAISED, userId: 'admin', attempt: 1 },
				test.deps
			)
		).resolves.toEqual({ accepted: 0, retrying: 0 });
		expect(test.deps.sendEmail).not.toHaveBeenCalled();
	});

	it('gives up after the last retry delay', async () => {
		const test = harness(failed('safe_to_retry'));
		await expect(
			deliverSendingHoldEmailHandler(
				test.ctx,
				{ alert: RAISED, userId: 'admin', attempt: 3 },
				test.deps
			)
		).resolves.toEqual({ accepted: 0, retrying: 0 });
		expect(test.runAfter).not.toHaveBeenCalled();
	});
});
