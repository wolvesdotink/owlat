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

function harness(
	outcome: SystemMailAttemptOutcome,
	isCurrent = true,
	locales: Record<string, string> = {}
) {
	const runQuery = vi.fn(async () => isCurrent);
	const runMutation = vi.fn(async () => undefined);
	const ctx = { runQuery, runMutation } as never;
	const deps: SendingHoldEmailDependencies = {
		loadRecipients: vi.fn(async () => [
			{ userId: 'owner', email: 'owner@example.com' },
			{ userId: 'admin', email: 'admin@example.com' },
			{ userId: 'no-address' },
		]),
		loadLocales: vi.fn(async () => new Map(Object.entries(locales))),
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
	return { ctx, deps, runMutation, runQuery };
}

/** The one commit a run makes: its outcome, and the retries it schedules. */
function committed(test: ReturnType<typeof harness>) {
	expect(test.runMutation).toHaveBeenCalledTimes(1);
	return (test.runMutation.mock.calls[0] as unknown[])[1];
}

describe('sending hold alert email', () => {
	beforeEach(() => vi.stubEnv('DEFAULT_FROM_DOMAIN', 'mail.example.com'));
	afterEach(() => vi.unstubAllEnvs());

	it('says held marketing mail can be dropped after 4 days of waiting', () => {
		expect(sendingHoldEmail(RAISED).html).toContain(
			'Mail that waits 4 days or more can be dropped.'
		);
	});

	it('escapes the stored reason', () => {
		expect(sendingHoldEmail(RAISED).html).toContain('Reason: Auto-suspended: &lt;bounce&gt; rate');
	});

	it('retries a failure the transport calls safe, for that recipient alone', async () => {
		const test = harness(failed('safe_to_retry'));
		await expect(
			deliverSendingHoldEmailHandler(test.ctx, { alert: RAISED }, test.deps)
		).resolves.toEqual({ accepted: 1, retrying: 1 });
		expect(committed(test)).toEqual({
			alert: RAISED,
			accepted: 1,
			retryUserIds: ['admin'],
			attempt: 0,
			retryDelayMs: 60_000,
		});
	});

	it('does not retry a terminal failure', async () => {
		const test = harness(failed('terminal'));
		await expect(
			deliverSendingHoldEmailHandler(test.ctx, { alert: RAISED }, test.deps)
		).resolves.toEqual({ accepted: 1, retrying: 0 });
		expect(committed(test)).toMatchObject({ accepted: 1, retryUserIds: [] });
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
		// The retry it was is settled on the record.
		expect(committed(test)).toMatchObject({ accepted: 0, retryUserIds: [], attempt: 1 });
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
		expect(committed(test)).toMatchObject({ retryDelayMs: null });
	});

	it('settles the run as nobody mailed when the directory cannot be read', async () => {
		const test = harness(failed('terminal'));
		test.deps.loadRecipients = vi.fn(async () => {
			throw new Error('directory down');
		});
		await expect(
			deliverSendingHoldEmailHandler(test.ctx, { alert: RAISED }, test.deps)
		).resolves.toEqual({ accepted: 0, retrying: 0 });
		expect(committed(test)).toMatchObject({ accepted: 0, retryUserIds: [] });
	});

	it('writes each admin the email in the language they chose', async () => {
		const test = harness(failed('terminal'), true, { admin: 'de' });
		test.deps.sendEmail = vi.fn(async () => ({
			status: 'accepted' as const,
			provider: 'resend' as const,
			providerMessageId: 'id',
			latencyMs: 1,
			attempts: 1,
		}));
		await deliverSendingHoldEmailHandler(test.ctx, { alert: RAISED }, test.deps);
		const byRecipient = Object.fromEntries(
			vi.mocked(test.deps.sendEmail).mock.calls.map(([, payload]) => [payload.to, payload])
		);
		expect(byRecipient['admin@example.com']!.subject).toBe('Owlat: Versand ausgesetzt');
		expect(byRecipient['admin@example.com']!.html).toContain(
			'Der Versand auf deiner Owlat-Instanz ist ausgesetzt.'
		);
		expect(byRecipient['admin@example.com']!.html).toContain(
			'Der Versand startet nicht von selbst wieder. Ein Plattform-Admin hebt die Sperre in der Betreiberkonsole auf.'
		);
		// The recorded reason is quoted as stored.
		expect(byRecipient['admin@example.com']!.html).toContain(
			'Grund: Auto-suspended: &lt;bounce&gt; rate'
		);
		expect(byRecipient['owner@example.com']!.subject).toBe('Owlat: sending is suspended');
	});

	it('words the automatic lift in German with German numbers', () => {
		const { html } = sendingHoldEmail(
			{
				...RAISED,
				lift: JSON.stringify({
					mode: 'automatic',
					condition: {
						trigger: 'complaint_rate',
						domain: null,
						currentPct: 0.35,
						limitPct: 0.2,
						isClear: false,
						clearsAt: null,
					},
				}),
			},
			'de'
		);
		expect(html).toContain(
			'Der Versand startet von selbst wieder, sobald die Beschwerderate der letzten 30 Tage unter 0,2 % liegt; aktuell sind es 0,35 %.'
		);
	});

	it('gives a status change while stopped its own subject and dedupe key', async () => {
		const banned: SendingHoldAlert = {
			...RAISED,
			holdStatus: 'banned',
			previousHoldStatus: 'suspended',
		};
		expect(sendingHoldEmail(banned)).toMatchObject({ subject: 'Owlat: sending is now banned' });
		expect(sendingHoldEmail(banned).html).toContain(
			'Sending on your Owlat instance was suspended and is now banned.'
		);
		expect(sendingHoldEmail(banned, 'de').subject).toBe('Owlat: Versand jetzt gesperrt');

		const first = harness(failed('terminal'));
		await deliverSendingHoldEmailHandler(first.ctx, { alert: RAISED }, first.deps);
		const second = harness(failed('terminal'));
		await deliverSendingHoldEmailHandler(second.ctx, { alert: banned }, second.deps);
		const key = (test: ReturnType<typeof harness>) =>
			vi.mocked(test.deps.sendEmail).mock.calls[0]![1].idempotencyKey;
		expect(key(second)).not.toBe(key(first));
	});
});
