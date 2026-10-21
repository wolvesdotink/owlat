/**
 * The batch transport reads a request's result only from its own record:
 * an expired or cancelled batch whose output has no
 * line, or a malformed one, for the request is `missing` (billing unknown, so
 * it is charged in full), on both providers. Only the request's own unrun or
 * error record releases its hold.
 */

import { describe, expect, it, vi } from 'vitest';
import { batchTransport } from '../transport';

const json = (value: unknown) =>
	new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

function openai(status: string, files: { output?: string; errors?: string }) {
	const fetchFn = vi.fn(async (url: string) => {
		if (url.endsWith('/batches/b1')) {
			return json({
				id: 'b1',
				status,
				...(files.output === undefined ? {} : { output_file_id: 'f-out' }),
				...(files.errors === undefined ? {} : { error_file_id: 'f-err' }),
			});
		}
		if (url.endsWith('/files/f-out/content')) return new Response(files.output ?? '');
		if (url.endsWith('/files/f-err/content')) return new Response(files.errors ?? '');
		throw new Error(`unexpected ${url}`);
	});
	return batchTransport('openai-native', 'sk-test', fetchFn);
}

function anthropic(results: string) {
	const fetchFn = vi.fn(async (url: string) => {
		if (url.endsWith('/messages/batches/b1')) return json({ id: 'b1', processing_status: 'ended' });
		if (url.endsWith('/messages/batches/b1/results')) return new Response(results);
		throw new Error(`unexpected ${url}`);
	});
	return batchTransport('anthropic-native', 'sk-ant-test', fetchFn);
}

async function resultOf(transport: ReturnType<typeof batchTransport>) {
	const state = await transport.state('b1');
	if (state.state !== 'ended') throw new Error('not ended');
	return transport.result('b1', state, 'req-1');
}

describe('a request without its own record is missing, not unbilled', () => {
	it.each(['expired', 'cancelled'])('OpenAI, a %s batch with no output at all', async (status) => {
		expect(await resultOf(openai(status, {}))).toEqual({ kind: 'missing' });
	});

	it.each(['expired', 'cancelled'])(
		'OpenAI, a %s batch whose files hold no usable line for the request',
		async (status) => {
			const output = `not json\n${JSON.stringify({ custom_id: 'other', response: { status_code: 200, body: {} } })}\n`;
			const errors = `${JSON.stringify({ custom_id: 'req-1', response: { status_code: 200 } })}\n`;
			expect(await resultOf(openai(status, { output, errors }))).toEqual({ kind: 'missing' });
		}
	);

	it('OpenAI: the request’s own unrun record is definite', async () => {
		const errors = `${JSON.stringify({ custom_id: 'req-1', response: null, error: { code: 'batch_expired' } })}\n`;
		expect(await resultOf(openai('expired', { errors }))).toEqual({ kind: 'expired' });
	});

	it.each([
		['no results', ''],
		['a malformed line', 'not json\n'],
		[
			'another request’s expiry',
			`${JSON.stringify({ custom_id: 'other', result: { type: 'expired' } })}\n`,
		],
		[
			'a success without a message',
			`${JSON.stringify({ custom_id: 'req-1', result: { type: 'succeeded' } })}\n`,
		],
	])('Anthropic, an ended batch with %s', async (_name, results) => {
		expect(await resultOf(anthropic(results))).toEqual({ kind: 'missing' });
	});

	it('Anthropic: the request’s own canceled record is definite', async () => {
		const results = `${JSON.stringify({ custom_id: 'req-1', result: { type: 'canceled' } })}\n`;
		expect(await resultOf(anthropic(results))).toEqual({ kind: 'canceled' });
	});
});
