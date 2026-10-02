/**
 * Unit tests for `lib/decisionProviders/local.ts` — the client for the bundled
 * GLiNER engine (`apps/decision-local`).
 *
 * NOTHING HERE TOUCHES THE NETWORK: every test injects a `fetchImpl`. The
 * engine's own behaviour (how a question becomes a classification head) is
 * covered by the Python suite beside it; this file pins the transport, the
 * failure taxonomy and the one thing that must never change silently — that
 * every answer comes back `calibrated: false`.
 */

import { describe, expect, it, vi } from 'vitest';
import { choice, noul, score } from '../../decision/questions';
import { DecisionWireError } from '../wire';
import {
	DEFAULT_LOCAL_DECISION_DEADLINE_MS,
	DEFAULT_LOCAL_DECISION_MODEL,
	LOCAL_DECISION_DEADLINE_HEADER,
	LOCAL_DECISION_DEFAULT_BASE_URL,
	LOCAL_DECISION_MODELS,
	LocalDecisionError,
	localDecisionAdapter,
} from '../local';

const questions = {
	needsReply: noul('Does this message need a reply?'),
	category: choice('Which category fits?', { person: 'A human wrote it', newsletter: null }),
	urgency: score('How urgent is it?', ['Not urgent', 'This week', 'Immediately']),
};

const answers = {
	needsReply: { type: 'noul', noul: 0.62 },
	category: {
		type: 'choice',
		choice: 'person',
		probabilities: { person: 0.7, newsletter: 0.3 },
		confidence: 0.12,
	},
	urgency: {
		type: 'score',
		score: 1.2,
		legend: { '0': 'Not urgent', '1': 'This week', '2': 'Immediately' },
		probabilities: { '0': 0.2, '1': 0.4, '2': 0.4 },
		confidence: 0.05,
	},
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers },
	});
}

function okBody(over: Record<string, unknown> = {}) {
	return {
		model: DEFAULT_LOCAL_DECISION_MODEL,
		answers,
		usage: { input_tokens: 40, output_tokens: 0 },
		...over,
	};
}

describe('localDecisionAdapter.ask', () => {
	it('posts the hosted wire to the bundled engine and decodes the answers', async () => {
		const fetchImpl = vi.fn(async () => json(okBody()));
		const result = await localDecisionAdapter.ask(
			{ fetchImpl },
			{ state: 'Hello', questions, modelId: DEFAULT_LOCAL_DECISION_MODEL }
		);

		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(`${LOCAL_DECISION_DEFAULT_BASE_URL}/v1/decide`);
		const sent = JSON.parse(init.body as string);
		expect(sent.model).toBe(DEFAULT_LOCAL_DECISION_MODEL);
		expect(sent.state).toBe('Hello');
		expect(Object.keys(sent.questions)).toEqual(['needsReply', 'category', 'urgency']);
		// No credential of any kind rides this request.
		expect(JSON.stringify(init.headers).toLowerCase()).not.toContain('authorization');
		// The engine learns when we stop listening, so it can drop abandoned work.
		expect((init.headers as Record<string, string>)[LOCAL_DECISION_DEADLINE_HEADER]).toBe(
			String(DEFAULT_LOCAL_DECISION_DEADLINE_MS)
		);

		expect(result.answers['needsReply']).toEqual({ kind: 'noul', probability: 0.62 });
		expect(result.answers['category']).toMatchObject({ kind: 'choice', value: 'person' });
		// Same 1..N public scale as every other adapter.
		expect(result.answers['urgency']).toMatchObject({ kind: 'score', value: 2.2 });
		expect(result.usage).toEqual({ promptTokens: 40, completionTokens: 0, totalTokens: 40 });
		expect(result.modelUsed).toBe(DEFAULT_LOCAL_DECISION_MODEL);
		expect(result.provenance).toBe('local');
	});

	it('is never calibrated, whatever the engine reports', async () => {
		const result = await localDecisionAdapter.ask(
			{ fetchImpl: async () => json(okBody()) },
			{ state: 's', questions }
		);
		expect(result.calibrated).toBe(false);
		expect(localDecisionAdapter.calibrated).toBe(false);
	});

	it('sends no model when none was resolved, and uses a configured origin', async () => {
		const fetchImpl = vi.fn(async () => json(okBody()));
		await localDecisionAdapter.ask(
			{ fetchImpl, baseUrl: 'http://10.0.0.5:9000/' },
			{ state: 's', questions }
		);
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('http://10.0.0.5:9000/v1/decide');
		expect(JSON.parse(init.body as string)).not.toHaveProperty('model');
	});

	it('refuses an answer that disagrees with the question set, as the codec does', async () => {
		const { needsReply: _dropped, ...partial } = answers;
		await expect(
			localDecisionAdapter.ask(
				{ fetchImpl: async () => json(okBody({ answers: partial })) },
				{ state: 's', questions }
			)
		).rejects.toBeInstanceOf(DecisionWireError);
	});

	it('treats a loading engine as retriable and carries its Retry-After', async () => {
		const error = await localDecisionAdapter
			.ask(
				{
					fetchImpl: async () =>
						json({ error: { message: 'The model is still loading.' } }, 503, {
							'retry-after': '10',
						}),
				},
				{ state: 's', questions }
			)
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(LocalDecisionError);
		expect((error as LocalDecisionError).status).toBe(503);
		expect((error as LocalDecisionError).retriable).toBe(true);
		expect((error as LocalDecisionError).retryAfterMs).toBe(10_000);
		expect((error as Error).message).toContain('still loading');
	});

	it('names the loaded model when asked for another, and does not retry it', async () => {
		const error = await localDecisionAdapter
			.ask(
				{
					fetchImpl: async () =>
						json(
							{ error: { message: `This engine serves '${DEFAULT_LOCAL_DECISION_MODEL}'.` } },
							404
						),
				},
				{ state: 's', questions, modelId: 'fastino/GLiNER2.5-Decide' }
			)
			.catch((e: unknown) => e);
		expect((error as LocalDecisionError).retriable).toBe(false);
		expect((error as Error).message).toContain(DEFAULT_LOCAL_DECISION_MODEL);
	});

	it('quotes only the engine’s own error field, never an arbitrary body', async () => {
		const error = await localDecisionAdapter
			.ask(
				{
					fetchImpl: async () =>
						new Response('<html>internal admin panel secret</html>', { status: 500 }),
				},
				{ state: 's', questions }
			)
			.catch((e: unknown) => e);
		expect((error as Error).message).toBe('The local decision engine returned HTTP 500.');
		expect((error as LocalDecisionError).retriable).toBe(true);
	});

	it('explains an unreachable engine and lets the dispatch retry it', async () => {
		const error = await localDecisionAdapter
			.ask(
				{
					fetchImpl: async () => {
						throw new TypeError('fetch failed');
					},
				},
				{ state: 's', questions }
			)
			.catch((e: unknown) => e);
		expect((error as Error).message).toContain('decision-local');
		expect((error as LocalDecisionError).retriable).toBe(true);
	});

	it('times out on its own deadline', async () => {
		const error = await localDecisionAdapter
			.ask(
				{
					fetchImpl: (_input, init) =>
						new Promise((_resolve, reject) => {
							init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
						}),
				},
				{ state: 's', questions, deadlineMs: 5 }
			)
			.catch((e: unknown) => e);
		expect((error as Error).message).toContain('5 ms deadline');
		expect(localDecisionAdapter.defaultDeadlineMs).toBe(DEFAULT_LOCAL_DECISION_DEADLINE_MS);
	});

	it('hands a caller’s cancellation back untouched', async () => {
		const controller = new AbortController();
		const reason = new Error('caller gave up');
		const pending = localDecisionAdapter.ask(
			{
				fetchImpl: (_input, init) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
					}),
			},
			{ state: 's', questions, abortSignal: controller.signal }
		);
		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
	});
});

describe('localDecisionAdapter.validateCredentials', () => {
	it('needs nothing at all for the bundled engine', () => {
		expect(() => localDecisionAdapter.validateCredentials({})).not.toThrow();
	});

	it('accepts an internal http origin — that is where the engine lives', () => {
		expect(() =>
			localDecisionAdapter.validateCredentials({ baseUrl: 'http://decision-local:8080' })
		).not.toThrow();
	});

	it('refuses credentials in the origin, a non-http scheme and a full endpoint', () => {
		expect(() =>
			localDecisionAdapter.validateCredentials({ baseUrl: 'http://user:pass@decision-local' })
		).toThrow(/credentials/);
		expect(() =>
			localDecisionAdapter.validateCredentials({ baseUrl: 'file:///etc/passwd' })
		).toThrow(/http/);
		expect(() =>
			localDecisionAdapter.validateCredentials({ baseUrl: 'http://decision-local:8080/v1/decide' })
		).toThrow(/appended automatically/);
	});
});

describe('localDecisionAdapter.listModels', () => {
	it('puts the checkpoint the engine actually loaded first', async () => {
		const fetchImpl = vi.fn(async (_input: string) =>
			json({ data: [{ id: 'fastino/GLiNER2.5-Decide', ready: true }] })
		);
		const models = await localDecisionAdapter.listModels!({ fetchImpl });
		expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${LOCAL_DECISION_DEFAULT_BASE_URL}/v1/models`);
		expect(models[0]).toBe('fastino/GLiNER2.5-Decide');
		expect(new Set(models)).toEqual(new Set(LOCAL_DECISION_MODELS));
	});

	it('defaults to the newest multilingual GLiNER Decide checkpoint', () => {
		expect(localDecisionAdapter.defaultModel).toBe('fastino/GLiNER2.5-multi-Decide');
		expect(LOCAL_DECISION_MODELS[0]).toBe(localDecisionAdapter.defaultModel);
	});
});
