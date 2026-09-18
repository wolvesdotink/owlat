/**
 * Unit tests for `lib/decisionProviders/typesafe.ts` — the in-house HTTP client
 * for the native decision endpoint.
 *
 * NOTHING HERE TOUCHES THE NETWORK. Every test either injects a `fetchImpl` or
 * stubs `fetchGuarded`, so no DNS resolution and no socket is ever attempted;
 * the guard itself is covered by `lib/__tests__/ssrfGuard.test.ts`.
 *
 * Covers:
 *   - the happy path across all three question types, the pinned model on the
 *     wire (and an operator's own id when the resolver settled on one), the
 *     calibration check against the model the PROVIDER reports back, and the
 *     endpoint composed from the configured ORIGIN,
 *   - that the guarded, https-only fetcher is what runs when nothing is
 *     injected — i.e. the key can never ride an unguarded request,
 *   - the full status taxonomy (401, 403, 404, 422, 429, 500, 529) with the
 *     retry classification the shared `isRetriableLlmError` produces, plus
 *     `Retry-After`,
 *   - the four failures that arrive with no status at all: our deadline, a
 *     caller's cancellation, a connection failure and a refused redirect,
 *   - a body that is not JSON, and the three disagreements the codec must
 *     refuse rather than repair (missing key, extra key, out-of-domain choice),
 *   - and, across every one of those paths, that the API key does not appear in
 *     the error — including when the vendor's own error body echoes it back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { choice, noul, score } from '../../decision/questions';
import { isRetriableLlmError } from '../../llm/dispatch';
import { DecisionWireError } from '../wire';
import {
	DEFAULT_DECISION_DEADLINE_MS,
	JEV_MODEL_ALIASES,
	PINNED_DECISION_MODEL,
	TYPESAFE_DECISION_PATH,
	TYPESAFE_DEFAULT_BASE_URL,
	TypeSafeDecisionError,
	typesafeDecisionAdapter,
} from '../typesafe';

// The guarded fetcher, stubbed so the default (non-injected) path can be
// asserted without DNS or a socket. The guard's own error classes stay real —
// the adapter matches them by type, and a stubbed class would prove nothing.
const guard = vi.hoisted(() => ({ fetchGuarded: vi.fn() }));
vi.mock('../../ssrfGuard', async () => ({
	...(await vi.importActual('../../ssrfGuard')),
	fetchGuarded: guard.fetchGuarded,
}));

// A stand-in for an operator's key. Every leak assertion below searches for
// this exact string; it is not, and must never be, a real credential.
const API_KEY = 'typesafe-test-key-0000';

const questions = {
	needsReply: noul('Does this message need a reply?'),
	category: choice('Which category fits?', { person: 'A human wrote it', newsletter: null }),
	urgency: score('How urgent is it?', ['Not urgent', 'This week', 'Immediately']),
};

const answers = {
	needsReply: { type: 'noul', noul: 0.91 },
	category: {
		type: 'choice',
		choice: 'person',
		probabilities: { person: 0.88, newsletter: 0.12 },
		confidence: 0.76,
	},
	urgency: {
		type: 'score',
		score: 1.4,
		legend: { '0': 'Not urgent', '1': 'This week', '2': 'Immediately' },
		probabilities: { '0': 0.1, '1': 0.5, '2': 0.4 },
		confidence: 0.61,
	},
};

function okBody(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		model: PINNED_DECISION_MODEL,
		answers,
		usage: { input_tokens: 1200, output_tokens: 18 },
		...overrides,
	});
}

function jsonResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(body, {
		status,
		headers: { 'content-type': 'application/json', ...headers },
	});
}

/** A `fetchImpl` that answers once, recording what it was called with. */
function respondWith(response: Response | (() => Promise<Response>)) {
	return vi.fn(async (_input: string, _init?: RequestInit) =>
		typeof response === 'function' ? await response() : response
	);
}

function ask(fetchImpl: ReturnType<typeof respondWith>, overrides: Record<string, unknown> = {}) {
	return typesafeDecisionAdapter.ask(
		{ apiKey: API_KEY, fetchImpl },
		{ state: 'Subject: the invoice is late', questions, ...overrides }
	);
}

/** The adapter's own failure type, narrowed — anything else fails the test. */
async function askFailing(
	fetchImpl: ReturnType<typeof respondWith>,
	overrides: Record<string, unknown> = {}
): Promise<TypeSafeDecisionError> {
	const error = await ask(fetchImpl, overrides).then(
		() => undefined,
		(thrown: unknown) => thrown
	);
	expect(error).toBeInstanceOf(TypeSafeDecisionError);
	return error as TypeSafeDecisionError;
}

/** Nothing about a failure — message, cause chain or enumerable fields — may carry the key. */
function expectNoKeyLeak(error: unknown): void {
	const rendered = [
		String((error as Error)?.message ?? ''),
		String((error as Error)?.stack ?? ''),
		JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})),
		String((error as { cause?: unknown })?.cause ?? ''),
	].join('\n');
	expect(rendered).not.toContain(API_KEY);
}

beforeEach(() => {
	guard.fetchGuarded.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('typesafeDecisionAdapter.ask() — the happy path', () => {
	it('answers all three question types and reports usage, model and provenance', async () => {
		const fetchImpl = respondWith(jsonResponse(okBody()));

		const result = await ask(fetchImpl);

		expect(result.answers).toEqual({
			needsReply: { kind: 'noul', probability: 0.91 },
			category: {
				kind: 'choice',
				value: 'person',
				probabilities: { person: 0.88, newsletter: 0.12 },
				confidence: 0.76,
			},
			urgency: {
				kind: 'score',
				value: 2.4,
				levels: ['Not urgent', 'This week', 'Immediately'],
				probabilities: { '1': 0.1, '2': 0.5, '3': 0.4 },
				confidence: 0.61,
			},
		});
		expect(result.usage).toEqual({ promptTokens: 1200, completionTokens: 18, totalTokens: 1218 });
		expect(result.modelUsed).toBe(PINNED_DECISION_MODEL);
		expect(result.provenance).toBe('typesafe-native');
		expect(result.calibrated).toBe(true);
	});

	it('posts the pinned model, the state and the encoded questions to the one endpoint', async () => {
		const fetchImpl = respondWith(jsonResponse(okBody()));

		await ask(fetchImpl);

		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${TYPESAFE_DEFAULT_BASE_URL}${TYPESAFE_DECISION_PATH}`);
		expect(init.method).toBe('POST');
		expect(JSON.parse(String(init.body))).toEqual({
			model: PINNED_DECISION_MODEL,
			state: 'Subject: the invoice is late',
			questions: {
				needsReply: { type: 'noul', instructions: 'Does this message need a reply?' },
				category: {
					type: 'choice',
					instructions: 'Which category fits?',
					criteria: { person: 'A human wrote it', newsletter: null },
				},
				urgency: {
					type: 'score',
					instructions: 'How urgent is it?',
					criteria: ['Not urgent', 'This week', 'Immediately'],
				},
			},
		});
	});

	it('sends the model id the resolver settled on, when there is one', async () => {
		const fetchImpl = respondWith(jsonResponse(okBody({ model: 'jev-latest' })));

		await ask(fetchImpl, { modelId: 'jev-latest' });

		const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		// The settings picker and DECISION_MODEL are stored, shown back and now
		// actually sent: an id that is echoed to an operator and then dropped is
		// worse than not offering the field.
		expect(JSON.parse(String(init.body)).model).toBe('jev-latest');
	});

	it('falls back to the pin when the resolver named nothing, or named nothing but space', async () => {
		const fetchImpl = respondWith(jsonResponse(okBody()));

		await ask(fetchImpl, { modelId: '  ' });

		const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(JSON.parse(String(init.body)).model).toBe(PINNED_DECISION_MODEL);
	});

	it('treats a movable alias reported back as uncalibrated', async () => {
		for (const alias of JEV_MODEL_ALIASES) {
			const result = await ask(respondWith(jsonResponse(okBody({ model: alias }))));
			expect(result.calibrated).toBe(false);
		}
	});

	it('refuses to call an answer from an unpinned version calibrated', async () => {
		// A provider-side reroute is exactly what reading the model id back is for.
		// The answers are perfectly well-formed; what is gone is the evidence that
		// the thresholds downstream were measured against THIS model.
		const result = await ask(respondWith(jsonResponse(okBody({ model: 'jev-1.14.0' }))));

		expect(result.modelUsed).toBe('jev-1.14.0');
		expect(result.calibrated).toBe(false);
		// The answers still arrive: the caller decides what an uncalibrated verdict
		// is worth, and every threshold reads `calibrated` before it trusts one.
		expect(result.answers['needsReply']).toEqual({ kind: 'noul', probability: 0.91 });
	});

	it('carries the key in the Authorization header and nowhere else', async () => {
		const fetchImpl = respondWith(jsonResponse(okBody()));

		await ask(fetchImpl);

		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(headers['authorization']).toBe(`Bearer ${API_KEY}`);
		expect(url).not.toContain(API_KEY);
		expect(String(init.body)).not.toContain(API_KEY);
	});

	it('bounds every request with a deadline, even when the caller supplies none', async () => {
		const fetchImpl = respondWith(jsonResponse(okBody()));

		await ask(fetchImpl);

		const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(init.signal?.aborted).toBe(false);
		expect(DEFAULT_DECISION_DEADLINE_MS).toBeGreaterThan(0);
	});

	it('appends the endpoint to a configured origin and marks the provenance custom', async () => {
		const fetchImpl = respondWith(jsonResponse(okBody()));

		const result = await typesafeDecisionAdapter.ask(
			{ apiKey: API_KEY, baseUrl: 'https://decisions.proxy.example/', fetchImpl },
			{ state: 'x', questions }
		);

		expect((fetchImpl.mock.calls[0] as [string])[0]).toBe(
			`https://decisions.proxy.example${TYPESAFE_DECISION_PATH}`
		);
		expect(result.provenance).toBe('custom');
	});

	it('runs on the SSRF-guarded, https-only fetcher when none is injected', async () => {
		guard.fetchGuarded.mockResolvedValue(jsonResponse(okBody()));

		await typesafeDecisionAdapter.ask({ apiKey: API_KEY }, { state: 'x', questions });

		expect(guard.fetchGuarded).toHaveBeenCalledTimes(1);
		const [url, init] = guard.fetchGuarded.mock.calls[0] as [
			string,
			RequestInit & { protocols?: string[] },
		];
		expect(url).toBe(`${TYPESAFE_DEFAULT_BASE_URL}${TYPESAFE_DECISION_PATH}`);
		expect(init.protocols).toEqual(['https:']);
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it('refuses an empty question set before opening a socket', async () => {
		const fetchImpl = respondWith(jsonResponse(okBody()));

		await expect(ask(fetchImpl, { questions: {} })).rejects.toBeInstanceOf(DecisionWireError);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe('typesafeDecisionAdapter.ask() — HTTP failures', () => {
	const cases = [
		{ status: 401, retriable: false, says: /rejected the API key/ },
		{ status: 403, retriable: false, says: /not permitted/ },
		{ status: 404, retriable: false, says: /no endpoint at/ },
		{ status: 422, retriable: false, says: /question set as invalid/ },
		{ status: 429, retriable: true, says: /rate-limited/ },
		{ status: 500, retriable: true, says: /unavailable or overloaded/ },
		{ status: 529, retriable: true, says: /unavailable or overloaded/ },
	] as const;

	for (const { status, retriable, says } of cases) {
		it(`maps HTTP ${status} to a ${retriable ? 'retriable' : 'terminal'} error`, async () => {
			const fetchImpl = respondWith(jsonResponse('{"error":"nope"}', status));

			const error = await askFailing(fetchImpl);

			expect(error.status).toBe(status);
			expect(error.message).toMatch(says);
			expect(error.retriable).toBe(retriable);
			// The classification is the repo's one classifier, not a second copy.
			expect(isRetriableLlmError(error)).toBe(retriable);
			expectNoKeyLeak(error);
		});
	}

	it('treats 529 as retriable through the shared >= 500 branch', async () => {
		const error = await askFailing(respondWith(jsonResponse('overloaded', 529)));

		expect(error.status).toBe(529);
		expect(isRetriableLlmError({ status: 529 })).toBe(true);
		expect(error.retriable).toBe(true);
	});

	it('quotes a little of the vendor error body, truncated to one line', async () => {
		const detail = `spread ${'x'.repeat(400)}\nover lines`;
		const error = await askFailing(respondWith(jsonResponse(detail, 400)));

		expect(error.message).toContain('spread xxx');
		expect(error.message).not.toContain('\n');
		expect(error.message.length).toBeLessThan(400);
	});

	it('redacts the key from a vendor error body that echoes it back', async () => {
		const error = await askFailing(
			respondWith(jsonResponse(`{"error":"bad key ${API_KEY}"}`, 401))
		);

		expect(error.message).toContain('[redacted]');
		expectNoKeyLeak(error);
	});

	it('carries Retry-After in seconds as milliseconds', async () => {
		const error = await askFailing(
			respondWith(jsonResponse('slow down', 429, { 'retry-after': '3' }))
		);

		expect(error.retryAfterMs).toBe(3000);
	});

	it('carries Retry-After as an HTTP date', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-09-17T12:00:00Z'));
		const error = await askFailing(
			respondWith(
				jsonResponse('slow down', 429, { 'retry-after': 'Thu, 17 Sep 2026 12:00:30 GMT' })
			)
		);

		expect(error.retryAfterMs).toBe(30_000);
	});

	it('leaves Retry-After unset when the header is absent or unparseable', async () => {
		const missing = await askFailing(respondWith(jsonResponse('slow down', 429)));
		const nonsense = await askFailing(
			respondWith(jsonResponse('slow down', 429, { 'retry-after': 'soon' }))
		);

		expect(missing.retryAfterMs).toBeUndefined();
		expect(nonsense.retryAfterMs).toBeUndefined();
	});
});

describe('typesafeDecisionAdapter.ask() — failures with no status', () => {
	it('reports our own deadline rather than hanging on the socket', async () => {
		const fetchImpl = vi.fn(
			(_input: string, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
				})
		) as unknown as ReturnType<typeof respondWith>;

		const error = await askFailing(fetchImpl, { deadlineMs: 10 });

		expect(error.message).toMatch(/did not answer within the 10 ms deadline/);
		expect(error.retriable).toBe(true);
		expect(error.status).toBeUndefined();
		expectNoKeyLeak(error);
	});

	it("hands a caller's cancellation straight back, unwrapped and unretried", async () => {
		const controller = new AbortController();
		const reason = new Error('pipeline step cancelled');
		controller.abort(reason);
		const fetchImpl = vi.fn(async (_input: string, init?: RequestInit) => {
			if (init?.signal?.aborted) throw init.signal.reason;
			return jsonResponse(okBody());
		}) as unknown as ReturnType<typeof respondWith>;

		await expect(ask(fetchImpl, { abortSignal: controller.signal })).rejects.toBe(reason);
	});

	it('reports a connection failure as retriable and keeps the cause', async () => {
		const cause = new TypeError('fetch failed');
		const fetchImpl = vi.fn(async () => {
			throw cause;
		}) as unknown as ReturnType<typeof respondWith>;

		const error = await askFailing(fetchImpl);

		expect(error.message).toMatch(/could not be reached/);
		expect(error.retriable).toBe(true);
		expect(error.cause).toBe(cause);
		expectNoKeyLeak(error);
	});

	it('turns the guard refusing a redirect into an actionable base-URL error', async () => {
		const { RedirectRefusedError } =
			await vi.importActual<typeof import('../../ssrfGuard')>('../../ssrfGuard');
		const fetchImpl = vi.fn(async () => {
			throw new RedirectRefusedError('Blocked fetch of "https://api.typesafe.ai/v1/systemone"');
		}) as unknown as ReturnType<typeof respondWith>;

		const error = await askFailing(fetchImpl);

		expect(error.message).toMatch(/redirect/);
		expect(error.message).toContain(TYPESAFE_DEFAULT_BASE_URL);
		// A 3xx is a misconfiguration; retrying it would loop against the same URL.
		expect(error.retriable).toBe(false);
		expectNoKeyLeak(error);
	});

	it('gives the same answer for a 3xx that reaches us as a response', async () => {
		const error = await askFailing(
			respondWith(jsonResponse('', 302, { location: 'https://elsewhere.example' }))
		);

		expect(error.status).toBe(302);
		expect(error.message).toMatch(/redirect/);
		expect(error.retriable).toBe(false);
	});

	it('names a blocked destination without blaming the network', async () => {
		const { SsrfBlockedError } =
			await vi.importActual<typeof import('../../ssrfGuard')>('../../ssrfGuard');
		const fetchImpl = vi.fn(async () => {
			throw new SsrfBlockedError('Blocked fetch of "https://internal.test/v1/systemone"');
		}) as unknown as ReturnType<typeof respondWith>;

		const error = await askFailing(fetchImpl);

		expect(error.message).toMatch(/private or internal address/);
		expect(error.retriable).toBe(false);
	});
});

describe('typesafeDecisionAdapter.ask() — responses we refuse', () => {
	it('rejects a body that is not JSON', async () => {
		const error = await askFailing(
			respondWith(new Response('<html>login</html>', { status: 200 }))
		);

		expect(error.message).toMatch(/not JSON/);
		expect(error.retriable).toBe(false);
		expectNoKeyLeak(error);
	});

	it('rejects a response that is missing a requested answer', async () => {
		const { needsReply: _dropped, ...partial } = answers;
		const fetchImpl = respondWith(jsonResponse(okBody({ answers: partial })));

		await expect(ask(fetchImpl)).rejects.toThrow(/no answer for question 'needsReply'/);
	});

	it('rejects a response that answers something we never asked', async () => {
		const fetchImpl = respondWith(
			jsonResponse(okBody({ answers: { ...answers, sentiment: { type: 'noul', noul: 0.4 } } }))
		);

		const error = await ask(fetchImpl).catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(DecisionWireError);
		expect((error as Error).message).toMatch(/which was not asked/);
	});

	it('rejects a Choice value outside the options we sent', async () => {
		const fetchImpl = respondWith(
			jsonResponse(
				okBody({
					answers: {
						...answers,
						category: { ...answers.category, choice: 'robot', probabilities: { robot: 1 } },
					},
				})
			)
		);

		await expect(ask(fetchImpl)).rejects.toThrow(/chose 'robot'/);
	});

	it('never repairs a disagreement into an answer', async () => {
		const fetchImpl = respondWith(jsonResponse(okBody({ answers: {} })));

		const error = await ask(fetchImpl).catch((thrown: unknown) => thrown);
		expect(error).toBeInstanceOf(DecisionWireError);
		expectNoKeyLeak(error);
	});
});

describe('typesafeDecisionAdapter.validateCredentials()', () => {
	it('names the provider when no key is configured', () => {
		expect(() => typesafeDecisionAdapter.validateCredentials({})).toThrow(
			'TypeSafe (Jev) requires an API key.'
		);
	});

	it('accepts a key alone, and a key with an origin', () => {
		expect(() => typesafeDecisionAdapter.validateCredentials({ apiKey: API_KEY })).not.toThrow();
		expect(() =>
			typesafeDecisionAdapter.validateCredentials({
				apiKey: API_KEY,
				baseUrl: 'https://decisions.proxy.example',
			})
		).not.toThrow();
	});

	// The stored base URL is checked by `_persistConfig`; `DECISION_BASE_URL`
	// reaches the adapter having passed nothing but the SSRF guard, which refuses
	// a private host and accepts embedded credentials. The key rides this request.
	it.each([
		['https://someone:else@decisions.proxy.example', /must not embed credentials/],
		['http://decisions.proxy.example', /must use https/],
		['https://127.0.0.1', /private or internal address/],
		['not-a-url', /must be a valid absolute URL/],
	])('refuses an origin that %s could not safely carry the key to', (baseUrl, says) => {
		expect(() => typesafeDecisionAdapter.validateCredentials({ apiKey: API_KEY, baseUrl })).toThrow(
			says
		);
	});

	it('explains that the endpoint path is appended, not pasted', () => {
		expect(() =>
			typesafeDecisionAdapter.validateCredentials({
				apiKey: API_KEY,
				baseUrl: `${TYPESAFE_DEFAULT_BASE_URL}${TYPESAFE_DECISION_PATH}/`,
			})
		).toThrow(/must be the API origin/);
	});

	it('keeps the key out of the message either way', () => {
		const error = (() => {
			try {
				typesafeDecisionAdapter.validateCredentials({
					apiKey: API_KEY,
					baseUrl: `${TYPESAFE_DEFAULT_BASE_URL}${TYPESAFE_DECISION_PATH}`,
				});
			} catch (thrown) {
				return thrown;
			}
		})();
		expectNoKeyLeak(error);
	});
});

describe('typesafeDecisionAdapter.listModels()', () => {
	it('returns the pinned version first, then its aliases, without a request', async () => {
		const models = await typesafeDecisionAdapter.listModels?.({ apiKey: API_KEY });

		expect(models).toEqual([PINNED_DECISION_MODEL, ...JEV_MODEL_ALIASES]);
		expect(models?.[0]).toBe('jev-1.13.0');
		expect(guard.fetchGuarded).not.toHaveBeenCalled();
	});

	it('still requires a key, so the settings picker fails the same way everywhere', async () => {
		await expect(typesafeDecisionAdapter.listModels?.({})).rejects.toThrow(
			'TypeSafe (Jev) requires an API key.'
		);
	});
});

describe('response body failures', () => {
	it('treats a timeout while reading the body as transient', async () => {
		const response = new Response('{}');
		vi.spyOn(response, 'json').mockRejectedValue(new DOMException('Timed out', 'TimeoutError'));
		await expect(
			typesafeDecisionAdapter.ask(
				{ apiKey: API_KEY, fetchImpl: async () => response },
				{ state: '', questions }
			)
		).rejects.toMatchObject({ retriable: true });
	});

	it('redacts a credential echoed in a malformed successful response', async () => {
		const body = okBody({
			answers: { ...answers, category: { ...answers.category, choice: API_KEY } },
		});
		const error = await typesafeDecisionAdapter
			.ask({ apiKey: API_KEY, fetchImpl: async () => new Response(body) }, { state: '', questions })
			.catch((error: unknown) => error);
		expect(error).toBeInstanceOf(DecisionWireError);
		expect((error as Error).message).not.toContain(API_KEY);
		expect(error).toMatchObject({ usage: { promptTokens: 1200 } });
	});
});
