/**
 * What the composer shows by default in Answer mode (`frame="answer"`, plan §04):
 * room to write, nothing else. Three pieces of view state, all of them
 * presentation only, so the draft, autosave and the SENT message are exactly
 * the popup's:
 *
 *  - the envelope collapses to one line ("To Jonas · From Ada · Re: …") and
 *    opens on click, or by itself the moment something in it needs attention
 *    (a first-time recipient, a From that leaves the team inbox or will fail
 *    authentication). It never closes by itself again: a warning that
 *    flickers away is worse than one that stays. A recipient without a sealing
 *    key is not such a thing: most people have none, the seal line under Send
 *    says so and offers to remove them, and Send asks before an unsealed send;
 *  - the quoted original is folded out of the editor. It is still IN the body
 *    (so the draft row, the mirror and the sent MIME carry it byte for byte as
 *    before); a class on the editor's wrapper only hides it, and "Show quoted
 *    text" in the footer brings it back for people who trim quotes;
 *  - Coach and Revise move under the footer's ⋯ and open on demand.
 *
 * The page frame (`frame="page"`, the full-page composer for new mail) keeps
 * the envelope open, since there is no thread to fill it in from, shows any
 * quoted text (a forward as new mail), and puts the caret in To when nobody is
 * addressed yet. Coach and Revise sit under ⋯ in both frames.
 */
import { computed, nextTick, onMounted, ref, watch, type Ref } from 'vue';
import type { EditorSnippet } from './usePostboxSnippetPicker';
import { bodyHasQuote } from '~/utils/answerMode';

/** What the composer calls on its simple editor. */
export interface BasicEditorHandle {
	focus: () => void;
	insertSnippet: (snippet: EditorSnippet) => void;
}

export function usePostboxComposerAnswerFrame(opts: {
	/** Where the composer is mounted; fixed for the life of the composer. */
	frame: 'page' | 'answer';
	bodyHtml: Ref<string>;
	/** Whether the draft is addressed yet (the page frame focuses To if not). */
	hasRecipients: () => boolean;
}) {
	const answer = opts.frame === 'answer';
	const envelopeOpen = ref(!answer);
	const quoteFolded = ref(answer);
	const advisoryOpen = ref(false);
	const hasQuote = computed(() => bodyHasQuote(opts.bodyHtml.value));
	/** What the envelope itself reports (see its `attention` event). */
	const envelopeAttention = ref(false);

	watch(
		envelopeAttention,
		(needsAttention) => {
			if (needsAttention) envelopeOpen.value = true;
		},
		{ immediate: true }
	);

	// Template refs the composer binds: the envelope (its reply-all switch, its
	// To field) and the body editor. Both frames only ever open on an explicit
	// act (a reply, Compose), so focusing on mount never steals focus on load:
	// Answer mode lands in the body, a new message in To until it has someone.
	const envelopeRef = ref<{ switchToReplyAll: () => void; focusTo: () => void } | null>(null);
	const basicEditor = ref<BasicEditorHandle | null>(null);
	function focusBody() {
		basicEditor.value?.focus();
	}
	onMounted(() => {
		void nextTick(() => {
			if (answer || opts.hasRecipients()) focusBody();
			else envelopeRef.value?.focusTo();
		});
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
