/**
 * Retry policy for every one-shot LLM dispatch (lib/llm/dispatch.ts): which
 * errors are worth another attempt, how long to wait, and how many attempts a
 * call gets. Runtime-neutral (no Node imports) so V8 budget accounting can read
 * {@link MAX_LLM_ATTEMPTS} too.
 */

import { LlmPartialUsageError } from './partialUsage';

/** Shared one-shot dispatch ceiling; runtime-neutral for V8 budget accounting. */
export const MAX_LLM_ATTEMPTS = 3;

/**
 * Attempt ceiling for interactive (user-facing) calls: one retry at most, so a
 * transient blip is absorbed but a struggling provider fails inside the
 * surface's deadline instead of after the background schedule.
 */
export const INTERACTIVE_LLM_ATTEMPTS = 2;

/**
 * Total deadline per interactive surface, covering every attempt and the
 * backoff between them. Background paths (the decision plane, draft-on-arrival,
 * the inbound agent) keep their own deadlines and the full attempt budget.
 */
export const INTERACTIVE_LLM_DEADLINE_MS = {
	/** Inline ghost-text completion: after a few seconds the user has typed on. */
	completion: 4_000,
	/** Suggested replies, thread summary, ask-the-thread, rewrite, coach. */
	reply: 20_000,
} as const;

export type InteractiveLlmSurface = keyof typeof INTERACTIVE_LLM_DEADLINE_MS;

/**
 * The dispatch options for one interactive call: a fresh deadline signal and
 * the reduced attempt ceiling. Build it right before the dispatch so setup work
 * (gate, thread load, prompt assembly) does not eat into the model's budget.
 */
export function interactiveLlmPolicy(surface: InteractiveLlmSurface): {
	abortSignal: AbortSignal;
	maxAttempts: number;
} {
	return {
		abortSignal: AbortSignal.timeout(INTERACTIVE_LLM_DEADLINE_MS[surface]),
		maxAttempts: INTERACTIVE_LLM_ATTEMPTS,
	};
}

const LLM_BACKOFF_BASE_MS = 500;
/** Ceiling on a provider-requested `retry-after` wait between attempts. */
const MAX_RETRY_AFTER_MS = 10_000;

/**
 * The provider's own error behind a dispatch failure. A failure after billed
 * work is rethrown as an `LlmPartialUsageError` (./partialUsage.ts) that keeps
 * the message but not the status or headers, so the readers below look at the
 * error it wraps.
 */
function providerError(error: unknown): unknown {
	return error instanceof LlmPartialUsageError ? error.cause : error;
}

/**
 * The wait a provider asked for on a 429/503, read off the AI SDK's
 * `APICallError.responseHeaders`. The SDK's own retry honoured these headers;
 * with that retry switched off the dispatcher honours them instead, so a rate
 * limit still backs off for as long as the provider asked (capped). An abort
 * signal still cuts the wait short.
 */
export function retryAfterMs(error: unknown, now = Date.now()): number | undefined {
	const headers = (
		providerError(error) as { responseHeaders?: Record<string, string | undefined> } | null
	)?.responseHeaders;
	if (!headers || typeof headers !== 'object') return undefined;
	const clamp = (ms: number) => Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
	const msHeader = headers['retry-after-ms'];
	if (msHeader !== undefined && Number.isFinite(Number(msHeader))) return clamp(Number(msHeader));
	const raw = headers['retry-after'];
	if (raw === undefined || raw.trim() === '') return undefined;
	const seconds = Number(raw);
	if (Number.isFinite(seconds)) return clamp(seconds * 1000);
	const at = Date.parse(raw);
	return Number.isNaN(at) ? undefined : clamp(at - now);
}

/**
 * Best-effort HTTP status off an AI-SDK / fetch error shape. Exported because
 * the DECISION plane's dispatch classifies the same three fields: one reader for
 * one shape, so a fourth field learned here is learned there too (a copy that
 * fell behind would quietly stop recognising the 401/403/422 that must never
 * produce a fallback hop).
 */
export function errorStatus(error: unknown): number | undefined {
	const e = providerError(error) as {
		statusCode?: number;
		status?: number;
		response?: { status?: number };
	} | null;
	return e?.statusCode ?? e?.status ?? e?.response?.status;
}

/**
 * Whether an LLM call error is worth retrying. Transient — rate limits (429),
 * server/overload (5xx, "overloaded"), timeouts, network resets — retry with
 * backoff. Hard client errors — bad/expired API key (401/403), malformed
 * request (400/404/422) — are NOT retriable: bail immediately so a misconfigured
 * key doesn't burn the whole attempt budget (and, upstream, a whole pipeline
 * retry) the way a transient overload would. Ambiguous errors default to
 * retriable (treated as a transient network blip).
 */
export function isRetriableLlmError(error: unknown): boolean {
	const status = errorStatus(error);
	if (status !== undefined) {
		if (status === 408 || status === 409 || status === 429) return true;
		if (status >= 500) return true;
		if (status >= 400) return false; // 401/403/400/404/422 → don't retry
	}
	const message = String((error as { message?: unknown } | null)?.message ?? error).toLowerCase();
	if (
		/\b(400|401|403|404|422)\b|invalid.?api.?key|unauthor|forbidden|authentication|invalid request|bad request|not found/.test(
			message
		)
	) {
		return false;
	}
	return true;
}

function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
	if (!abortSignal) return new Promise((resolve) => setTimeout(resolve, ms));
	assertNotAborted(abortSignal);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			abortSignal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		function onAbort() {
			clearTimeout(timer);
			reject(abortSignal?.reason ?? new Error('LLM dispatch aborted'));
		}
		abortSignal.addEventListener('abort', onAbort, { once: true });
	});
}

export interface LlmRetryResult<T> {
	readonly value: T;
	readonly attempts: number;
}

/**
 * Clamp a caller's attempt budget to `[1, MAX_LLM_ATTEMPTS]`. Callers may only
 * LOWER the ceiling (interactive surfaces use one retry at most); the hard-budget
 * reservation in plugins/llm.ts is sized for {@link MAX_LLM_ATTEMPTS}.
 */
function attemptBudget(maxAttempts: number | undefined): number {
	if (maxAttempts === undefined || !Number.isFinite(maxAttempts)) return MAX_LLM_ATTEMPTS;
	return Math.min(Math.max(Math.floor(maxAttempts), 1), MAX_LLM_ATTEMPTS);
}

/**
 * Run an LLM call with bounded exponential backoff (or the provider's
 * `retry-after`, whichever is longer), retrying only transient failures. The
 * single retry choke point for every dispatch helper.
 */
export async function withLlmRetry<T>(
	run: () => Promise<T>,
	abortSignal?: AbortSignal,
	maxAttempts?: number
): Promise<LlmRetryResult<T>> {
	const budget = attemptBudget(maxAttempts);
	let lastError: unknown;
	for (let attempt = 0; attempt < budget; attempt++) {
		assertNotAborted(abortSignal);
		try {
			return { value: await run(), attempts: attempt + 1 };
		} catch (error) {
			assertNotAborted(abortSignal);
			lastError = error;
			if (!isRetriableLlmError(error) || attempt === budget - 1) throw error;
			const backoff = LLM_BACKOFF_BASE_MS * 2 ** attempt;
			await sleep(Math.max(backoff, retryAfterMs(error) ?? 0), abortSignal);
		}
	}
	throw lastError;
}

function assertNotAborted(abortSignal: AbortSignal | undefined): void {
	if (abortSignal?.aborted) throw abortSignal.reason ?? new Error('LLM dispatch aborted');
}
