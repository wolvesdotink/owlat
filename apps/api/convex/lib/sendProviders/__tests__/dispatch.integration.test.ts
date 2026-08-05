import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { convexTest, type TestConvex } from 'convex-test';
import { getFunctionName, type FunctionReference } from 'convex/server';
import schema from '../../../schema';
import { internal } from '../../../_generated/api';
import { modules } from '../../../__tests__/testModules';
import { sendProviderDispatch } from '../dispatch';
import { mtaSendProvider } from '../mta';
import { sesSendProvider } from '../ses';
import { resendSendProvider } from '../resend';
import { mandrillSendProvider, _resetMandrillConfigCacheForTests } from '../mandrill';
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
	delays: readonly number[]
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
		runAfter: (ms: number, fn: unknown, args: ScheduledRecord) => Promise<void>;
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

		const out = await sendProviderDispatch(ctx as never, 'mta', sampleParams);

		expect(out.attempts).toBe(1);
		expect(out.providerType).toBe('mta');
		expect(out.result).toEqual({ success: true, id: 'msg-1' });
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]).toMatchObject({ providerType: 'mta', success: true });
	});

	it('a durable test-preview attempt still records provider health', async () => {
		const { ctx, scheduled } = buildFakeCtx();
		vi.spyOn(mtaSendProvider, 'sendEmail').mockResolvedValueOnce({
			success: true,
			id: 'send_test-row-1',
		});

		await sendProviderDispatch(ctx as never, 'mta', sampleParams, {
			messageId: 'send_test-row-1',
			workAttemptId: 'test-work-1',
			routingReentryToken: 'rr1.test-token',
			organizationId: 'org-1',
			messageType: 'transactional',
			routingLease: 'lease-1',
			routingReentry: {
				envelopeInput: { kind: 'transactional', sendId: 'test-row-1' },
				retryState: { attempt: 2, startedAt: 1, idempotencyKey: 'send_test-row-1' },
			},
		});

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

		const out = await sendProviderDispatch(ctx as never, 'mta', sampleParams);

		expect(sendSpy).toHaveBeenCalledTimes(2);
		expect(out.attempts).toBe(2);
		expect(out.result).toEqual({ success: true, id: 'msg-after-retry' });
		// Critical: health recorded once, only on terminal outcome.
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]).toMatchObject({ success: true });
	});

	it('preserves acceptance_unknown after every MTA intake response is lost', async () => {
		const { ctx, scheduled } = buildFakeCtx();
		const lost = {
			success: false as const,
			errorMessage: 'network response lost',
			errorCode: EmailErrorCode.SERVER_ERROR,
			acceptanceUnknown: true as const,
		};
		const sendSpy = vi.spyOn(mtaSendProvider, 'sendEmail').mockResolvedValue(lost);

		const out = await sendProviderDispatch(ctx as never, 'mta', sampleParams, {
			messageId: 'send-stable',
			workAttemptId: 'work-stable',
		});

		expect(sendSpy).toHaveBeenCalledTimes(3);
		// Args are (transport, params, extras) since dispatch became transport-keyed.
		expect(sendSpy.mock.calls.every((call) => call[0]?.id === 'mta')).toBe(true);
		expect(sendSpy.mock.calls.every((call) => call[2]?.workAttemptId === 'work-stable')).toBe(true);
		expect(out.result).toEqual(lost);
		expect(scheduled).toHaveLength(1);
	});

	it('exhausted retries: attempts=retryDelays.length+1, health recorded { success: false }', async () => {
		const { ctx, scheduled } = buildFakeCtx();
		const failedAttempt: EmailSendAttempt = {
			success: false,
			errorMessage: '500 server',
			errorCode: EmailErrorCode.SERVER_ERROR,
		};
		vi.spyOn(mtaSendProvider, 'sendEmail').mockResolvedValue(failedAttempt);

		const out = await sendProviderDispatch(ctx as never, 'mta', sampleParams);

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

		const out = await sendProviderDispatch(ctx as never, 'mta', sampleParams);

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

		const out = await sendProviderDispatch(ctx as never, 'mta', sampleParams);

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

		const out = await sendProviderDispatch(ctx as never, 'mta', sampleParams);

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

			const out = await sendProviderDispatch(ctx as never, 'mta', sampleParams);

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
			const sendSpy = vi.spyOn(resendSendProvider, 'sendEmail').mockResolvedValue({
				success: false,
				errorMessage: 'rate_limit_exceeded',
				errorCode: EmailErrorCode.RATE_LIMIT,
			});

			const out = await sendProviderDispatch(ctx as never, 'resend', sampleParams);

			expect(sendSpy).toHaveBeenCalledTimes(4);
			expect(out.attempts).toBe(4);
		} finally {
			setRetryDelays(resendSendProvider, original);
		}
	});

	it('Mandrill exhausts at 4 attempts (1 + retryDelays.length of 3)', async () => {
		const original = mandrillSendProvider.retryDelays;
		setRetryDelays(mandrillSendProvider, [0, 0, 0]);
		try {
			const { ctx } = buildFakeCtx();
			const sendSpy = vi.spyOn(mandrillSendProvider, 'sendEmail').mockResolvedValue({
				success: false,
				errorMessage: 'GeneralError: hourly quota exceeded',
				errorCode: EmailErrorCode.RATE_LIMIT,
			});

			const out = await sendProviderDispatch(ctx as never, 'mandrill', sampleParams);

			expect(sendSpy).toHaveBeenCalledTimes(4);
			expect(out.attempts).toBe(4);
			expect(out.providerType).toBe('mandrill');
		} finally {
			setRetryDelays(mandrillSendProvider, original);
		}
	});

	it('Mandrill STOPS at one attempt on an ambiguous timeout (D4)', async () => {
		// The counterweight to the row above: a retryable code exhausts the whole
		// schedule, but `AMBIGUOUS_TIMEOUT` must never spend even one retry — the
		// message may already be in the recipient's inbox.
		const original = mandrillSendProvider.retryDelays;
		setRetryDelays(mandrillSendProvider, [0, 0, 0]);
		try {
			const { ctx } = buildFakeCtx();
			const sendSpy = vi.spyOn(mandrillSendProvider, 'sendEmail').mockResolvedValue({
				success: false,
				errorMessage: 'Mandrill send timed out',
				errorCode: EmailErrorCode.AMBIGUOUS_TIMEOUT,
				acceptanceUnknown: true,
			});

			const out = await sendProviderDispatch(ctx as never, 'mandrill', sampleParams);

			expect(sendSpy).toHaveBeenCalledTimes(1);
			expect(out.attempts).toBe(1);
		} finally {
			setRetryDelays(mandrillSendProvider, original);
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

			const out = await sendProviderDispatch(ctx as never, 'ses', sampleParams);

			expect(sendSpy).toHaveBeenCalledTimes(4);
			expect(out.attempts).toBe(4);
		} finally {
			setRetryDelays(sesSendProvider, original);
		}
	});
});

/**
 * MANDRILL, END TO END THROUGH THE DISPATCH LOOP (P1.3).
 *
 * Everything above mocks `sendEmail` to exercise the retry loop; this one lets
 * the real adapter run against a mocked network and follows the two artefacts a
 * send leaves behind, because both are read by machinery that would otherwise
 * discover a break in production:
 *
 *   - `providerHealth` — `resolveRoute`'s failover input. A kind that never got
 *     a row would be permanently "unknown health" and `priority_failover` would
 *     never route around it. The mutation is scheduled, so the health write is
 *     asserted by RUNNING it, not by inspecting the scheduler call.
 *   - the accepted message's `_id`. It is the join key every Mandrill webhook
 *     event arrives with (P2.1 matches on `by_provider_message_id`), and
 *     `governedDispatch` stores `dispatched.result.id` verbatim as
 *     `providerMessageId` for every non-MTA transport. An adapter that returned
 *     its own idempotency key instead would strand every bounce, complaint and
 *     unsubscribe for the reference arm — silently, since the send succeeded.
 */
describe('sendProviderDispatch — Mandrill against a mocked network', () => {
	const MANDRILL_ID = 'md-abc123XYZ';

	beforeEach(() => {
		vi.stubEnv('MANDRILL_API_KEY', 'md-test-key');
		_resetMandrillConfigCacheForTests();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		_resetMandrillConfigCacheForTests();
	});

	/**
	 * A dispatch ctx whose scheduler actually RUNS what dispatch schedules,
	 * against a real backend — so `providerHealth` is asserted as a stored row
	 * rather than as an intention to write one.
	 */
	function buildHealthRecordingCtx(t: TestConvex<typeof schema>) {
		return {
			scheduler: {
				async runAfter(
					_ms: number,
					reference: FunctionReference<'mutation'>,
					args: { providerType: string; success: boolean; latencyMs: number }
				) {
					// Exactly one thing is scheduled on the core path; naming it here
					// keeps this from silently running a different mutation than the
					// dispatch loop asked for.
					expect(getFunctionName(reference)).toBe('lib/sendProviders/health:recordSendResult');
					await t.mutation(internal.lib.sendProviders.health.recordSendResult, args);
				},
			},
		};
	}

	it('returns the Mandrill `_id` as the message id and writes a mandrill health row', async () => {
		const t = convexTest(schema, modules);
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response(
					JSON.stringify([{ email: sampleParams.to, status: 'queued', _id: MANDRILL_ID }]),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				)
			);

		const out = await sendProviderDispatch(
			buildHealthRecordingCtx(t) as never,
			'mandrill',
			sampleParams
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(out).toMatchObject({
			providerType: 'mandrill',
			transportId: 'mandrill',
			attempts: 1,
			result: { success: true, id: MANDRILL_ID },
		});

		const health = await t.run(async (ctx) => await ctx.db.query('providerHealth').collect());
		expect(health).toHaveLength(1);
		expect(health[0]).toMatchObject({
			providerType: 'mandrill',
			status: 'healthy',
			recentSuccesses: 1,
			recentFailures: 0,
		});
	});

	it('records the failure side of the same row when Mandrill rejects the recipient', async () => {
		// A 200 with a `rejected` entry: the HTTP call succeeded and the send did
		// not. Health has to see the send, or a hard-bouncing relay would keep
		// reading `healthy` to every strategy that consults it.
		const t = convexTest(schema, modules);
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify([
					{ email: sampleParams.to, status: 'rejected', reject_reason: 'hard-bounce' },
				]),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		);

		const out = await sendProviderDispatch(
			buildHealthRecordingCtx(t) as never,
			'mandrill',
			sampleParams
		);

		expect(out.result.success).toBe(false);
		// A rejected recipient is not retryable, so the schedule is not spent.
		expect(out.attempts).toBe(1);
		const health = await t.run(async (ctx) => await ctx.db.query('providerHealth').collect());
		expect(health[0]).toMatchObject({ providerType: 'mandrill', recentFailures: 1 });
	});
});
