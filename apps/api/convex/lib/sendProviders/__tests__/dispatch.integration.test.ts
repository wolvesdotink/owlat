import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendProviderDispatch } from '../dispatch';
import { mtaSendProvider } from '../mta';
import { sesSendProvider } from '../ses';
import { resendSendProvider } from '../resend';
import {
	EmailErrorCode,
	type EmailSendAttempt,
	type SendProviderKind,
	type SendProviderModule,
} from '../types';

/**
 * Strip `readonly` to override a provider's retry schedule for a test, then
 * restore it. The dispatch loop only reads `retryDelays.length`, so swapping
 * in zero-delay arrays keeps the attempt count while removing wall-clock waits.
 */
type WritableRetryDelays = { retryDelays: readonly number[] };
function setRetryDelays(
	provider: SendProviderModule<SendProviderKind>,
	delays: readonly number[],
): void {
	(provider as unknown as WritableRetryDelays).retryDelays = delays;
}

type ScheduledRecord = {
	providerType: string;
	success: boolean;
	latencyMs: number;
};

interface FakeActionCtx {
	scheduler: {
		runAfter: (
			ms: number,
			fn: unknown,
			args: ScheduledRecord,
		) => Promise<void>;
	};
}

function buildFakeCtx(): { ctx: FakeActionCtx; scheduled: ScheduledRecord[] } {
	const scheduled: ScheduledRecord[] = [];
	const ctx: FakeActionCtx = {
		scheduler: {
			async runAfter(_ms, _fn, args) {
				scheduled.push(args);
			},
		},
	};
	return { ctx, scheduled };
}

const sampleParams = {
	to: 'to@example.com',
	from: 'from@example.com',
	subject: 'subject',
	html: '<p>hi</p>',
};

describe('sendProviderDispatch — retry semantics', () => {
	let originalDelays: readonly number[];

	beforeEach(() => {
		// Speed up tests by replacing the MTA retry schedule with zero-delay
		// values. The number of attempts (3 = 1 + retry × 2) is what we care
		// about; the wall-clock waits aren't.
		originalDelays = mtaSendProvider.retryDelays;
		setRetryDelays(mtaSendProvider, [0, 0]);
	});

	afterEach(() => {
		setRetryDelays(mtaSendProvider, originalDelays);
		vi.restoreAllMocks();
	});

	it('first-attempt success: attempts=1, health recorded { success: true }', async () => {
		const { ctx, scheduled } = buildFakeCtx();
		vi.spyOn(mtaSendProvider, 'sendEmail').mockResolvedValueOnce({
			success: true,
			id: 'msg-1',
		} satisfies EmailSendAttempt);

		const out = await sendProviderDispatch(
			ctx as never,
			'mta',
			sampleParams,
		);

		expect(out.attempts).toBe(1);
		expect(out.providerType).toBe('mta');
		expect(out.result).toEqual({ success: true, id: 'msg-1' });
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]).toMatchObject({ providerType: 'mta', success: true });
	});

	it('retryable failure → retry → success: attempts>1, health recorded ONCE { success: true }', async () => {
		const { ctx, scheduled } = buildFakeCtx();
		const sendSpy = vi
			.spyOn(mtaSendProvider, 'sendEmail')
			.mockResolvedValueOnce({
				success: false,
				errorMessage: '500 server',
				errorCode: EmailErrorCode.SERVER_ERROR,
			})
			.mockResolvedValueOnce({ success: true, id: 'msg-after-retry' });

		const out = await sendProviderDispatch(
			ctx as never,
			'mta',
			sampleParams,
		);

		expect(sendSpy).toHaveBeenCalledTimes(2);
		expect(out.attempts).toBe(2);
		expect(out.result).toEqual({ success: true, id: 'msg-after-retry' });
		// Critical: health recorded once, only on terminal outcome.
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]).toMatchObject({ success: true });
	});

	it('exhausted retries: attempts=retryDelays.length+1, health recorded { success: false }', async () => {
		const { ctx, scheduled } = buildFakeCtx();
		const failedAttempt: EmailSendAttempt = {
			success: false,
			errorMessage: '500 server',
			errorCode: EmailErrorCode.SERVER_ERROR,
		};
		vi.spyOn(mtaSendProvider, 'sendEmail').mockResolvedValue(failedAttempt);

		const out = await sendProviderDispatch(
			ctx as never,
			'mta',
			sampleParams,
		);

		expect(out.attempts).toBe(mtaSendProvider.retryDelays.length + 1);
		expect(out.result.success).toBe(false);
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]).toMatchObject({ success: false });
	});

	it('non-retryable failure on first attempt: attempts=1, no retry sleep', async () => {
		const { ctx, scheduled } = buildFakeCtx();
		const sendSpy = vi.spyOn(mtaSendProvider, 'sendEmail').mockResolvedValue({
			success: false,
			errorMessage: 'Invalid recipient address',
			errorCode: EmailErrorCode.INVALID_RECIPIENT,
		});

		const out = await sendProviderDispatch(
			ctx as never,
			'mta',
			sampleParams,
		);

		expect(sendSpy).toHaveBeenCalledTimes(1);
		expect(out.attempts).toBe(1);
		expect(out.result.success).toBe(false);
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]).toMatchObject({ success: false });
	});

	it('RATE_LIMIT is retryable', async () => {
		const { ctx } = buildFakeCtx();
		const sendSpy = vi
			.spyOn(mtaSendProvider, 'sendEmail')
			.mockResolvedValueOnce({
				success: false,
				errorMessage: 'rate limit',
				errorCode: EmailErrorCode.RATE_LIMIT,
			})
			.mockResolvedValueOnce({ success: true, id: 'ok' });

		const out = await sendProviderDispatch(
			ctx as never,
			'mta',
			sampleParams,
		);

		expect(sendSpy).toHaveBeenCalledTimes(2);
		expect(out.result.success).toBe(true);
	});

	it('latencyMs accumulates across all attempts', async () => {
		const { ctx, scheduled } = buildFakeCtx();
		vi.spyOn(mtaSendProvider, 'sendEmail').mockResolvedValue({
			success: false,
			errorMessage: '500',
			errorCode: EmailErrorCode.SERVER_ERROR,
		});

		const out = await sendProviderDispatch(
			ctx as never,
			'mta',
			sampleParams,
		);

		expect(out.latencyMs).toBeGreaterThanOrEqual(0);
		expect(scheduled[0]?.latencyMs).toBe(out.latencyMs);
	});
});

describe('sendProviderDispatch — per-provider retry counts', () => {
	afterEach(() => vi.restoreAllMocks());

	it('MTA exhausts at 3 attempts (1 + retryDelays.length of 2)', async () => {
		// Skip the retry delays for speed.
		const original = mtaSendProvider.retryDelays;
		setRetryDelays(mtaSendProvider, [0, 0]);
		try {
			const { ctx } = buildFakeCtx();
			const sendSpy = vi.spyOn(mtaSendProvider, 'sendEmail').mockResolvedValue({
				success: false,
				errorMessage: '500',
				errorCode: EmailErrorCode.SERVER_ERROR,
			});

			const out = await sendProviderDispatch(
				ctx as never,
				'mta',
				sampleParams,
			);

			expect(sendSpy).toHaveBeenCalledTimes(3);
			expect(out.attempts).toBe(3);
		} finally {
			setRetryDelays(mtaSendProvider, original);
		}
	});

	it('Resend exhausts at 4 attempts (1 + retryDelays.length of 3)', async () => {
		const original = resendSendProvider.retryDelays;
		setRetryDelays(resendSendProvider, [0, 0, 0]);
		try {
			const { ctx } = buildFakeCtx();
			const sendSpy = vi
				.spyOn(resendSendProvider, 'sendEmail')
				.mockResolvedValue({
					success: false,
					errorMessage: 'rate_limit_exceeded',
					errorCode: EmailErrorCode.RATE_LIMIT,
				});

			const out = await sendProviderDispatch(
				ctx as never,
				'resend',
				sampleParams,
			);

			expect(sendSpy).toHaveBeenCalledTimes(4);
			expect(out.attempts).toBe(4);
		} finally {
			setRetryDelays(resendSendProvider, original);
		}
	});

	it('SES exhausts at 4 attempts (1 + retryDelays.length of 3)', async () => {
		const original = sesSendProvider.retryDelays;
		setRetryDelays(sesSendProvider, [0, 0, 0]);
		try {
			const { ctx } = buildFakeCtx();
			const sendSpy = vi.spyOn(sesSendProvider, 'sendEmail').mockResolvedValue({
				success: false,
				errorMessage: 'Throttling',
				errorCode: EmailErrorCode.RATE_LIMIT,
			});

			const out = await sendProviderDispatch(
				ctx as never,
				'ses',
				sampleParams,
			);

			expect(sendSpy).toHaveBeenCalledTimes(4);
			expect(out.attempts).toBe(4);
		} finally {
			setRetryDelays(sesSendProvider, original);
		}
	});
});
