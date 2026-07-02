/**
 * Inline ghost-text autocomplete state machine for the Postbox composer.
 *
 * Superhuman-style: after a short typing pause, ask the backend for ONE short
 * continuation and show it as non-editable muted text at the caret; Tab accepts
 * (inserted as real text through the editor so undo/autosave see it), Esc or any
 * further typing dismisses it.
 *
 * This composable is deliberately DOM- and network-agnostic: it owns only the
 * debounce, the >=1s client-side rate limit, stale-response rejection and the
 * ghost string. The editor injects:
 *   - `requestCompletion(input, signal)` — calls the Convex action; the signal
 *     lets it be discarded (Convex actions can't truly abort the socket, so the
 *     composable also ignores any response from a superseded request).
 *   - `onAccept(text)` — inserts the accepted text at the caret via the editor's
 *     own input path.
 * The editor is responsible for deciding *when* to schedule (only when the caret
 * sits at the end of a text node) and *where* to render the ghost.
 *
 * The editor input path NEVER awaits the network: scheduling only arms a timer,
 * and a completion that fails or arrives late is silently dropped — the
 * non-AI typing experience is never blocked.
 */

import { ref } from 'vue';

export interface GhostTextRequestInput {
	/** Bounded slice of the thread being replied to (untrusted data, context). */
	threadContext: string;
	/** The whole draft so far (plain text). */
	draftSoFar: string;
	/** The text of the sentence up to the caret. */
	cursorSentence: string;
}

export interface UsePostboxGhostTextOptions {
	/** ai flag AND the per-user "Writing suggestions" toggle. Re-read each pause. */
	enabled: () => boolean;
	/** Fetch a completion; reject/ignore when `signal` aborts. */
	requestCompletion: (
		input: GhostTextRequestInput,
		signal: AbortSignal
	) => Promise<string>;
	/** Insert the accepted suggestion as real editor text. */
	onAccept: (suggestion: string) => void;
	/** Typing-pause debounce before a request (default 450ms). */
	debounceMs?: number;
	/** Minimum gap between network requests (default 1000ms). */
	minIntervalMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 450;
const DEFAULT_MIN_INTERVAL_MS = 1000;

export function usePostboxGhostText(options: UsePostboxGhostTextOptions) {
	const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

	/** The suggestion currently shown (empty string = nothing shown). */
	const ghost = ref('');

	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let activeController: AbortController | null = null;
	let lastRequestAt = -Infinity;

	function clearDebounce() {
		if (debounceTimer !== null) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
	}

	function abortInflight() {
		if (activeController) {
			activeController.abort();
			activeController = null;
		}
	}

	/**
	 * Discard any pending/inflight request and hide the ghost. Called on every
	 * keystroke and selection change so a stale suggestion is never shown.
	 */
	function cancel() {
		clearDebounce();
		abortInflight();
		if (ghost.value) ghost.value = '';
	}

	async function dispatch(getInput: () => GhostTextRequestInput | null) {
		debounceTimer = null;
		if (!options.enabled()) return;
		// Client-side rate limit: never fire two requests within minIntervalMs.
		if (Date.now() - lastRequestAt < minIntervalMs) return;
		const input = getInput();
		if (!input) return;

		abortInflight();
		const controller = new AbortController();
		activeController = controller;
		lastRequestAt = Date.now();

		let suggestion = '';
		try {
			suggestion = await options.requestCompletion(input, controller.signal);
		} catch {
			// Fail soft — a completion error degrades to the non-AI experience.
			suggestion = '';
		}
		// Reject stale/aborted responses: a newer request (or a cancel) replaced us.
		if (controller.signal.aborted || activeController !== controller) return;
		activeController = null;
		ghost.value = suggestion || '';
	}

	/**
	 * Arm a completion request after the typing pause. Pass a lazy getter so the
	 * caret context is sampled at fire time, not at schedule time. Hides any
	 * currently-shown ghost immediately (the draft just changed under it).
	 */
	function schedule(getInput: () => GhostTextRequestInput | null) {
		cancel();
		if (!options.enabled()) return;
		debounceTimer = setTimeout(() => {
			void dispatch(getInput);
		}, debounceMs);
	}

	/**
	 * Accept the shown ghost: clears it and inserts it via the editor. Returns
	 * true if a suggestion was accepted (so the caller can preventDefault Tab).
	 */
	function accept(): boolean {
		const text = ghost.value;
		if (!text) return false;
		cancel();
		options.onAccept(text);
		return true;
	}

	/** True while a suggestion is visible. */
	function hasGhost(): boolean {
		return ghost.value.length > 0;
	}

	return { ghost, schedule, cancel, accept, hasGhost };
}

export type PostboxGhostText = ReturnType<typeof usePostboxGhostText>;
