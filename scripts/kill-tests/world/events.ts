/**
 * The world's append-only event log. Every fixture (SMTP sink, Convex proxy)
 * records what it observed here, and the orchestrator waits on named events
 * through the control API instead of polling state: `waitFor` resolves the
 * moment the event is emitted (or at once if it already was).
 */

export interface WorldEvent {
	/** Monotonic per world process; the log's order is the observation order. */
	readonly seq: number;
	readonly key: string;
	readonly detail: unknown;
}

export class EventLog {
	private readonly events: WorldEvent[] = [];
	private readonly waiters = new Map<string, Array<(event: WorldEvent) => void>>();

	emit(key: string, detail: unknown = null): void {
		const event = { seq: this.events.length + 1, key, detail };
		this.events.push(event);
		const pending = this.waiters.get(key);
		if (!pending) return;
		this.waiters.delete(key);
		for (const resolve of pending) resolve(event);
	}

	has(key: string): boolean {
		return this.events.some((event) => event.key === key);
	}

	all(): readonly WorldEvent[] {
		return this.events;
	}

	/**
	 * The first event named `key`, as soon as it exists. `null` once `signal`
	 * aborts first; the caller owns the deadline, so a missing event fails the
	 * run instead of hanging it.
	 */
	waitFor(key: string, signal: AbortSignal): Promise<WorldEvent | null> {
		const existing = this.events.find((event) => event.key === key);
		if (existing) return Promise.resolve(existing);
		if (signal.aborted) return Promise.resolve(null);
		return new Promise((resolve) => {
			const onEvent = (event: WorldEvent) => {
				signal.removeEventListener('abort', onAbort);
				resolve(event);
			};
			const onAbort = () => {
				const list = this.waiters.get(key) ?? [];
				const index = list.indexOf(onEvent);
				if (index >= 0) list.splice(index, 1);
				resolve(null);
			};
			signal.addEventListener('abort', onAbort, { once: true });
			const list = this.waiters.get(key) ?? [];
			list.push(onEvent);
			this.waiters.set(key, list);
		});
	}
}
