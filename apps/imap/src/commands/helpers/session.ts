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
 * themselves; the pump must always see completion resolve so it can
 * release the active-session slot.
 */
export function asyncSession(worker: () => Promise<void>): CommandSession {
	const completion = worker().catch(() => undefined);
	return {
		completion,
		cancel: NOOP,
	};
}
