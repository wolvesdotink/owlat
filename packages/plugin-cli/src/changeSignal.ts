/**
 * A single-consumer, coalescing change signal used by `owlat plugins dev`.
 *
 * `notify()` calls that arrive while no run is waiting collapse into one pending
 * signal, so a burst of filesystem events during a codegen run triggers exactly
 * one follow-up run rather than a queue of redundant ones. No timers are
 * involved, which keeps the reactive loop deterministic and testable: a test
 * drives it by calling `notify()` and `close()` directly.
 */
export interface ChangeSignal {
	readonly events: AsyncIterable<void>;
	notify(): void;
	close(): void;
}

export function createChangeSignal(): ChangeSignal {
	let pending = false;
	let closed = false;
	let waiter: ((result: IteratorResult<void>) => void) | undefined;

	const notify = (): void => {
		if (closed) return;
		if (waiter) {
			const resolve = waiter;
			waiter = undefined;
			resolve({ value: undefined, done: false });
		} else {
			pending = true;
		}
	};

	const close = (): void => {
		if (closed) return;
		closed = true;
		if (waiter) {
			const resolve = waiter;
			waiter = undefined;
			resolve({ value: undefined, done: true });
		}
	};

	const iterator: AsyncIterator<void> = {
		next() {
			if (closed) return Promise.resolve({ value: undefined, done: true });
			if (pending) {
				pending = false;
				return Promise.resolve({ value: undefined, done: false });
			}
			return new Promise((resolve) => {
				waiter = resolve;
			});
		},
		return() {
			close();
			return Promise.resolve({ value: undefined, done: true });
		},
	};

	return {
		events: {
			[Symbol.asyncIterator]() {
				return iterator;
			},
		},
		notify,
		close,
	};
}
