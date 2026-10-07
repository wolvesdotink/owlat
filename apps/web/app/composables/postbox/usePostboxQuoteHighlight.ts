/**
 * A cited quote, marked inside a message body's iframe and scrolled to (plan
 * §4.2). Re-applied whenever the frame reloads its document (a new render,
 * images shown, the dark/light toggle) and cleared when the cite goes away.
 * The frame is same-origin (see PostboxMessageBody), so its document is ours
 * to read; no script runs inside it.
 */
import type { Ref } from 'vue';
import { prefersReducedMotion } from '@owlat/ui/composables/useReducedMotion';
import { clearQuoteHighlight, highlightQuote } from '~/utils/postboxQuoteHighlight';

export function usePostboxQuoteHighlight(opts: {
	frame: Ref<HTMLIFrameElement | null>;
	/** The quote to mark; `null`/`undefined` for none. */
	quote: () => string | null | undefined;
}) {
	function apply() {
		const doc = opts.frame.value?.contentDocument;
		if (!doc?.body) return;
		const quote = opts.quote();
		if (!quote) {
			clearQuoteHighlight(doc);
			return;
		}
		highlightQuote(doc, quote)?.scrollIntoView({
			block: 'center',
			behavior: prefersReducedMotion() ? 'auto' : 'smooth',
		});
	}

	watch(
		opts.frame,
		(frame, previous) => {
			previous?.removeEventListener('load', apply);
			frame?.addEventListener('load', apply);
		},
		{ immediate: true }
	);
	watch(opts.quote, () => apply());
	onBeforeUnmount(() => opts.frame.value?.removeEventListener('load', apply));
}
