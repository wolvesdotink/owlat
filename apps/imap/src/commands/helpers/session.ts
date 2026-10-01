/**
 * `CommandSession` construction helpers.
 *
 * Modules build one of two shapes:
 *   - **Synchronous one-shot** — `start` writes its lines (and calls
 *     `deps.commit` if it transitions state), then returns
 *     `syncSession()`.
 *   - **Async one-shot** — `start` spawns work via `asyncSession`; the
 *     worker calls `deps.commit(newState)` synchronously before resolving
 *     so the next command dispatched off the pump's state field sees the
 *     transition.
 *
 * Long-running modules (IDLE, APPEND) build their session by hand
 * because they need timers, literal absorption, or DONE handling.
 */

import type { CommandSession } from '../types.js';

const NOOP = (): void => {};

/** Already-resolved session. Used by stateless and synchronous commands. */
export function syncSession(): CommandSession {
	return {
		completion: Promise.resolve(),
		cancel: NOOP,
	};
}

/**
 * Spawn an async task and resolve `completion` when it finishes. The
 * worker calls `deps.commit(state)` directly if it transitions state.
 * Worker rejections are swallowed — modules log + emit NO/BAD responses
 * themselves; the pump must always see completion resolve, because it
 * dispatches no further command until it does.
 *
 * `cancel()` (the pump calls it when the socket closes) aborts the signal
 * handed to the worker. A worker that honours it stops issuing Convex reads
 * and downloads and returns; one that ignores it simply runs to completion
 * as before. Either way `completion` still resolves.
 */
export function asyncSession(worker: (signal: AbortSignal) => Promise<void>): CommandSession {
	const controller = new AbortController();
	const completion = worker(controller.signal).catch(() => undefined);
	return {
		completion,
		cancel: () => controller.abort(),
	};
}
