/**
 * "Coach my draft" state machine for high-stakes mail.
 *
 * The middle rung between "suggest a reply" and "auto-draft": for money / legal
 * / bad-news replies people will not hand to an AI, this critiques what the USER
 * wrote — tone, ambiguity, clarity, a missing answer — and surfaces the notes
 * inline. It NEVER returns or rewrites the draft; the user stays the author.
 *
 * Like {@link usePostboxSelectionRewrite} this composable is deliberately DOM-
 * and network-agnostic: it owns only the request lifecycle (loading, abort on
 * re-run, stale-response rejection) and the list of suggestions. The host
 * injects `requestCoach(draftText, signal)` which returns the structured
 * suggestions from the backend `mail.aiCoach.coachDraft` action.
 *
 * Fail-soft: any error resolves to NO suggestions (a silent no-op) — coaching is
 * advisory and stays quiet on uncertainty rather than nagging the user.
 */

import { ref } from 'vue';
import { countWords } from './usePostboxSelectionRewrite';

/** Mirrors the backend `CoachCategory` union in mail/ai.ts. */
export type CoachCategory = 'tone' | 'ambiguity' | 'clarity' | 'missing-answer';

export interface CoachSuggestion {
	category: CoachCategory;
	message: string;
}

export interface UsePostboxCoachOptions {
	/** Fetch the critique; reject/ignore when `signal` aborts. */
	requestCoach: (draftText: string, signal: AbortSignal) => Promise<CoachSuggestion[]>;
	/** Surface a fail-soft error (e.g. a toast). The draft is left untouched. */
	onError?: (message: string) => void;
}

/** Minimum draft words before the Coach action is offered (a 3-word draft has nothing to coach). */
export const MIN_COACH_WORDS = 6;

/**
 * Pure visibility rule for the Coach action: only when AI is enabled AND the
 * draft is a meaningful length ({@link MIN_COACH_WORDS}+ words). Exported so the
 * rule is unit-testable without a DOM and so the flag-off case can be asserted.
 */
export function isCoachEligible(enabled: boolean, draftText: string): boolean {
	if (!enabled) return false;
	return countWords(draftText) >= MIN_COACH_WORDS;
}

/** Human labels for each category, for the inline chip next to a suggestion. */
export const COACH_CATEGORY_LABELS: Record<CoachCategory, string> = {
	tone: 'Tone',
	ambiguity: 'Ambiguity',
	clarity: 'Clarity',
	'missing-answer': 'Missing answer',
};

export function usePostboxCoach(options: UsePostboxCoachOptions) {
	/** 'idle' | 'loading' (critique in flight) | 'ready' (result shown). */
	const status = ref<'idle' | 'loading' | 'ready'>('idle');
	/** The suggestions from the most recent completed run (empty = clean draft). */
	const suggestions = ref<CoachSuggestion[]>([]);

	let activeController: AbortController | null = null;

	function abortInflight() {
		if (activeController) {
			activeController.abort();
			activeController = null;
		}
	}

	/** Reset everything and abort any in-flight request. */
	function reset() {
		abortInflight();
		status.value = 'idle';
		suggestions.value = [];
	}

	/**
	 * Run a critique over the given draft text. Aborts any prior request. On
	 * success moves to 'ready' with the suggestions (possibly empty for a clean
	 * draft). On error it fails soft: resets to idle, clears suggestions, and
	 * calls `onError`. The draft text is NEVER modified here.
	 */
	async function run(draftText: string) {
		abortInflight();
		const controller = new AbortController();
		activeController = controller;
		status.value = 'loading';
		suggestions.value = [];

		let result: CoachSuggestion[] = [];
		try {
			result = await options.requestCoach(draftText, controller.signal);
		} catch {
			if (controller.signal.aborted || activeController !== controller) return;
			activeController = null;
			status.value = 'idle';
			suggestions.value = [];
			options.onError?.('Could not coach this draft. Try again.');
			return;
		}
		// Reject stale/aborted responses: a newer run (or a reset) replaced us.
		if (controller.signal.aborted || activeController !== controller) return;
		activeController = null;
		suggestions.value = Array.isArray(result) ? result : [];
		status.value = 'ready';
	}

	function isLoading(): boolean {
		return status.value === 'loading';
	}

	function isReady(): boolean {
		return status.value === 'ready';
	}

	/** True once a run finished and found nothing to flag — "Looks solid". */
	function isClean(): boolean {
		return status.value === 'ready' && suggestions.value.length === 0;
	}

	return {
		status,
		suggestions,
		run,
		reset,
		isLoading,
		isReady,
		isClean,
	};
}

export type PostboxCoach = ReturnType<typeof usePostboxCoach>;
