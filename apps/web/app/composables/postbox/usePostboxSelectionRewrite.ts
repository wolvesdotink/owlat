/**
 * Selection-rewrite state machine for the Postbox Simple composer.
 *
 * When the user selects text in the basic editor, a small floating pill offers
 * one-tap rewrites (Shorter / Friendlier / More formal / Fix grammar /
 * Translate…). Choosing one calls the backend `mail.ai.rewriteSelection` action
 * and shows an original-vs-rewritten preview the user must Apply — the rewrite
 * is NEVER auto-applied.
 *
 * Like {@link usePostboxGhostText} this composable is deliberately DOM- and
 * network-agnostic: it owns only the request lifecycle (loading, abort on
 * selection change, stale-response rejection) and the preview string. The editor
 * injects `requestRewrite(input, signal)` and, on Apply, calls the returned
 * `preview` value back through its own input path.
 */

import { ref } from 'vue';

/** The fixed set of one-tap rewrite intents. Mirrors the backend union. */
export type RewriteIntent =
	| 'shorter'
	| 'friendlier'
	| 'formal'
	| 'grammar'
	| 'translate';

export interface SelectionRewriteInput {
	/** The selected text to rewrite (the user's own draft). */
	selection: string;
	/** Which rewrite to perform. */
	intent: RewriteIntent;
	/** Target language name for `intent: 'translate'`. */
	targetLanguage?: string;
	/** Bounded surrounding draft text, context only (may quote inbound mail). */
	surroundingContext: string;
}

export interface UsePostboxSelectionRewriteOptions {
	/** Perform the rewrite; reject/ignore when `signal` aborts. */
	requestRewrite: (
		input: SelectionRewriteInput,
		signal: AbortSignal
	) => Promise<string>;
	/** Surface a fail-soft error (e.g. a toast). Selection is left untouched. */
	onError?: (message: string) => void;
}

/** Minimum selected words before the rewrite pill is offered. */
export const MIN_REWRITE_WORDS = 3;

/** Count whitespace-delimited words in a selection. */
export function countWords(text: string): number {
	const trimmed = text.trim();
	if (!trimmed) return 0;
	return trimmed.split(/\s+/).length;
}

/**
 * Pure visibility rule for the selection pill: only when AI is enabled AND the
 * selection is a meaningful phrase (>= {@link MIN_REWRITE_WORDS} words). Exported
 * so the rule can be unit-tested without a DOM.
 */
export function isRewriteEligible(enabled: boolean, selectionText: string): boolean {
	if (!enabled) return false;
	return countWords(selectionText) >= MIN_REWRITE_WORDS;
}

export function usePostboxSelectionRewrite(
	options: UsePostboxSelectionRewriteOptions
) {
	/** 'idle' | 'loading' (request in flight) | 'preview' (result ready). */
	const status = ref<'idle' | 'loading' | 'preview'>('idle');
	/** The original selection, shown alongside the rewrite in the preview. */
	const original = ref('');
	/** The rewritten text (only meaningful in the 'preview' state). */
	const rewritten = ref('');
	/** The intent currently running/previewed — drives the pill's loading dot. */
	const activeIntent = ref<RewriteIntent | null>(null);

	let activeController: AbortController | null = null;

	function abortInflight() {
		if (activeController) {
			activeController.abort();
			activeController = null;
		}
	}

	/**
	 * Reset everything and abort any in-flight request. Called on Discard and on
	 * any selection change so a stale preview is never shown over new text.
	 */
	function reset() {
		abortInflight();
		status.value = 'idle';
		original.value = '';
		rewritten.value = '';
		activeIntent.value = null;
	}

	/**
	 * Begin a rewrite for the given input. Aborts any prior request, moves to the
	 * loading state, and on success moves to the preview state. On error (or an
	 * empty result) it fails soft: resets and calls `onError` — the selection is
	 * never modified here.
	 */
	async function start(input: SelectionRewriteInput) {
		abortInflight();
		const controller = new AbortController();
		activeController = controller;
		status.value = 'loading';
		original.value = input.selection;
		rewritten.value = '';
		activeIntent.value = input.intent;

		let result = '';
		try {
			result = await options.requestRewrite(input, controller.signal);
		} catch {
			result = '';
			if (controller.signal.aborted || activeController !== controller) return;
			activeController = null;
			status.value = 'idle';
			activeIntent.value = null;
			options.onError?.('Could not rewrite the selection. Try again.');
			return;
		}
		// Reject stale/aborted responses: a newer request (or a reset) replaced us.
		if (controller.signal.aborted || activeController !== controller) return;
		activeController = null;
		const trimmed = result.trim();
		if (!trimmed) {
			status.value = 'idle';
			activeIntent.value = null;
			options.onError?.('No rewrite was suggested. Try again.');
			return;
		}
		rewritten.value = trimmed;
		status.value = 'preview';
	}

	/**
	 * Consume the previewed rewrite: returns the text and resets to idle. The
	 * caller is responsible for inserting it through the editor's input path.
	 * Returns null when nothing is previewed.
	 */
	function takeApplied(): string | null {
		if (status.value !== 'preview') return null;
		const text = rewritten.value;
		reset();
		return text || null;
	}

	function isLoading(): boolean {
		return status.value === 'loading';
	}

	function hasPreview(): boolean {
		return status.value === 'preview';
	}

	return {
		status,
		original,
		rewritten,
		activeIntent,
		start,
		reset,
		takeApplied,
		isLoading,
		hasPreview,
	};
}

export type PostboxSelectionRewrite = ReturnType<typeof usePostboxSelectionRewrite>;
