/**
 * Gate for inline ghost-text autocomplete in the Postbox composer.
 *
 * Ghost suggestions are advisory AI, so they are only offered when BOTH the
 * `ai` feature flag is on AND the per-user "Writing suggestions" toggle is
 * enabled. Kept out of `PostboxComposer.vue` so the composer stays a thin view
 * and this gating logic has one home.
 */

import type { ComputedRef } from 'vue';

export function usePostboxGhostGate(): {
	ghostSuggestionsEnabled: ComputedRef<boolean>;
} {
	const { isEnabled } = useFeatureFlag();
	const { writingSuggestions } = usePostboxSettings();
	const ghostSuggestionsEnabled = computed(
		() => isEnabled('ai') && writingSuggestions.value,
	);
	return { ghostSuggestionsEnabled };
}
