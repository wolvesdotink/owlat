/**
 * Unit tests for `lib/decision/dispatch.ts` — the decision plane's one choke
 * point.
 *
 * NOTHING HERE TOUCHES THE NETWORK OR THE CLOCK. The registry is mocked, so
 * both adapters are plain `vi.fn()`s, and the two non-deterministic inputs the
 * dispatch has — the jitter source and the backoff sleep — are injected, so a
 * test asserts the delay that WOULD have been waited instead of waiting it.
 *
 * Covers:
 *   - retry: transient failure then success, an exhausted budget, an immediate
 *     bail on a client error, and a codec refusal that is never re-asked,
 *   - the backoff curve: bounded, exponential, and jittered in [d/2, d], plus a
 *     `Retry-After` that replaces the curve and one so long the budget ends,
 *   - abort mid-flight: the caller's reason comes back, nothing is retried and
 *     the breaker hears nothing,
 *   - fallback: one hop and exactly one, refused after 401/422, refused while
 *     the breaker is open, refused when the primary IS the language plane, and
 *     refused outright to a caller who brought no breaker and no recorder,
 *   - the gate: a call with no allowance never reaches an adapter,
 *   - our own rate limiter: a refusal is terminal — not retried, not charged to
 *     the breaker, never a reason to hop,
 *   - accounting: the recorder fires exactly once per attempt with the shape
 *     `analytics/llmUsage.ts` will write, and the request id is stable across
 *     every retry and the hop.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { choice, noul } from '../questions';
import {
	DECISION_BACKOFF_BASE_MS,
	DEFAULT_LANGUAGE_DECISION_DEADLINE_MS,
	DecisionRateLimitRefusal,
	DecisionAccountingFailure,
	MAX_DECISION_BACKOFF_MS,
	MAX_HONOURED_RETRY_AFTER_MS,
	RETRY_AFTER_JITTER_MS,
	backoffDelayMs,
	isRetriableDecisionError,
	mayFallBack,
	runDecision,
	type DecisionAttemptRecord,
	type DecisionFallbackBreaker,
	type ResolvedDecisionProvider,
} from '../dispatch';
import { DEFAULT_DECISION_DEADLINE_MS } from '../../decisionProviders/typesafe';
import { DecisionWireError } from '../../decisionProviders/wire';
import type { DecisionRequest, DecisionResult } from '../../decisionProviders/types';

// The registry, mocked: the dispatch's whole job is what it does AROUND `ask`,
// and both real adapters are covered by their own suites.
const adapters = vi.hoisted(() => ({
	typesafe: vi.fn(),
	llm: vi.fn(),
}));
vi.mock('../../decisionProviders', () => ({
	decisionProviderFor: (kind: 'typesafe' | 'llm') => ({ kind, ask: adapters[kind] }),
}));

const questions = {
	needsReply: noul('Does this message need a reply?'),
	category: choice('Which category fits?', { person: 'A human wrote it', newsletter: null }),
};

const NATIVE_ANSWER: DecisionResult = {
	answers: {
		needsReply: { kind: 'noul', probability: 0.91 },
		category: {
			kind: 'choice',
			value: 'person',
			probabilities: { person: 0.88, newsletter: 0.12 },
			confidence: 0.88,
		},
	},
	usage: { promptTokens: 1200, completionTokens: 8, totalTokens: 1208 },
	modelUsed: 'jev-1.13.0',
	provenance: 'typesafe-native',
	calibrated: true,
};

const LANGUAGE_ANSWER: DecisionResult = {
	answers: {
		needsReply: { kind: 'noul', probability: 1 },
		category: {
			kind: 'choice',
			value: 'person',
			probabilities: { person: 1, newsletter: 0 },
			confidence: 1,
		},
	},
	usage: { promptTokens: 2400, completionTokens: 24, totalTokens: 2424 },
	modelUsed: 'gpt-4.1-mini',
	provenance: 'llm-backed',
	calibrated: false,
};

const primary: ResolvedDecisionProvider = { kind: 'typesafe', config: { apiKey: 'not-a-key' } };
/** The gate's answer. Only `internal.decision.gate.assertDecisionAllowed` builds one. */
const allowance = { allowed: true, fallbackAllowed: true } as const;
// The language plane arrives resolved: the dispatch never builds a model.
const fallbackTo: ResolvedDecisionProvider = { kind: 'llm', config: {}, model: 'gpt-4.1-mini' };

/** A vendor failure with a status, classified by the shared classifier. */
function httpError(status: number, extra: Record<string, unknown> = {}): Error {
	return Object.assign(new Error(`HTTP ${status}`), { status, ...extra });
}

interface Harness {
	readonly delays: number[];
	readonly records: DecisionAttemptRecord[];
	readonly reserved: string[];
}

function harness(): Harness {
	return { delays: [], records: [], reserved: [] };
}

/** A breaker that allows the hop and counts what it was told. */
function openableBreaker(isOpen = false) {
	return {
		isOpen: vi.fn(() => isOpen),
		recordFailure: vi.fn(),
	} satisfies DecisionFallbackBreaker & { isOpen: ReturnType<typeof vi.fn> };
}

/** The dispatch under test, with every injected dependency observable. */
function run(h: Harness, overrides: Record<string, unknown> = {}) {
	return runDecision({
		feature: 'inbound_triage',
		state: 'Subject: hello',
		questions,
		provider: primary,
		allowance,
		// A hop always travels with its breaker; `run` supplies one so the tests
		// that are about something else do not have to, and the ones that are
		// about the breaker override it.
		breaker: openableBreaker(),
		// Mid-range, so a jittered delay is neither its floor nor its ceiling.
		random: () => 0.5,
		sleep: async (ms: number) => {
			h.delays.push(ms);
		},
		recordUsage: (record) => {
			h.records.push(record);
		},
		rateLimiter: {
			reserve: (kind) => {
				h.reserved.push(kind);
			},
		},
		...overrides,
	});
}

/** The request as it reached an adapter, with the handles the dispatch adds. */
function requestOf(
	adapter: typeof adapters.typesafe,
	index: number
): DecisionRequest & {
	readonly requestId: string;
} {
	const call = adapter.mock.calls[index];
	if (!call) throw new Error(`the adapter was not called ${index + 1} time(s)`);
	return call[1] as DecisionRequest & { readonly requestId: string };
}

beforeEach(() => {
	adapters.typesafe.mockReset();
	adapters.llm.mockReset();
});

describe('retry', () => {
	it('retries a transient failure and returns the answer that follows', async () => {
		const h = harness();
		adapters.typesafe
			.mockRejectedValueOnce(httpError(503))
			.mockRejectedValueOnce(httpError(429))
			.mockResolvedValueOnce(NATIVE_ANSWER);

		const result = await run(h);

		expect(adapters.typesafe).toHaveBeenCalledTimes(3);
		expect(result.attempts).toBe(3);
		expect(result.fallback).toBe(false);
		expect(result.provider).toBe('typesafe');
		expect(result.calibrated).toBe(true);
		expect(result.answers).toEqual(NATIVE_ANSWER.answers);
		expect(result.usage).toEqual(NATIVE_ANSWER.usage);
		expect(h.delays).toHaveLength(2);
	});

	it('gives up after the attempt budget and throws the last failure', async () => {
		const h = harness();
		adapters.typesafe.mockRejectedValue(httpError(500));

		await expect(run(h)).rejects.toThrow('HTTP 500');

		expect(adapters.typesafe).toHaveBeenCalledTimes(3);
		expect(h.delays).toHaveLength(2);
	});

	it('honours a smaller attempt budget', async () => {
		const h = harness();
		adapters.typesafe.mockRejectedValue(httpError(500));

		await expect(run(h, { maxAttempts: 1 })).rejects.toThrow('HTTP 500');

		expect(adapters.typesafe).toHaveBeenCalledTimes(1);
		expect(h.delays).toEqual([]);
	});

	it('bails immediately on a client error rather than spending the budget', async () => {
		const h = harness();
		adapters.typesafe.mockRejectedValue(httpError(401));

		await expect(run(h)).rejects.toThrow('HTTP 401');

		expect(adapters.typesafe).toHaveBeenCalledTimes(1);
		expect(h.delays).toEqual([]);
	});

	it('never re-asks after a codec refusal', async () => {
		const h = harness();
		// A response that disagrees with the question set: asking again would only
		// spend money to disagree again, and would corrupt the calibration stats.
		adapters.typesafe.mockRejectedValue(
			new DecisionWireError("no answer for question 'category'.")
		);

		await expect(run(h)).rejects.toBeInstanceOf(DecisionWireError);

		expect(adapters.typesafe).toHaveBeenCalledTimes(1);
		expect(isRetriableDecisionError(new DecisionWireError('x'))).toBe(false);
	});

	it('trusts an adapter that classified its own failure', async () => {
		const h = harness();
		// No status to classify — a refused redirect is a configuration mistake and
		// the adapter says so; the shared classifier would have guessed retriable.
		adapters.typesafe.mockRejectedValue(
			Object.assign(new Error('TypeSafe answered with a redirect'), { retriable: false })
		);

		await expect(run(h)).rejects.toThrow('redirect');

		expect(adapters.typesafe).toHaveBeenCalledTimes(1);
	});

	it('does not retry the language-backed plane, which retries itself', async () => {
		const h = harness();
		adapters.llm.mockRejectedValue(httpError(503));

		await expect(run(h, { provider: fallbackTo })).rejects.toThrow('HTTP 503');

		expect(adapters.llm).toHaveBeenCalledTimes(1);
	});
});

describe('backoff', () => {
	it('is exponential, bounded and jittered into the top half of the curve', () => {
		const floor = () => 0;
		const ceiling = () => 1;
		expect(backoffDelayMs(0, undefined, floor)).toBe(DECISION_BACKOFF_BASE_MS / 2);
		expect(backoffDelayMs(0, undefined, ceiling)).toBe(DECISION_BACKOFF_BASE_MS);
		expect(backoffDelayMs(1, undefined, ceiling)).toBe(DECISION_BACKOFF_BASE_MS * 2);
		expect(backoffDelayMs(9, undefined, ceiling)).toBe(MAX_DECISION_BACKOFF_MS);
		expect(backoffDelayMs(9, undefined, floor)).toBe(MAX_DECISION_BACKOFF_MS / 2);
	});

	it('spreads two callers that failed on the same attempt', async () => {
		const early = harness();
		const late = harness();
		adapters.typesafe.mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce(NATIVE_ANSWER);
		await run(early, { random: () => 0 });
		adapters.typesafe.mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce(NATIVE_ANSWER);
		await run(late, { random: () => 1 });

		// The whole point of the jitter: the same failure at the same moment does
		// not produce the same return time.
		expect(early.delays[0]).not.toBe(late.delays[0]);
		expect(early.delays[0]).toBeGreaterThan(0);
	});

	it('lets a Retry-After replace the curve, spread upward only', async () => {
		const h = harness();
		adapters.typesafe
			.mockRejectedValueOnce(httpError(429, { retryAfterMs: 2_000 }))
			.mockResolvedValueOnce(NATIVE_ANSWER);

		await run(h);

		expect(h.delays).toEqual([2_000 + RETRY_AFTER_JITTER_MS / 2]);
		expect(backoffDelayMs(0, 2_000, () => 0)).toBe(2_000);
	});

	it('ends the budget rather than holding a surface open for a long Retry-After', async () => {
		const h = harness();
		adapters.typesafe.mockRejectedValue(
			httpError(429, { retryAfterMs: MAX_HONOURED_RETRY_AFTER_MS + 1 })
		);

		await expect(run(h)).rejects.toThrow('HTTP 429');

		expect(adapters.typesafe).toHaveBeenCalledTimes(1);
		expect(h.delays).toEqual([]);
	});
});

describe('deadline', () => {
	it('gives each plane its own default and lets the caller override', async () => {
		const h = harness();
		adapters.typesafe.mockResolvedValue(NATIVE_ANSWER);
		adapters.llm.mockResolvedValue(LANGUAGE_ANSWER);

		await run(h);
		expect(requestOf(adapters.typesafe, 0).deadlineMs).toBe(DEFAULT_DECISION_DEADLINE_MS);

		await run(h, { provider: fallbackTo });
		expect(requestOf(adapters.llm, 0).deadlineMs).toBe(DEFAULT_LANGUAGE_DECISION_DEADLINE_MS);

		await run(h, { deadlineMs: 1_500 });
		expect(requestOf(adapters.typesafe, 1).deadlineMs).toBe(1_500);
	});
});

describe('abort', () => {
	it('returns the caller reason, retries nothing and reports nothing to the breaker', async () => {
		const h = harness();
		const controller = new AbortController();
		const breaker = openableBreaker();
		adapters.typesafe.mockImplementation(() => {
			controller.abort(new Error('the pipeline step was cancelled'));
			return Promise.reject(new Error('socket closed'));
		});

		await expect(run(h, { abortSignal: controller.signal, breaker, fallbackTo })).rejects.toThrow(
			'the pipeline step was cancelled'
		);

		expect(adapters.typesafe).toHaveBeenCalledTimes(1);
		expect(adapters.llm).not.toHaveBeenCalled();
		expect(breaker.recordFailure).not.toHaveBeenCalled();
		expect(h.delays).toEqual([]);
	});

	it('refuses to start once the caller has already cancelled', async () => {
		const h = harness();
		const controller = new AbortController();
		controller.abort(new Error('cancelled before dispatch'));

		await expect(run(h, { abortSignal: controller.signal })).rejects.toThrow(
			'cancelled before dispatch'
		);

		expect(adapters.typesafe).not.toHaveBeenCalled();
	});

	it('carries the caller signal into the adapter', async () => {
		const h = harness();
		const controller = new AbortController();
		adapters.typesafe.mockResolvedValue(NATIVE_ANSWER);

		await run(h, { abortSignal: controller.signal });

		expect(requestOf(adapters.typesafe, 0).abortSignal).toBe(controller.signal);
	});
});

describe('fallback', () => {
	it('hops once, and only once, after the primary budget is spent', async () => {
		const h = harness();
		adapters.typesafe.mockRejectedValue(httpError(503));
		adapters.llm.mockResolvedValue(LANGUAGE_ANSWER);

		const result = await run(h, { fallbackTo });

		expect(adapters.typesafe).toHaveBeenCalledTimes(3);
		expect(adapters.llm).toHaveBeenCalledTimes(1);
		expect(result.fallback).toBe(true);
		expect(result.provider).toBe('llm');
		expect(result.provenance).toBe('llm-backed');
		// The one flag every threshold downstream reads before it trusts a number.
		expect(result.calibrated).toBe(false);
		expect(result.attempts).toBe(4);
	});

	it('does not hop a second time when the hop itself fails', async () => {
		const h = harness();
		adapters.typesafe.mockRejectedValue(httpError(503));
		adapters.llm.mockRejectedValue(httpError(500));

		await expect(run(h, { fallbackTo })).rejects.toThrow('HTTP 500');

		expect(adapters.llm).toHaveBeenCalledTimes(1);
	});

	it('is off unless the caller resolved a plane to hop onto', async () => {
		const h = harness();
		adapters.typesafe.mockRejectedValue(httpError(503));

		await expect(run(h)).rejects.toThrow('HTTP 503');

		expect(adapters.llm).not.toHaveBeenCalled();
	});

	it.each([401, 403, 422])(
		'refuses the hop after HTTP %i, which is our key or our question set',
		async (status) => {
			const h = harness();
			adapters.typesafe.mockRejectedValue(httpError(status));

			await expect(run(h, { fallbackTo })).rejects.toThrow(`HTTP ${status}`);

			expect(adapters.llm).not.toHaveBeenCalled();
			expect(mayFallBack(httpError(status))).toBe(false);
		}
	);

	it('refuses the hop after a codec refusal', async () => {
		const h = harness();
		adapters.typesafe.mockRejectedValue(new DecisionWireError('answered a question nobody asked'));

		await expect(run(h, { fallbackTo })).rejects.toBeInstanceOf(DecisionWireError);

		expect(adapters.llm).not.toHaveBeenCalled();
	});

	it('refuses the hop while the breaker is open', async () => {
		const h = harness();
		const breaker = openableBreaker(true);
		adapters.typesafe.mockRejectedValue(httpError(503));

		await expect(run(h, { fallbackTo, breaker })).rejects.toThrow('HTTP 503');

		// A vendor outage must not re-route every inbound message onto a model
		// that costs 24 to 50 times more.
		expect(adapters.llm).not.toHaveBeenCalled();
		expect(breaker.recordFailure).toHaveBeenCalledTimes(1);
	});

	it('tells the breaker nothing when the plane answered — the budget refills on its own', async () => {
		const h = harness();
		const breaker = openableBreaker();
		adapters.typesafe.mockResolvedValue(NATIVE_ANSWER);

		await run(h, { fallbackTo, breaker });

		expect(breaker.recordFailure).not.toHaveBeenCalled();
		expect(breaker.isOpen).not.toHaveBeenCalled();
	});

	it('refuses the hop when the gate already said the breaker was open', async () => {
		const h = harness();
		const breaker = openableBreaker();
		adapters.typesafe.mockRejectedValue(httpError(503));

		// The gate reads the breaker when the request is admitted; the dispatch
		// reads it again before it hops. Either `no` is a no.
		await expect(
			run(h, { fallbackTo, breaker, allowance: { allowed: true, fallbackAllowed: false } })
		).rejects.toThrow('HTTP 503');

		expect(adapters.llm).not.toHaveBeenCalled();
	});

	it('refuses a hop that arrived without its breaker or its recorder', async () => {
		const h = harness();
		adapters.typesafe.mockResolvedValue(NATIVE_ANSWER);

		// The one-line mistake this guard exists for: `resolveDecisionFallback`
		// hands out a ready-made plane, and a hop with no breaker is uncapped
		// spend on a model that costs 24 to 50 times more.
		await expect(run(h, { fallbackTo, breaker: undefined })).rejects.toThrow('circuit breaker');
		await expect(run(h, { fallbackTo, recordUsage: undefined })).rejects.toThrow('usage recorder');
		expect(adapters.typesafe).not.toHaveBeenCalled();
	});

	it('rejects a fallback that is not the language plane, or has no model', async () => {
		const h = harness();
		adapters.typesafe.mockResolvedValue(NATIVE_ANSWER);

		await expect(run(h, { fallbackTo: { kind: 'typesafe', config: {} } })).rejects.toThrow(
			'one hop onto the language plane'
		);
		await expect(run(h, { fallbackTo: { kind: 'llm', config: {} } })).rejects.toThrow(
			'resolved language model'
		);
	});

	it('has nowhere to hop when the primary is already the language plane', async () => {
		const h = harness();
		adapters.llm.mockRejectedValue(httpError(503));

		await expect(run(h, { provider: fallbackTo, fallbackTo })).rejects.toThrow('HTTP 503');

		expect(adapters.llm).toHaveBeenCalledTimes(1);
	});
});

describe('the gate', () => {
	it("refuses to call anything without the gate's answer", async () => {
		const h = harness();
		adapters.typesafe.mockResolvedValue(NATIVE_ANSWER);

		// The kill switch lives in a mutation an action cannot inline, so the only
		// way it can be structurally in the path is as an argument.
		await expect(run(h, { allowance: undefined })).rejects.toThrow('assertDecisionAllowed');
		await expect(run(h, { allowance: { fallbackAllowed: true } })).rejects.toThrow(
			'assertDecisionAllowed'
		);

		expect(adapters.typesafe).not.toHaveBeenCalled();
	});
});

describe('our own rate limiter', () => {
	/** A limiter that refuses the way a ctx-bound one does: a plain throw, no status. */
	const refusing = {
		reserve: () => {
			throw new Error('The decision plane is busy — try again in a moment.');
		},
	};

	it('does not retry a refusal against the bucket that just refused it', async () => {
		const h = harness();
		adapters.typesafe.mockResolvedValue(NATIVE_ANSWER);

		await expect(run(h, { rateLimiter: refusing })).rejects.toBeInstanceOf(
			DecisionRateLimitRefusal
		);

		expect(adapters.typesafe).not.toHaveBeenCalled();
		expect(h.delays).toEqual([]);
		expect(isRetriableDecisionError(new DecisionRateLimitRefusal('typesafe'))).toBe(false);
	});

	it('charges the breaker nothing and never hops — the provider did not fail', async () => {
		const h = harness();
		const breaker = openableBreaker();
		adapters.llm.mockResolvedValue(LANGUAGE_ANSWER);

		await expect(run(h, { rateLimiter: refusing, fallbackTo, breaker })).rejects.toBeInstanceOf(
			DecisionRateLimitRefusal
		);

		// Charging it would let one busy minute drive the breaker open and refuse
		// the hop for the five minutes of real failures that follow.
		expect(breaker.recordFailure).not.toHaveBeenCalled();
		expect(adapters.llm).not.toHaveBeenCalled();
		expect(mayFallBack(new DecisionRateLimitRefusal('typesafe'))).toBe(false);
	});

	it("keeps the limiter's own reason as the cause", async () => {
		const h = harness();
		await expect(run(h, { rateLimiter: refusing })).rejects.toMatchObject({
			cause: expect.objectContaining({ message: expect.stringContaining('busy') }),
		});
	});
});

describe('the model id', () => {
	it('carries the resolved version to the adapter, and nothing when there is none', async () => {
		const h = harness();
		adapters.typesafe.mockResolvedValue(NATIVE_ANSWER);

		await run(h, { provider: { ...primary, modelId: 'jev-1.13.0' } });
		expect(requestOf(adapters.typesafe, 0).modelId).toBe('jev-1.13.0');

		await run(h);
		expect(requestOf(adapters.typesafe, 1).modelId).toBeUndefined();
	});
});

describe('accounting', () => {
	it('records exactly one row per attempt, answered and failed alike', async () => {
		const h = harness();
		adapters.typesafe.mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce(NATIVE_ANSWER);

		await run(h);

		expect(h.records).toHaveLength(2);
		expect(h.records[0]).toMatchObject({
			feature: 'inbound_triage',
			provider: 'typesafe',
			attempt: 1,
			fallback: false,
			outcome: 'failed',
		});
		expect(h.records[0]?.error).toMatchObject({ status: 503 });
		expect(h.records[0]?.usage).toBeUndefined();
		expect(h.records[1]).toMatchObject({
			provider: 'typesafe',
			attempt: 2,
			fallback: false,
			outcome: 'answered',
			usage: NATIVE_ANSWER.usage,
			modelUsed: 'jev-1.13.0',
			provenance: 'typesafe-native',
			calibrated: true,
		});
		expect(typeof h.records[1]?.durationMs).toBe('number');
	});

	it('marks the hop as the hop', async () => {
		const h = harness();
		adapters.typesafe.mockRejectedValue(httpError(503));
		adapters.llm.mockResolvedValue(LANGUAGE_ANSWER);

		await run(h, { fallbackTo });

		expect(h.records).toHaveLength(4);
		expect(h.records[h.records.length - 1]).toMatchObject({
			provider: 'llm',
			attempt: 1,
			fallback: true,
			outcome: 'answered',
			calibrated: false,
		});
	});

	it('keeps one request id across every retry and the hop', async () => {
		const h = harness();
		adapters.typesafe.mockRejectedValue(httpError(503));
		adapters.llm.mockResolvedValue(LANGUAGE_ANSWER);

		const result = await run(h, { fallbackTo });

		const ids = new Set(h.records.map((record) => record.requestId));
		expect(ids.size).toBe(1);
		expect(result.requestId).toBe(h.records[0]?.requestId);
		// Carried onto the request too, so an adapter can put it on the wire.
		expect(requestOf(adapters.typesafe, 0).requestId).toBe(result.requestId);
	});

	it('generates a fresh id per logical call, and honours a caller-supplied one', async () => {
		const first = harness();
		const second = harness();
		adapters.typesafe.mockResolvedValue(NATIVE_ANSWER);

		const a = await run(first);
		const b = await run(second);
		expect(a.requestId).not.toBe(b.requestId);

		const pinned = await run(harness(), { requestId: 'decision-msg-42' });
		expect(pinned.requestId).toBe('decision-msg-42');
	});

	it('reserves the rate limiter once per attempt, hop included', async () => {
		const h = harness();
		adapters.typesafe.mockRejectedValue(httpError(503));
		adapters.llm.mockResolvedValue(LANGUAGE_ANSWER);

		await run(h, { fallbackTo });

		expect(h.reserved).toEqual(['typesafe', 'typesafe', 'typesafe', 'llm']);
	});

	it('fails the call when the spend of an answer could not be recorded', async () => {
		const h = harness();
		adapters.typesafe.mockResolvedValue(NATIVE_ANSWER);
		const breaker = openableBreaker();
		const failure = new Error('usage write failed');

		// The ceiling has to see the row before the caller acts on the answer.
		await expect(
			run(h, {
				fallbackTo,
				breaker,
				recordUsage: () => {
					throw failure;
				},
			})
		).rejects.toMatchObject({ name: 'DecisionAccountingFailure', cause: failure });
		expect(adapters.typesafe).toHaveBeenCalledTimes(1);
		expect(adapters.llm).not.toHaveBeenCalled();
		expect(breaker.recordFailure).not.toHaveBeenCalled();
		expect(h.delays).toEqual([]);
		expect(isRetriableDecisionError(new DecisionAccountingFailure(failure))).toBe(false);
		expect(mayFallBack(new DecisionAccountingFailure(failure))).toBe(false);
	});

	it('records billed usage when the codec refuses an answer, without retry or fallback', async () => {
		const h = harness();
		const error = new DecisionWireError('Invalid answer', {
			usage: NATIVE_ANSWER.usage,
			modelUsed: NATIVE_ANSWER.modelUsed,
		});
		adapters.typesafe.mockRejectedValue(error);
		await expect(run(h, { fallbackTo })).rejects.toBe(error);
		expect(adapters.typesafe).toHaveBeenCalledTimes(1);
		expect(adapters.llm).not.toHaveBeenCalled();
		expect(h.records).toHaveLength(1);
		expect(h.records[0]).toMatchObject({
			outcome: 'failed',
			usage: NATIVE_ANSWER.usage,
			modelUsed: NATIVE_ANSWER.modelUsed,
		});
	});

	it('keeps the vendor error when a failed attempt cannot be recorded', async () => {
		const h = harness();
		adapters.typesafe.mockRejectedValue(httpError(401));

		await expect(
			run(h, {
				recordUsage: () => {
					throw new Error('usage write failed');
				},
			})
		).rejects.toThrow('HTTP 401');
	});
});
