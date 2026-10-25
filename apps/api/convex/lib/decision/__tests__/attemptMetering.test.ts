/**
 * The decision plane meters every provider request. The
 * language-backed adapter retries inside `runLlmObject`, so one dispatch
 * attempt can be three billed requests; a per-attempt row (or the attempt
 * limiter alone) would miss two of them. Here the real adapter runs over a
 * mocked AI SDK and the recorder sees every request, numbered across the
 * whole logical call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sdk = vi.hoisted(() => ({ generateObject: vi.fn() }));
vi.mock('ai', async () => ({
	...(await vi.importActual<object>('ai')),
	generateObject: (args: unknown) => sdk.generateObject(args),
}));

import { runDecision, type DecisionAttemptRecord } from '../dispatch';
import { attemptRequests, isThrottledError, localTag } from '../attemptRequests';
import { decisionUsageRecorder } from '../ports';
import { noul } from '../questions';
import { LlmCallMeter } from '../../llm/requestMeter';
import { withFakeBackoff } from '../../llm/__tests__/backoffClock.testlib';

const questions = { needsReply: noul('Does this need a reply?') };
const usage = { inputTokens: 100, outputTokens: 4, totalTokens: 104 };
const overloaded = () => Object.assign(new Error('overloaded'), { statusCode: 503 });

// A block body: a function returned from beforeEach would run as a teardown.
beforeEach(() => {
	sdk.generateObject.mockReset();
});

describe('decision metering', () => {
	it('records each inner retry of the language-backed adapter as its own request', async () => {
		sdk.generateObject
			.mockRejectedValueOnce(overloaded())
			.mockRejectedValueOnce(overloaded())
			.mockResolvedValueOnce({ object: { needsReply: 0.8 }, usage });
		const records: DecisionAttemptRecord[] = [];

		await withFakeBackoff(() =>
			runDecision({
				feature: 'inbound_triage',
				task: 'mail.triage',
				root: { rootRequestId: 'team:m1' },
				state: 'Subject: hello',
				questions,
				provider: { kind: 'llm', config: {}, model: 'gpt-4.1-mini' },
				allowance: { allowed: true, fallbackAllowed: false },
				recordUsage: (record) => {
					records.push(record);
				},
			})
		);

		// One dispatch attempt (the adapter retries itself), three requests.
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ task: 'mail.triage', root: { rootRequestId: 'team:m1' } });
		expect(records[0]!.requests.map((r) => [r.attempt, r.outcome, r.usage?.totalTokens])).toEqual([
			[1, 'failed', undefined],
			[2, 'failed', undefined],
			[3, 'ok', 104],
		]);
	});

	it('enforces the root deadline on every adapter: an expired root reaches no provider', async () => {
		const ask = vi.fn();
		await expect(
			runDecision({
				feature: 'inbound_triage',
				root: { rootRequestId: 'team:m1', deadlineAt: Date.now() - 1 },
				state: 'Subject: hello',
				questions,
				provider: { kind: 'llm', config: {}, model: 'gpt-4.1-mini' },
				allowance: { allowed: true, fallbackAllowed: false },
				recordUsage: ask,
			})
		).rejects.toThrow();
		expect(sdk.generateObject).not.toHaveBeenCalled();
	});

	it('cancels a request that outlives the root deadline, and records it', async () => {
		sdk.generateObject.mockImplementation(
			({ abortSignal }: { abortSignal: AbortSignal }) =>
				new Promise((_resolve, reject) =>
					abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true })
				)
		);
		const records: DecisionAttemptRecord[] = [];
		await expect(
			runDecision({
				feature: 'inbound_triage',
				root: { rootRequestId: 'team:m1', deadlineAt: Date.now() + 40 },
				state: 'Subject: hello',
				questions,
				provider: { kind: 'llm', config: {}, model: 'gpt-4.1-mini' },
				allowance: { allowed: true, fallbackAllowed: false },
				recordUsage: (record) => {
					records.push(record);
				},
			})
		).rejects.toThrow();
		expect(records).toHaveLength(1);
		expect(records[0]!.requests).toEqual([expect.objectContaining({ outcome: 'failed' })]);
	});

	it('keeps a request whose row write failed for the next attempt’s write', async () => {
		sdk.generateObject.mockResolvedValue({ object: { needsReply: 0.8 }, usage });
		const meter = new LlmCallMeter();
		const pending = attemptRequests(meter, 0, { outcome: 'failed' }, 5);
		// Not acknowledged (the write failed): still pending at the next attempt.
		expect(attemptRequests(meter, 1, { outcome: 'ok' }, 5).map((r) => r.attempt)).toEqual([
			pending[0]!.attempt,
			2,
		]);
	});

	it('keeps each attempt’s own tags when an earlier write failed and its request rides along', () => {
		const meter = new LlmCallMeter();
		// Attempt 1 on the primary, uncalibrated failure; its row write fails.
		attemptRequests(
			meter,
			0,
			{ outcome: 'failed' },
			5,
			Object.assign(new Error('x'), { status: 503 }),
			{
				isFallback: false,
			}
		);
		// Attempt 2 is the hop, answered by a calibrated adapter, and written.
		const written = attemptRequests(meter, 1, { outcome: 'ok' }, 7, undefined, {
			isFallback: true,
			isCalibrated: true,
		});
		expect(written).toEqual([
			expect.objectContaining({ attempt: 1, isFallback: false }),
			expect.objectContaining({ attempt: 2, isFallback: true, isCalibrated: true }),
		]);
		expect(written[0]!.isCalibrated).toBeUndefined();

		// The recorder sends no call-level flag that could overwrite them.
		const runMutation = vi.fn(async (_ref: unknown, _args?: unknown) => null);
		const ctx = { runMutation, scheduler: { runAfter: vi.fn() } } as never;
		return Promise.resolve(
			decisionUsageRecorder(ctx)({
				feature: 'inbound_triage',
				requestId: 'r',
				provider: 'llm',
				attempt: 1,
				fallback: true,
				outcome: 'answered',
				durationMs: 7,
				calibrated: true,
				requests: written,
			})
		).then(() => {
			const args = runMutation.mock.calls[0]![1] as Record<string, unknown>;
			expect(args).not.toHaveProperty('isFallback');
			expect(args).not.toHaveProperty('isCalibrated');
			expect(args['requests']).toEqual([
				expect.objectContaining({ attempt: 1, isFallback: false }),
				expect.objectContaining({ attempt: 2, isFallback: true, isCalibrated: true }),
			]);
		});
	});

	it('records one request per native attempt, the throttled one flagged', () => {
		const meter = new LlmCallMeter();
		const throttled = attemptRequests(
			meter,
			0,
			{ outcome: 'failed' },
			40,
			Object.assign(new Error('slow down'), { status: 429 })
		);
		meter.acknowledge(throttled);
		const answered = attemptRequests(
			meter,
			1,
			{ outcome: 'ok', usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 } },
			20
		);
		expect(throttled).toEqual([
			expect.objectContaining({ attempt: 1, latencyMs: 40, isThrottled: true }),
		]);
		expect(answered).toEqual([expect.objectContaining({ attempt: 2, latencyMs: 20 })]);
		expect(answered[0]!.isThrottled).toBeUndefined();
	});

	it('tags a local engine’s requests free from the adapter kind, whatever model answered', () => {
		expect(localTag({ kind: 'local' })).toEqual({ isLocalEngine: true });
		expect(localTag({ kind: 'typesafe' })).toEqual({});
		expect(localTag({ kind: 'llm' })).toEqual({});
	});

	it.each([
		[429, true],
		[529, true],
		[500, false],
		[401, false],
	])('reads HTTP %i as throttled: %s', (status, throttled) => {
		expect(isThrottledError(Object.assign(new Error('x'), { status }))).toBe(throttled);
	});
});
