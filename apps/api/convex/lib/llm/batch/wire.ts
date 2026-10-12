/**
 * Provider batch APIs on the wire (ADR-0073, L14): the batch request a provider
 * takes for one captured model request, the batch states Owlat reads back, and
 * the result line of that one request. Pure and runtime-neutral; the HTTP is in
 * `./transport.ts`.
 *
 * One request per provider batch. The provider then holds the prompt, and
 * Owlat stores ids only (`llmBatchItems`). Both providers bill a batch request
 * at half the list price and bill nothing for a request that errored, expired
 * or was cancelled.
 *
 *   - OpenAI Batch API: a JSONL file of `{custom_id, method, url, body}` lines,
 *     uploaded with `purpose=batch`, then a batch over it; the results are the
 *     output file (`{custom_id, response: {status_code, body}}`) and the error
 *     file.
 *   - Anthropic Message Batches: `{requests: [{custom_id, params}]}`; the
 *     results are JSONL `{custom_id, result: {type, message?}}` at `results_url`.
 */

import type { BatchProvider } from '../../validators/aiRouting';

/** One model request as the provider's SDK would have sent it in real time. */
export interface CapturedRequest {
	/** The full request URL (only its path goes into a batch line). */
	readonly url: string;
	/** The JSON body. */
	readonly body: Record<string, unknown>;
	/** Anthropic's beta header, which a batch carries on its create call. */
	readonly betaHeader?: string;
}

/** A request the batch path cannot carry; the caller makes it in real time instead. */
export class UnsupportedBatchRequestError extends Error {
	constructor(reason: string) {
		super(`Not sendable through a batch: ${reason}`);
		this.name = 'UnsupportedBatchRequestError';
	}
}

/** The endpoints each provider's batch API accepts that Owlat's calls use. */
const BATCH_PATHS: Readonly<Record<BatchProvider, readonly string[]>> = {
	'openai-native': ['/v1/responses', '/v1/chat/completions'],
	'anthropic-native': ['/v1/messages'],
};

/** The request's body without the stream flag: a batch request is never streamed. */
function unstreamed(body: Record<string, unknown>): Record<string, unknown> {
	if (body['stream'] === true) throw new UnsupportedBatchRequestError('a streamed request');
	const { stream: _stream, ...rest } = body;
	return rest;
}

function batchPath(provider: BatchProvider, captured: CapturedRequest): string {
	let path: string;
	try {
		path = new URL(captured.url).pathname;
	} catch {
		throw new UnsupportedBatchRequestError('an unreadable request URL');
	}
	if (!BATCH_PATHS[provider].includes(path)) {
		throw new UnsupportedBatchRequestError(`the endpoint ${path}`);
	}
	return path;
}

/** Throws {@link UnsupportedBatchRequestError} unless `provider`'s batch API takes `captured`. */
export function assertBatchable(provider: BatchProvider, captured: CapturedRequest): void {
	batchPath(provider, captured);
	unstreamed(captured.body);
}

/** OpenAI: the one JSONL line of the batch's input file. */
export function openaiBatchLine(customId: string, captured: CapturedRequest): string {
	const url = batchPath('openai-native', captured);
	return `${JSON.stringify({ custom_id: customId, method: 'POST', url, body: unstreamed(captured.body) })}\n`;
}

/** OpenAI: the endpoint a batch over that file is created for. */
export function openaiBatchEndpoint(captured: CapturedRequest): string {
	return batchPath('openai-native', captured);
}

/** Anthropic: the create call's body. */
export function anthropicBatchBody(
	customId: string,
	captured: CapturedRequest
): { requests: { custom_id: string; params: Record<string, unknown> }[] } {
	batchPath('anthropic-native', captured);
	return { requests: [{ custom_id: customId, params: unstreamed(captured.body) }] };
}

/** Where a batch is. `ended` carries what the result is read from (OpenAI's files). */
export type BatchState =
	| { readonly state: 'running' }
	| {
			readonly state: 'ended';
			/** OpenAI's status (`completed`, `failed`, `expired`, `cancelled`); Anthropic: `ended`. */
			readonly status: string;
			readonly outputFileId?: string;
			readonly errorFileId?: string;
	  };

const OPENAI_TERMINAL = new Set(['completed', 'failed', 'expired', 'cancelled']);

/** An OpenAI batch object, as `GET /v1/batches/{id}` returns it. */
export function openaiBatchState(batch: unknown): BatchState {
	const b = (batch ?? {}) as {
		status?: unknown;
		output_file_id?: unknown;
		error_file_id?: unknown;
	};
	const status = typeof b.status === 'string' ? b.status : '';
	if (!OPENAI_TERMINAL.has(status)) return { state: 'running' };
	return {
		state: 'ended',
		status,
		...(typeof b.output_file_id === 'string' ? { outputFileId: b.output_file_id } : {}),
		...(typeof b.error_file_id === 'string' ? { errorFileId: b.error_file_id } : {}),
	};
}

/** An Anthropic batch object, as `GET /v1/messages/batches/{id}` returns it. */
export function anthropicBatchState(batch: unknown): BatchState {
	const b = (batch ?? {}) as { processing_status?: unknown };
	// Its `results_url` is not followed: the transport rebuilds the fixed path.
	return b.processing_status === 'ended'
		? { state: 'ended', status: 'ended' }
		: { state: 'running' };
}

/**
 * The request's result. `succeeded` carries the response body exactly as the
 * real-time endpoint returns it, so the SDK parses it the same way. The other
 * kinds are not billed by either provider. `missing`: the batch ended and no
 * line names the request; whether it was billed is unknown.
 */
export type BatchResult =
	| { readonly kind: 'succeeded'; readonly body: unknown }
	| { readonly kind: 'errored' | 'expired' | 'canceled' }
	| { readonly kind: 'missing' };

interface ResultLine {
	custom_id?: unknown;
	response?: unknown;
	result?: unknown;
}

function jsonLines(text: string): ResultLine[] {
	const lines: ResultLine[] = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (parsed && typeof parsed === 'object') lines.push(parsed as ResultLine);
		} catch {
			// A line that is not JSON names no request.
		}
	}
	return lines;
}

function lineFor(text: string | undefined, customId: string): ResultLine | undefined {
	if (text === undefined) return undefined;
	return jsonLines(text).find((line) => line.custom_id === customId);
}

/**
 * OpenAI: the result in the output file (a 200 response) or the error file,
 * else what the batch's own status says about a request it never ran.
 */
export function openaiResult(
	state: Extract<BatchState, { state: 'ended' }>,
	files: { readonly output?: string; readonly errors?: string },
	customId: string
): BatchResult {
	for (const text of [files.output, files.errors]) {
		const line = lineFor(text, customId);
		if (!line) continue;
		const response = (line.response ?? null) as { status_code?: unknown; body?: unknown } | null;
		if (response?.status_code === 200 && response.body !== undefined) {
			return { kind: 'succeeded', body: response.body };
		}
		return { kind: 'errored' };
	}
	// No line: the batch did not run the request.
	if (state.status === 'expired') return { kind: 'expired' };
	if (state.status === 'cancelled') return { kind: 'canceled' };
	if (state.status === 'failed') return { kind: 'errored' };
	return { kind: 'missing' };
}

/** Anthropic: the request's line in the results file. */
export function anthropicResult(results: string, customId: string): BatchResult {
	const line = lineFor(results, customId);
	const result = (line?.result ?? null) as { type?: unknown; message?: unknown } | null;
	switch (result?.type) {
		case 'succeeded':
			return result.message === undefined
				? { kind: 'missing' }
				: { kind: 'succeeded', body: result.message };
		case 'errored':
			return { kind: 'errored' };
		case 'expired':
			return { kind: 'expired' };
		case 'canceled':
			return { kind: 'canceled' };
		default:
			return { kind: 'missing' };
	}
}
