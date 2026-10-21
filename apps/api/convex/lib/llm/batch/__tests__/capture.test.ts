/**
 * A batch request is the request the real-time call would have sent, and its
 * result is read the way the real-time call reads its response.
 * Each case runs the real-time structured call on the model the
 * resolver's adapter builds, over a stubbed network, and the capture and the
 * replay on the batch route's model, and compares them: the same URL and body
 * byte for byte (the task's output ceiling, the schema mode, the temperature),
 * and the same object and billed usage from the same response. Nothing leaves
 * the process.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLlmObject } from '../../dispatch';
import { LlmCallMeter } from '../../requestMeter';
import { languageProviderFor } from '../../../llmProviders';
import { captureObjectRequest, replayObjectResult, type BatchRoute } from '../capture';
import { batchCallOf } from '../calls';

const ENTRIES = {
	entries: [{ type: 'fact', title: 'Renewal', content: 'Acme renews in May.', confidence: 0.9 }],
};

/** The provider's response to a structured request, in the shape its SDK expects. */
function responseFor(url: string, body: Record<string, unknown>): unknown {
	if (url.includes('api.anthropic.com')) {
		const tools = (body['tools'] as { name: string }[] | undefined) ?? [];
		const jsonTool = tools.find((tool) => tool.name === 'json');
		return {
			id: 'msg_1',
			type: 'message',
			role: 'assistant',
			model: body['model'],
			content: jsonTool
				? [{ type: 'tool_use', id: 'tu_1', name: 'json', input: ENTRIES }]
				: [{ type: 'text', text: JSON.stringify(ENTRIES) }],
			stop_reason: jsonTool ? 'tool_use' : 'end_turn',
			stop_sequence: null,
			usage: {
				input_tokens: 120,
				output_tokens: 40,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 20,
			},
		};
	}
	return {
		id: 'resp_1',
		object: 'response',
		created_at: 1_760_000_000,
		status: 'completed',
		model: body['model'],
		output: [
			{
				type: 'message',
				id: 'msg_1',
				status: 'completed',
				role: 'assistant',
				content: [{ type: 'output_text', text: JSON.stringify(ENTRIES), annotations: [] }],
			},
		],
		incomplete_details: null,
		usage: {
			input_tokens: 120,
			input_tokens_details: { cached_tokens: 20 },
			output_tokens: 40,
			output_tokens_details: { reasoning_tokens: 8 },
			total_tokens: 160,
		},
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

const CASES: { name: string; route: BatchRoute; kind: 'openai' | 'anthropic' }[] = [
	{
		name: 'OpenAI (Responses)',
		route: { provider: 'openai-native', apiKey: 'sk-test', modelId: 'gpt-6-luna' },
		kind: 'openai',
	},
	{
		name: 'Anthropic (Messages)',
		route: { provider: 'anthropic-native', apiKey: 'sk-ant-test', modelId: 'claude-haiku-5-5' },
		kind: 'anthropic',
	},
];

describe.each(CASES)('$name', ({ route, kind }) => {
	const call = batchCallOf('knowledge_message');
	const prompt =
		'Extract organizational knowledge from this email message.\n\nBody:\nAcme renews in May.';

	async function realTime() {
		const sent: { url: string; body: Record<string, unknown> }[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				sent.push({ url: String(url), body });
				return new Response(JSON.stringify(responseFor(String(url), body)), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			})
		);
		const model = languageProviderFor(kind).buildChatModel({ apiKey: route.apiKey }, route.modelId);
		const meter = new LlmCallMeter({ task: call.task });
		const result = await runLlmObject({
			model,
			schema: call.schema,
			prompt,
			temperature: call.temperature,
			meter,
		});
		vi.unstubAllGlobals();
		return { sent, result, request: meter.requests[0] };
	}

	it('captures the real-time request byte for byte, sending nothing', async () => {
		const live = await realTime();
		const network = vi.fn();
		vi.stubGlobal('fetch', network);

		const captured = await captureObjectRequest(route, {
			task: call.task,
			schema: call.schema,
			prompt,
			temperature: call.temperature,
		});

		expect(network).not.toHaveBeenCalled();
		expect(live.sent).toHaveLength(1);
		expect(captured.url).toBe(live.sent[0]!.url);
		expect(JSON.stringify(captured.body)).toBe(JSON.stringify(live.sent[0]!.body));
		// The task's output ceiling is on the wire, as in real time.
		const ceiling = captured.body['max_output_tokens'] ?? captured.body['max_tokens'];
		expect(typeof ceiling).toBe('number');
	});

	it('reads a batch result as the real-time call reads the same response', async () => {
		const live = await realTime();
		const body = responseFor(live.sent[0]!.url, live.sent[0]!.body);
		const network = vi.fn();
		vi.stubGlobal('fetch', network);

		const replayed = await replayObjectResult(route, call, body);

		expect(network).not.toHaveBeenCalled();
		expect(replayed.outcome).toBe('succeeded');
		if (replayed.outcome !== 'succeeded') return;
		expect(replayed.object).toEqual(live.result.object);
		expect(call.output(replayed.object)).toEqual({ kind: 'entries', entries: ENTRIES.entries });
		const pick = (r: typeof live.request) => ({
			usage: r?.usage,
			cacheReadTokens: r?.cacheReadTokens,
			cacheWriteTokens: r?.cacheWriteTokens,
			reasoningTokens: r?.reasoningTokens,
			modelUsed: r?.modelUsed,
		});
		expect(pick(replayed.request)).toEqual(pick(live.request));
		expect(replayed.request?.usage?.totalTokens).toBeGreaterThan(0);
	});

	it('reads a result that does not match the schema as invalid, its billed usage kept', async () => {
		const live = await realTime();
		const good = responseFor(live.sent[0]!.url, live.sent[0]!.body) as Record<string, unknown>;
		const broken =
			kind === 'openai'
				? {
						...good,
						output: [
							{
								type: 'message',
								id: 'msg_1',
								status: 'completed',
								role: 'assistant',
								content: [{ type: 'output_text', text: '{"nope":1}', annotations: [] }],
							},
						],
					}
				: {
						...good,
						content: (good['content'] as { type: string }[]).map((part) =>
							part.type === 'tool_use'
								? { ...part, input: { nope: 1 } }
								: { type: 'text', text: '{"nope":1}' }
						),
					};

		const replayed = await replayObjectResult(route, call, broken);

		expect(replayed.outcome).toBe('invalid');
		expect(replayed.request?.usage?.totalTokens).toBeGreaterThan(0);
	});
});
