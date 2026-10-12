/**
 * The decision plane meters every provider request (ADR-0073, Phase 1a). The
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
import { attemptRequests, isThrottledError } from '../attemptRequests';
import { noul } from '../questions';
import { LlmCallMeter } from '../../llm/requestMeter';

const questions = { needsReply: noul('Does this need a reply?') };
const usage = { inputTokens: 100, outputTokens: 4, totalTokens: 104 };
const overloaded = () => Object.assign(new Error('overloaded'), { statusCode: 503 });

beforeEach(() => sdk.generateObject.mockReset());

describe('decision metering', () => {
	it('records each inner retry of the language-backed adapter as its own request', async () => {
		sdk.generateObject
			.mockRejectedValueOnce(overloaded())
			.mockRejectedValueOnce(overloaded())
			.mockResolvedValueOnce({ object: { needsReply: 0.8 }, usage });
		const records: DecisionAttemptRecord[] = [];

		await runDecision({
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
		});

		// One dispatch attempt (the adapter retries itself), three requests.
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ task: 'mail.triage', root: { rootRequestId: 'team:m1' } });
		expect(records[0]!.requests.map((r) => [r.attempt, r.outcome, r.usage?.totalTokens])).toEqual([
			[1, 'failed', undefined],
			[2, 'failed', undefined],
			[3, 'ok', 104],
		]);
	}, 15_000);

	it('records one request per native attempt, the throttled one flagged', () => {
		const meter = new LlmCallMeter();
		const throttled = attemptRequests(
			meter,
			0,
			{ outcome: 'failed' },
			40,
			Object.assign(new Error('slow down'), { status: 429 })
		);
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

	it.each([
		[429, true],
		[529, true],
		[500, false],
		[401, false],
	])('reads HTTP %i as throttled: %s', (status, throttled) => {
		expect(isThrottledError(Object.assign(new Error('x'), { status }))).toBe(throttled);
	});
});
