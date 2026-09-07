import type { Logger } from 'pino';

/**
 * Settle a best-effort promise: a rejection is logged under `operation` and
 * swallowed, so the caller can drop the result or await it purely for ordering
 * without a try/catch. The returned promise never rejects.
 */
export function fireAndForget(
	promise: Promise<unknown>,
	logger: Pick<Logger, 'warn'>,
	operation: string
): Promise<void> {
	return promise.then(
		() => undefined,
		(err: unknown) => {
			logger.warn({ err, operation }, 'Best-effort operation failed');
		}
	);
}
