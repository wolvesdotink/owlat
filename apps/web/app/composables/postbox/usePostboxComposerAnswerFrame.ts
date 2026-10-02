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
import { computed, nextTick, onMounted, ref, watch, type Ref } from 'vue';
import type { EditorSnippet } from './usePostboxSnippetPicker';

/** What the composer calls on its simple editor. */
export interface BasicEditorHandle {
	focus: () => void;
	insertSnippet: (snippet: EditorSnippet) => void;
}
import { bodyHasQuote } from '~/utils/answerMode';

export function usePostboxComposerAnswerFrame(opts: {
	/** `frame === 'answer'`; fixed for the life of the composer. */
	active: boolean;
	bodyHtml: Ref<string>;
	/** A recipient blocks sealing: the envelope is where that chip is. */
	sealBlocked: () => boolean;
}) {
	const envelopeOpen = ref(!opts.active);
	const quoteFolded = ref(opts.active);
	const advisoryOpen = ref(!opts.active);
	const hasQuote = computed(() => bodyHasQuote(opts.bodyHtml.value));
	/** What the envelope itself reports (see its `attention` event). */
	const envelopeAttention = ref(false);

	watch(
		() => envelopeAttention.value || opts.sealBlocked(),
		(needsAttention) => {
			if (needsAttention) envelopeOpen.value = true;
		},
		{ immediate: true }
	);

	// Template refs the composer binds: the envelope (its reply-all switch) and
	// the body editor, focused on mount in Answer mode, which only ever opens on
	// an explicit reply, so this never steals focus on load (and handed a saved
	// reply picked outside its text).
	const envelopeRef = ref<{ switchToReplyAll: () => void } | null>(null);
	const basicEditor = ref<BasicEditorHandle | null>(null);
	function focusBody() {
		basicEditor.value?.focus();
	}
	onMounted(() => {
		if (opts.active) void nextTick(focusBody);
	});

	function openEnvelope() {
		envelopeOpen.value = true;
	}

	return {
		envelopeOpen,
		envelopeAttention,
		quoteFolded,
		advisoryOpen,
		hasQuote,
		envelopeRef,
		basicEditor,
		focusBody,
		openEnvelope,
		/** "Reply all" on the folded line: open the envelope and flip its switch. */
		onLineReplyAll: () => {
			openEnvelope();
			envelopeRef.value?.switchToReplyAll();
		},
		toggleQuote: () => {
			quoteFolded.value = !quoteFolded.value;
		},
		toggleAdvisory: () => {
			advisoryOpen.value = !advisoryOpen.value;
		},
	};
}
