/**
 * What the composer shows by default in Answer mode (`frame="answer"`, plan §04):
 * room to write, nothing else. Three pieces of view state, all of them
 * presentation only, so the draft, autosave and the SENT message are exactly
 * the popup's:
 *
 *  - the envelope collapses to one line ("To Jonas · From Ada · Re: …") and
 *    opens on click, or by itself the moment something in it needs attention
 *    (a first-time recipient, a From that leaves the team inbox or will fail
 *    authentication, a recipient blocking the seal). It never closes by
 *    itself again: a warning that flickers away is worse than one that stays;
 *  - the quoted original is folded out of the editor. It is still IN the body
 *    (so the draft row, the mirror and the sent MIME carry it byte for byte as
 *    before); a class on the editor's wrapper only hides it, and "Show quoted
 *    text" in the footer brings it back for people who trim quotes;
 *  - Coach and Revise move under the footer's ⋯ and open on demand.
 *
 * In the popup frame all three are simply "open", which is today's composer.
 */
import { computed, ref, watch, type Ref } from 'vue';
import { bodyHasQuote } from '~/utils/answerMode';

export function usePostboxComposerAnswerFrame(opts: {
	/** `frame === 'answer'`; fixed for the life of the composer. */
	active: boolean;
	bodyHtml: Ref<string>;
	/** Something in the envelope needs to be seen. */
	attention: () => boolean;
}) {
	const envelopeOpen = ref(!opts.active);
	const quoteFolded = ref(opts.active);
	const advisoryOpen = ref(!opts.active);
	const hasQuote = computed(() => bodyHasQuote(opts.bodyHtml.value));

	watch(
		opts.attention,
		(needsAttention) => {
			if (needsAttention) envelopeOpen.value = true;
		},
		{ immediate: true }
	);

	return {
		envelopeOpen,
		quoteFolded,
		advisoryOpen,
		hasQuote,
		openEnvelope: () => {
			envelopeOpen.value = true;
		},
		toggleQuote: () => {
			quoteFolded.value = !quoteFolded.value;
		},
		toggleAdvisory: () => {
			advisoryOpen.value = !advisoryOpen.value;
		},
	};
}
