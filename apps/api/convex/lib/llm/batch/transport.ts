/**
 * The HTTP side of the provider batch APIs: submit one
 * captured request as a batch, read the batch's state, and read the request's
 * result line. Fixed native endpoints only (the batch path is offered only for
 * `openai-native` and `anthropic-native`), so the key never goes anywhere
 * else: Anthropic's `results_url` is not followed, the path is rebuilt from
 * the batch id. Runtime-neutral; `fetchImpl` is injectable for tests.
 *
 * Errors carry an HTTP status at most, never a response body.
 */

import type { BatchProvider } from '../../validators/aiRouting';
import {
	anthropicBatchBody,
	anthropicBatchState,
	anthropicResult,
	openaiBatchEndpoint,
	openaiBatchLine,
	openaiBatchState,
	openaiResult,
	type BatchResult,
	type BatchState,
	type CapturedRequest,
} from './wire';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const OPENAI_BASE = 'https://api.openai.com/v1';
const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
/** Each HTTP call's own limit. */
const HTTP_TIMEOUT_MS = 30_000;
/** The completion window both providers offer: the batch ends, run or not, within it. */
export const BATCH_COMPLETION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A batch HTTP call failed. `status` is the provider's HTTP status, absent for a network failure. */
export class BatchHttpError extends Error {
	readonly status: number | undefined;
	constructor(what: string, status: number | undefined) {
		super(status === undefined ? `${what}: no response` : `${what}: HTTP ${status}`);
		this.name = 'BatchHttpError';
		this.status = status;
	}
}

/**
 * A submission that did not go through. `isDefinite`: the provider answered
 * and created nothing, so nothing can be billed; otherwise the batch may exist
 * (a timeout or a server error after the request left).
 */
export class BatchSubmitError extends Error {
	readonly isDefinite: boolean;
	constructor(cause: unknown, isDefinite: boolean) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = 'BatchSubmitError';
		this.isDefinite = isDefinite;
	}
}

export interface BatchTransport {
	/** Create a batch holding the one request; `fileId` is OpenAI's input file. */
	submit(
		customId: string,
		captured: CapturedRequest
	): Promise<{ readonly batchId: string; readonly fileId?: string }>;
	state(batchId: string): Promise<BatchState>;
	/** The request's result in a batch that has ended. */
	result(
		batchId: string,
		state: Extract<BatchState, { state: 'ended' }>,
		customId: string
	): Promise<BatchResult>;
	/** Best effort: delete what an ended batch left in the provider's file store. */
	cleanup(state: Extract<BatchState, { state: 'ended' }>, fileId?: string): Promise<void>;
}

async function send(
	fetchImpl: Fetch,
	what: string,
	url: string,
	init: RequestInit
): Promise<Response> {
	let response: Response;
	try {
		response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
	} catch {
		throw new BatchHttpError(what, undefined);
	}
	if (!response.ok) throw new BatchHttpError(what, response.status);
	return response;
}

/** A create call that failed with a client error created nothing; anything else may have. */
function isDefiniteRefusal(error: unknown): boolean {
	return error instanceof BatchHttpError && error.status !== undefined && error.status < 500;
}

function openaiTransport(apiKey: string, fetchImpl: Fetch): BatchTransport {
	const auth = { authorization: `Bearer ${apiKey}` };
	const json = (what: string, url: string, init: RequestInit = {}) =>
		send(fetchImpl, what, url, { ...init, headers: { ...auth, ...init.headers } }).then(
			(response) => response.json() as Promise<{ id?: unknown }>
		);
	const fileText = async (fileId: string) =>
		(
			await send(fetchImpl, 'batch file', `${OPENAI_BASE}/files/${fileId}/content`, {
				headers: auth,
			})
		).text();
	const deleteFile = (fileId: string) =>
		send(fetchImpl, 'batch file delete', `${OPENAI_BASE}/files/${fileId}`, {
			method: 'DELETE',
			headers: auth,
		}).then(
			() => undefined,
			() => undefined
		);

	return {
		async submit(customId, captured) {
			const line = openaiBatchLine(customId, captured);
			const form = new FormData();
			form.append('purpose', 'batch');
			form.append('file', new Blob([line], { type: 'application/jsonl' }), `${customId}.jsonl`);
			let fileId: string;
			try {
				const file = await json('batch upload', `${OPENAI_BASE}/files`, {
					method: 'POST',
					body: form,
				});
				if (typeof file.id !== 'string') throw new BatchHttpError('batch upload', undefined);
				fileId = file.id;
			} catch (error) {
				// Nothing is billed for a file: an upload that failed either way is definite.
				throw new BatchSubmitError(error, true);
			}
			try {
				const batch = await json('batch create', `${OPENAI_BASE}/batches`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						input_file_id: fileId,
						endpoint: openaiBatchEndpoint(captured),
						completion_window: '24h',
					}),
				});
				if (typeof batch.id !== 'string') throw new BatchHttpError('batch create', undefined);
				return { batchId: batch.id, fileId };
			} catch (error) {
				const isDefinite = isDefiniteRefusal(error);
				if (isDefinite) await deleteFile(fileId);
				throw new BatchSubmitError(error, isDefinite);
			}
		},
		async state(batchId) {
			return openaiBatchState(await json('batch state', `${OPENAI_BASE}/batches/${batchId}`));
		},
		async result(_batchId, state, customId) {
			const [output, errors] = await Promise.all([
				state.outputFileId ? fileText(state.outputFileId) : undefined,
				state.errorFileId ? fileText(state.errorFileId) : undefined,
			]);
			return openaiResult(
				{
					...(output === undefined ? {} : { output }),
					...(errors === undefined ? {} : { errors }),
				},
				customId
			);
		},
		async cleanup(state, fileId) {
			for (const id of [fileId, state.outputFileId, state.errorFileId]) {
				if (id) await deleteFile(id);
			}
		},
	};
}

function anthropicTransport(apiKey: string, fetchImpl: Fetch): BatchTransport {
	const headers = { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
	return {
		async submit(customId, captured) {
			try {
				const response = await send(
					fetchImpl,
					'batch create',
					`${ANTHROPIC_BASE}/messages/batches`,
					{
						method: 'POST',
						headers: {
							...headers,
							'content-type': 'application/json',
							...(captured.betaHeader ? { 'anthropic-beta': captured.betaHeader } : {}),
						},
						body: JSON.stringify(anthropicBatchBody(customId, captured)),
					}
				);
				const batch = (await response.json()) as { id?: unknown };
				if (typeof batch.id !== 'string') throw new BatchHttpError('batch create', undefined);
				return { batchId: batch.id };
			} catch (error) {
				throw new BatchSubmitError(error, isDefiniteRefusal(error));
			}
		},
		async state(batchId) {
			const response = await send(
				fetchImpl,
				'batch state',
				`${ANTHROPIC_BASE}/messages/batches/${batchId}`,
				{ headers }
			);
			return anthropicBatchState(await response.json());
		},
		async result(batchId, _state, customId) {
			const response = await send(
				fetchImpl,
				'batch results',
				`${ANTHROPIC_BASE}/messages/batches/${batchId}/results`,
				{ headers }
			);
			return anthropicResult(await response.text(), customId);
		},
		async cleanup() {
			// Anthropic keeps results for 29 days and deletes them itself.
		},
	};
}

/** The transport of a batch-capable provider, with its key. */
export function batchTransport(
	provider: BatchProvider,
	apiKey: string,
	fetchImpl: Fetch = (input, init) => fetch(input, init)
): BatchTransport {
	return provider === 'openai-native'
		? openaiTransport(apiKey, fetchImpl)
		: anthropicTransport(apiKey, fetchImpl);
}
