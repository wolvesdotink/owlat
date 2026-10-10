/**
 * A cited quote, marked inside a message body's iframe and scrolled to (plan
 * §4.2). Re-applied whenever the frame reloads its document (a new render,
 * images shown, the dark/light toggle) and cleared when the cite goes away.
 * `onResult` hears whether the exact passage was found, so the reader can say
 * it was not rather than mark a guess. The frame is same-origin (see
 * PostboxMessageBody), so its document is ours to read; no script runs inside.
 */
import type { Ref } from 'vue';
import { prefersReducedMotion } from '@owlat/ui/composables/useReducedMotion';
import {
	clearQuoteHighlight,
	highlightQuote,
	type CitedQuote,
} from '~/utils/postboxQuoteHighlight';

export function usePostboxQuoteHighlight(opts: {
	frame: Ref<HTMLIFrameElement | null>;
	/** The quote to mark; `null`/`undefined` for none. */
	quote: () => CitedQuote | null | undefined;
	/** Whether the cited passage was located (true) or could not be (false). */
	onResult?: (isLocated: boolean) => void;
}) {
	// Whether this frame's document may hold a mark: a body that was never
	// cited is never touched.
	let marked = false;
	function apply() {
		const cited = opts.quote();
		if (!cited?.quote && !marked) return;
		const doc = opts.frame.value?.contentDocument;
		if (!doc?.body) return;
		if (!cited?.quote) {
			clearQuoteHighlight(doc);
			marked = false;
			return;
		}
		marked = true;
		const result = highlightQuote(doc, cited);
		opts.onResult?.(result.status === 'marked');
		if (result.status === 'marked') {
			result.mark.scrollIntoView({
				block: 'center',
				behavior: prefersReducedMotion() ? 'auto' : 'smooth',
			});
		}
	}

	watch(
		opts.frame,
		(frame, previous) => {
			previous?.removeEventListener('load', apply);
			frame?.addEventListener('load', apply);
		},
		{ immediate: true }
	);
	watch(opts.quote, () => apply(), { deep: true });
	onBeforeUnmount(() => opts.frame.value?.removeEventListener('load', apply));
}
