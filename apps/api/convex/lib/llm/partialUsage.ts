/**
 * The spend of a model run that failed partway (#1256). A tool loop or a
 * stream bills every step it finished, but the error it ends in carries no
 * usage, so the caller had nothing to record. The dispatch helpers that run
 * several steps (lib/llm/dispatch.ts: `runLlmTextWithTools`, `runLlmStream`)
 * count the usage of each finished step and, when a later step throws, throw
 * an {@link LlmPartialUsageError} that carries it. Pure (no ctx, no
 * 'use node').
 */

import type { TokenUsage } from '../../agent/steps/types';

/**
 * A dispatch failure after one or more billed steps. The message is the
 * original error's and the original error is the `cause`, so callers that log
 * the message read what they read before. Thrown only when there is usage to
 * carry; a failure before any step finished rethrows the original error as is.
 */
export class LlmPartialUsageError extends Error {
	override readonly name = 'LlmPartialUsageError';
	override readonly cause: unknown;

	constructor(
		cause: unknown,
		readonly tokenUsage: TokenUsage,
		readonly modelUsed: string | undefined
	) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.cause = cause;
	}
}

/** `error` carrying `tokenUsage` when there is any; otherwise `error` itself. */
export function withPartialUsage(
	error: unknown,
	tokenUsage: TokenUsage | undefined,
	modelUsed: string | undefined
): unknown {
	if (!tokenUsage || error instanceof LlmPartialUsageError) return error;
	return new LlmPartialUsageError(error, tokenUsage, modelUsed);
}

/** The billed usage a failed dispatch carries, or undefined when it carries none. */
export function partialUsageOf(
	error: unknown
): { tokenUsage: TokenUsage; modelUsed: string | undefined } | undefined {
	if (!(error instanceof LlmPartialUsageError)) return undefined;
	return { tokenUsage: error.tokenUsage, modelUsed: error.modelUsed };
}
