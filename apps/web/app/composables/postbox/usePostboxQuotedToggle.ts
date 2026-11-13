import { computed, ref, watch } from 'vue';
import type { PostboxMessageFind } from './usePostboxThreadFind';

/**
 * Whether a message body shows its quoted part, and the toggle that flips it.
 *
 * Find shows the quote while a match sits in it, apart from the reader's own
 * toggle: closing find folds it away again unless the reader opened it. Hiding
 * it by hand while find holds it open wins until find lets go.
 */
export function usePostboxQuotedToggle(find: () => PostboxMessageFind | null | undefined) {
	const showQuoted = ref(false);
	const quoteHiddenByHand = ref(false);
	const findForcesQuote = computed(() => !!find()?.forceQuoted && !quoteHiddenByHand.value);
	watch(
		() => !!find()?.forceQuoted,
		(forced) => {
			if (!forced) quoteHiddenByHand.value = false;
		}
	);
	const quotedShown = computed(() => showQuoted.value || findForcesQuote.value);
	function toggleQuoted() {
		if (quotedShown.value) {
			showQuoted.value = false;
			if (findForcesQuote.value) quoteHiddenByHand.value = true;
		} else {
			showQuoted.value = true;
		}
	}
	return { quotedShown, toggleQuoted };
}
