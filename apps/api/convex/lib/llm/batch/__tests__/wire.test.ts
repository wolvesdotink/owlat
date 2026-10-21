/**
 * The provider batch wire formats: one captured request becomes
 * one batch request line, and the request's result is read back from the
 * batch's output, with every unbilled outcome told apart from a success and
 * from a result nobody can find.
 */

import { describe, expect, it } from 'vitest';
import {
	anthropicBatchBody,
	anthropicBatchState,
	anthropicResult,
	assertBatchable,
	openaiBatchEndpoint,
	openaiBatchLine,
	openaiBatchState,
	openaiResult,
	UnsupportedBatchRequestError,
} from '../wire';

const openaiRequest = {
	url: 'https://api.openai.com/v1/responses',
	body: { model: 'gpt-6-luna', input: [{ role: 'user', content: 'hi' }], max_output_tokens: 100 },
};
const anthropicRequest = {
	url: 'https://api.anthropic.com/v1/messages',
	body: { model: 'claude-haiku', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 },
	betaHeader: 'structured-outputs-2025-11-13',
};

describe('batch request lines', () => {
	it('OpenAI: one JSONL line carrying the real-time body under its endpoint path', () => {
		const line = openaiBatchLine('req-1', openaiRequest);
		expect(line.endsWith('\n')).toBe(true);
		expect(JSON.parse(line)).toEqual({
			custom_id: 'req-1',
			method: 'POST',
			url: '/v1/responses',
			body: openaiRequest.body,
		});
		expect(openaiBatchEndpoint(openaiRequest)).toBe('/v1/responses');
	});

	it('Anthropic: the real-time body as the request params, never streamed', () => {
		expect(
			anthropicBatchBody('req-1', {
				...anthropicRequest,
				body: { ...anthropicRequest.body, stream: false },
			})
		).toEqual({ requests: [{ custom_id: 'req-1', params: anthropicRequest.body }] });
	});

	it('refuses what a batch cannot carry: another endpoint, a streamed request', () => {
		expect(() =>
			assertBatchable('openai-native', {
				...openaiRequest,
				url: 'https://api.openai.com/v1/embeddings',
			})
		).toThrow(UnsupportedBatchRequestError);
		expect(() => assertBatchable('anthropic-native', openaiRequest)).toThrow(
			UnsupportedBatchRequestError
		);
		expect(() =>
			assertBatchable('anthropic-native', {
				...anthropicRequest,
				body: { ...anthropicRequest.body, stream: true },
			})
		).toThrow(UnsupportedBatchRequestError);
		expect(() => assertBatchable('openai-native', openaiRequest)).not.toThrow();
	});
});

describe('batch states', () => {
	it('OpenAI: running until a terminal status, then the files to read', () => {
		for (const status of ['validating', 'in_progress', 'finalizing', 'cancelling']) {
			expect(openaiBatchState({ status })).toEqual({ state: 'running' });
		}
		expect(openaiBatchState({ status: 'completed', output_file_id: 'f-out' })).toEqual({
			state: 'ended',
			status: 'completed',
			outputFileId: 'f-out',
		});
		expect(openaiBatchState(null)).toEqual({ state: 'running' });
	});

	it('Anthropic: running until processing has ended', () => {
		expect(anthropicBatchState({ processing_status: 'in_progress' })).toEqual({
			state: 'running',
		});
		expect(anthropicBatchState({ processing_status: 'ended', results_url: 'https://x' })).toEqual({
			state: 'ended',
			status: 'ended',
		});
	});
});

describe('batch results', () => {
	const line = (customId: string, statusCode: number, body: unknown) =>
		JSON.stringify({ custom_id: customId, response: { status_code: statusCode, body } });
	const unrun = (customId: string, code: string) =>
		JSON.stringify({ custom_id: customId, response: null, error: { code, message: 'x' } });

	it('OpenAI: the 200 response body of the request’s own line', () => {
		const output = [line('other', 200, { id: 'x' }), line('req-1', 200, { id: 'mine' })].join('\n');
		expect(openaiResult({ output }, 'req-1')).toEqual({ kind: 'succeeded', body: { id: 'mine' } });
	});

	it('OpenAI: unbilled only on the request’s own evidence: an error response or its unrun record', () => {
		expect(openaiResult({ errors: line('req-1', 400, {}) }, 'req-1')).toEqual({ kind: 'errored' });
		expect(openaiResult({ output: line('req-1', 500, {}) }, 'req-1')).toEqual({ kind: 'errored' });
		expect(openaiResult({ errors: unrun('req-1', 'batch_expired') }, 'req-1')).toEqual({
			kind: 'expired',
		});
		expect(openaiResult({ errors: unrun('req-1', 'batch_cancelled') }, 'req-1')).toEqual({
			kind: 'canceled',
		});
	});

	it('OpenAI: no line, or a malformed one, is missing (the batch status is not consulted)', () => {
		const malformed = [
			'not json',
			JSON.stringify({ custom_id: 'req-1' }),
			JSON.stringify({ custom_id: 'req-1', response: { status_code: 200 } }),
			JSON.stringify({ custom_id: 'req-1', response: { status_code: 200, body: 'text' } }),
			JSON.stringify({ custom_id: 'req-1', response: null, error: { code: 'other' } }),
			unrun('other', 'batch_expired'),
		];
		expect(openaiResult({}, 'req-1')).toEqual({ kind: 'missing' });
		for (const text of malformed) {
			expect(openaiResult({ output: text }, 'req-1')).toEqual({ kind: 'missing' });
			expect(openaiResult({ errors: text }, 'req-1')).toEqual({ kind: 'missing' });
		}
	});

	it('Anthropic: each result type of the request’s own line', () => {
		const results = (result: unknown) => JSON.stringify({ custom_id: 'req-1', result });
		expect(anthropicResult(results({ type: 'succeeded', message: { id: 'm' } }), 'req-1')).toEqual({
			kind: 'succeeded',
			body: { id: 'm' },
		});
		expect(anthropicResult(results({ type: 'errored', error: {} }), 'req-1')).toEqual({
			kind: 'errored',
		});
		expect(anthropicResult(results({ type: 'expired' }), 'req-1')).toEqual({ kind: 'expired' });
		expect(anthropicResult(results({ type: 'canceled' }), 'req-1')).toEqual({ kind: 'canceled' });
	});

	it('Anthropic: no line, or a malformed one, is missing', () => {
		const results = (result: unknown) => JSON.stringify({ custom_id: 'req-1', result });
		for (const text of [
			'',
			'not json',
			results({ type: 'succeeded' }),
			results({ type: 'succeeded', message: 'text' }),
			results({ type: 'unknown' }),
			JSON.stringify({ custom_id: 'req-1' }),
			JSON.stringify({ custom_id: 'other', result: { type: 'expired' } }),
		]) {
			expect(anthropicResult(text, 'req-1')).toEqual({ kind: 'missing' });
		}
	});
});
