'use node';

/**
 * Local decision adapter — a GLiNER2.5 Decide checkpoint on the operator's own
 * hardware, served by the bundled `decision-local` container
 * (`apps/decision-local`).
 *
 * WHY IT EXISTS: the native adapter sends every judgement's state to a vendor,
 * and the language-backed one can only return degenerate probabilities. This
 * one keeps the text on the server AND returns a real distribution per
 * question, from an encoder classifier that answers in one forward pass
 * instead of generating tokens. GLiNER2.5-multi-Decide is the default because
 * inbound mail is not English-only.
 *
 * SAME WIRE AS THE NATIVE ADAPTER. The container speaks the request/response
 * shape `./wire.ts` already encodes and decodes, so this file reuses that codec
 * unchanged: a missing or extra answer, an option that was never offered, or a
 * distribution that does not sum to one is the same hard `DecisionWireError`
 * here as there. Only the path differs (`/v1/decide`), because the container is
 * ours and is not pretending to be the vendor.
 *
 * NOT CALIBRATED, and stamped so on every result. The probabilities are a
 * softmax over the model's logits, which is a distribution but not a measured
 * one — nobody has run the calibration harness against it — so every threshold
 * downstream stays inert, exactly as it does for the language-backed adapter.
 *
 * TRANSPORT. Plain `fetch`, not `fetchGuarded`: the guard refuses private
 * hosts, and a private host on the Docker network is the whole point of this
 * adapter. What makes that acceptable is what the request does NOT carry — no
 * key, no credential of any kind — plus the shape check in
 * {@link validateCredentials} (http(s) only, no `user:pass@`) and the fact that
 * only an `organization:manage` admin can set the base URL. The response body
 * is never reflected wholesale: only the container's own `error.message` field
 * is quoted back, truncated, so pointing the base URL at some other internal
 * service cannot turn the test button into a way of reading it.
 *
 * Retry is not decided here, as in the native adapter: errors carry their
 * status and the dispatch classifies them. 503 while the model loads is
 * retriable and carries the container's `Retry-After`.
 */

import { isRetriableLlmError } from '../llm/dispatch';
import { validateOutboundUrl } from '../outboundUrlValidation';
import type { ProviderClientConfig } from '../llmProviders/types';
import type { DecisionProviderAdapter, DecisionRequest, DecisionResult } from './types';
import { decodeResponse, encodeQuestions } from './wire';

/** The compose service on the internal network. `localhost` would be the Convex container itself. */
export const LOCAL_DECISION_DEFAULT_BASE_URL = 'http://decision-local:8080';

/** Appended to whichever origin is configured. */
export const LOCAL_DECISION_PATH = '/v1/decide';

/** Lists the one checkpoint the container has loaded. */
export const LOCAL_DECISION_MODELS_PATH = '/v1/models';

/**
 * The checkpoint the container loads by default — the newest GLiNER release
 * (GLiNER2.5 Decide, September 2026), in its multilingual variant. Mirrors
 * `DEFAULT_MODEL` in `apps/decision-local/engine.py`; the container is what
 * decides, this is what the settings card shows before it has been asked.
 */
export const DEFAULT_LOCAL_DECISION_MODEL = 'fastino/GLiNER2.5-multi-Decide';

/**
 * The Decide family, multilingual first. The English-only 340M checkpoint
 * scores highest on the vendor's English benchmark; the 1B one is the largest.
 * Switching is a container setting (`DECISION_LOCAL_MODEL`), because a
 * checkpoint is a download, not a request parameter.
 */
export const LOCAL_DECISION_MODELS = [
	DEFAULT_LOCAL_DECISION_MODEL,
	'fastino/GLiNER2.5-Decide',
	'fastino/GLiNER2.5-Decide-1B',
] as const;

/**
 * Per-request budget. A forward pass over one chunk of mail takes well under a
 * second on a few CPU cores, but a long message is several chunks and the
 * container serves one request at a time, so a burst queues behind itself.
 */
export const DEFAULT_LOCAL_DECISION_DEADLINE_MS = 30_000;

// Long enough for the engine's wrong-model message, which names both ids and the fix.
const MAX_ERROR_DETAIL_LENGTH = 300;

/** A failed round trip to the local engine, classified the way the dispatch reads it. */
export class LocalDecisionError extends Error {
	readonly status?: number;
	readonly retryAfterMs?: number;
	readonly retriable: boolean;

	constructor(
		message: string,
		options: { status?: number; retryAfterMs?: number; retriable?: boolean; cause?: unknown } = {}
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = 'LocalDecisionError';
		this.status = options.status;
		this.retryAfterMs = options.retryAfterMs;
		this.retriable = options.retriable ?? isRetriableLlmError(this);
	}
}

function originOf(cfg: ProviderClientConfig): string {
	return (cfg.baseUrl ?? LOCAL_DECISION_DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function fetcherFor(
	cfg: ProviderClientConfig
): (input: string, init?: RequestInit) => Promise<Response> {
	return cfg.fetchImpl ?? ((input, init) => fetch(input, init));
}

function deadlineSignal(req: DecisionRequest, deadlineMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(deadlineMs);
	return req.abortSignal ? AbortSignal.any([req.abortSignal, timeout]) : timeout;
}

function isAbortLike(error: unknown): boolean {
	return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function transportError(
	error: unknown,
	cfg: ProviderClientConfig,
	req: DecisionRequest,
	deadlineMs: number
): unknown {
	if (req.abortSignal?.aborted) return req.abortSignal.reason ?? error;
	if (isAbortLike(error)) {
		return new LocalDecisionError(
			`The local decision engine did not answer within the ${deadlineMs} ms deadline.`,
			{ retriable: true, cause: error }
		);
	}
	return new LocalDecisionError(
		`The local decision engine at ${originOf(cfg)} could not be reached. Check that the ` +
			'decision-local service is running (compose profile `decision-local`).',
		{ retriable: true, cause: error }
	);
}

function retryAfterMs(response: Response): number | undefined {
	const seconds = Number(response.headers.get('retry-after'));
	return response.headers.has('retry-after') && Number.isFinite(seconds) && seconds >= 0
		? Math.round(seconds * 1000)
		: undefined;
}

/**
 * The container's own `{ error: { message } }`, truncated — and nothing else.
 * A body in any other shape came from something that is not the engine, and is
 * not ours to quote.
 */
async function errorDetail(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { error?: { message?: unknown } } | null;
		const message = body?.error?.message;
		if (typeof message !== 'string' || message.trim().length === 0) return '';
		const flat = message.replace(/\s+/g, ' ').trim();
		return ` ${flat.length > MAX_ERROR_DETAIL_LENGTH ? `${flat.slice(0, MAX_ERROR_DETAIL_LENGTH)}…` : flat}`;
	} catch {
		return '';
	}
}

function statusMessage(status: number): string {
	switch (status) {
		case 404:
			return 'The local decision engine does not serve this model or path (HTTP 404).';
		case 422:
			return 'The local decision engine rejected the question set (HTTP 422).';
		case 503:
			return 'The local decision engine is not ready (HTTP 503).';
		default:
			return `The local decision engine returned HTTP ${status}.`;
	}
}

async function responseError(response: Response): Promise<LocalDecisionError> {
	const status = response.status;
	const detail = await errorDetail(response);
	return new LocalDecisionError(`${statusMessage(status)}${detail}`, {
		status,
		// A redirect means the base URL is not the engine; following it is not our job.
		retriable: status >= 300 && status < 400 ? false : undefined,
		retryAfterMs: retryAfterMs(response),
	});
}

export const localDecisionAdapter: DecisionProviderAdapter<'local'> = {
	kind: 'local',
	label: 'Local (GLiNER)',
	docsUrl: 'https://docs.owlat.app/developer/providers',
	defaultBaseUrl: LOCAL_DECISION_DEFAULT_BASE_URL,
	defaultModel: DEFAULT_LOCAL_DECISION_MODEL,
	calibrated: false,
	isLocal: true,
	requiresApiKey: false,
	defaultDeadlineMs: DEFAULT_LOCAL_DECISION_DEADLINE_MS,
	defaultEndpointProvenance: 'local',
	handlesRetries: false,

	async ask(cfg: ProviderClientConfig, req: DecisionRequest): Promise<DecisionResult> {
		const deadlineMs = req.deadlineMs ?? DEFAULT_LOCAL_DECISION_DEADLINE_MS;
		const questions = encodeQuestions(req.questions);
		const model = req.modelId?.trim();

		let response: Response;
		try {
			response = await fetcherFor(cfg)(`${originOf(cfg)}${LOCAL_DECISION_PATH}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ ...(model ? { model } : {}), state: req.state, questions }),
				redirect: 'manual',
				signal: deadlineSignal(req, deadlineMs),
			});
		} catch (error) {
			throw transportError(error, cfg, req, deadlineMs);
		}
		if (!response.ok) throw await responseError(response);

		let body: unknown;
		try {
			body = await response.json();
		} catch (error) {
			if (isAbortLike(error) || req.abortSignal?.aborted) {
				throw transportError(error, cfg, req, deadlineMs);
			}
			throw new LocalDecisionError(
				'The local decision engine answered with a body that is not JSON. Check that the base ' +
					'URL points at the decision-local service.',
				{ retriable: false, cause: error }
			);
		}

		const decoded = decodeResponse(req.questions, body);
		return {
			answers: decoded.answers,
			usage: decoded.usage,
			modelUsed: decoded.modelUsed,
			provenance: 'local',
			calibrated: false,
		};
	},

	/**
	 * No key to check, so this checks the one thing an operator can get wrong
	 * here: the origin. http is allowed (it is an internal service), credentials
	 * in the URL are not, and the endpoint path belongs to the adapter.
	 */
	validateCredentials(cfg: ProviderClientConfig): void {
		if (cfg.baseUrl === undefined) return;
		const check = validateOutboundUrl(originOf(cfg), { requirePublic: false });
		if (!check.ok) {
			throw new Error(`The local decision engine base URL ${check.error}.`);
		}
		if (originOf(cfg).endsWith(LOCAL_DECISION_PATH)) {
			throw new Error(
				`The local decision engine base URL must be its origin (e.g. ` +
					`${LOCAL_DECISION_DEFAULT_BASE_URL}); ${LOCAL_DECISION_PATH} is appended automatically.`
			);
		}
	},

	/**
	 * What the container actually loaded, first, then the rest of the family so
	 * an operator can see what else exists. Picking one the container has not
	 * loaded makes every decision fail with a 404 that names the loaded one —
	 * loud on the test button, rather than silently answered by another model.
	 */
	async listModels(cfg: ProviderClientConfig): Promise<string[]> {
		const response = await fetcherFor(cfg)(`${originOf(cfg)}${LOCAL_DECISION_MODELS_PATH}`, {
			headers: { accept: 'application/json' },
			redirect: 'manual',
			signal: AbortSignal.timeout(5_000),
		});
		if (!response.ok) throw await responseError(response);
		const body = (await response.json()) as { data?: { id?: unknown }[] } | null;
		const loaded = (body?.data ?? [])
			.map((entry) => entry.id)
			.filter((id): id is string => typeof id === 'string' && id.length > 0);
		return [...new Set([...loaded, ...LOCAL_DECISION_MODELS])];
	},
};
