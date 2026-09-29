/**
 * Throttled flushing of a streaming model reply into a reactive row.
 *
 * Every surface that streams tokens to a subscribed client (the assistant
 * runner, Postbox whole-draft revise) accumulates the full text, writes it out
 * at most once per `intervalMs` (each write is a mutation, so this caps write
 * amplification), and aborts the model stream when the write reports that the
 * reader has gone (the user pressed Stop, the buffer was discarded). The
 * surface keeps its own persistence and terminal statuses: `patch` is its write,
 * `signal` goes to `runLlmStream`, and `stopRequested` tells its finalize step
 * why the stream ended.
 */

export interface ThrottledStreamFlusher {
	/** Pass as `runLlmStream`'s `abortSignal`; aborts when a patch reports `stop`. */
	readonly signal: AbortSignal;
	/** `onTextDelta` handler: record the full text so far, then flush if due. */
	onText(full: string): Promise<void>;
	/** Write the current text now (`force`) or only when the interval has passed. */
	flush(force: boolean): Promise<void>;
	/** The latest full text seen. */
	readonly text: string;
	/** A patch reported `stop` and the stream was aborted. */
	readonly stopRequested: boolean;
}

export function createThrottledStreamFlusher(opts: {
	intervalMs: number;
	patch: (text: string) => Promise<{ stop: boolean }>;
}): ThrottledStreamFlusher {
	const controller = new AbortController();
	let text = '';
	let lastFlushAt = 0;
	let stopRequested = false;

	const flush = async (force: boolean): Promise<void> => {
		const now = Date.now();
		if (!force && now - lastFlushAt < opts.intervalMs) return;
		lastFlushAt = now;
		const res = await opts.patch(text);
		if (res.stop) {
			stopRequested = true;
			controller.abort();
		}
	};

	return {
		signal: controller.signal,
		onText: async (full) => {
			text = full;
			await flush(false);
		},
		flush,
		get text() {
			return text;
		},
		get stopRequested() {
			return stopRequested;
		},
	};
}
