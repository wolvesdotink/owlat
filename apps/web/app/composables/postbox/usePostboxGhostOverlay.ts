/**
 * Inline ghost-text autocomplete overlay for the Postbox composer.
 *
 * A muted suggestion at the caret, requested after a typing pause and accepted
 * with Tab. The overlay is a positioned, non-editable sibling of the
 * contenteditable — it is NEVER part of the DOM the draft serializes from, so an
 * un-accepted ghost can't leak into the sent message. Positioning is best-effort:
 * if the caret rect can't be measured, the ghost is dropped rather than risk
 * breaking typing.
 *
 * The caret sampling + overlay placement math lives here (rather than inline in
 * `PostboxBasicEditor.vue`) so the editor component stays under the file-size
 * ratchet and this DOM-heavy logic can be reasoned about in isolation.
 */
import type { Ref } from 'vue';
import { api } from '@owlat/api';
import {
	usePostboxGhostText,
	type GhostTextRequestInput,
} from '~/composables/postbox/usePostboxGhostText';
import { measureCaretRect } from '~/utils/postboxCaretRect';

export interface GhostOverlayOptions {
	editorRef: Ref<HTMLElement | null>;
	surfaceRef: Ref<HTMLElement | null>;
	/** True when inline suggestions are enabled (ai flag AND the per-user toggle). */
	enabled: () => boolean;
	/** Bounded, untrusted thread context for the completion prompt. */
	threadContext: () => string;
	/** Re-emit + re-sync the draft after a fallback insertion. */
	emitContent: () => void;
}

export function usePostboxGhostOverlay(opts: GhostOverlayOptions) {
	// Placement of the ghost overlay at the caret. Null when hidden.
	const ghostStyle = ref<Record<string, string> | null>(null);

	function insertAcceptedText(text: string) {
		const el = opts.editorRef.value;
		if (!el) return;
		el.focus();
		// execCommand routes through the browser's own edit pipeline, so native
		// undo and the @input autosave both see the insertion as real user text.
		const ok = document.execCommand('insertText', false, text);
		if (!ok) {
			// Fallback: insert a text node at the caret and emit like a real input.
			const sel = window.getSelection();
			if (sel && sel.rangeCount > 0) {
				const range = sel.getRangeAt(0);
				range.deleteContents();
				const node = document.createTextNode(text);
				range.insertNode(node);
				range.setStartAfter(node);
				range.collapse(true);
				sel.removeAllRanges();
				sel.addRange(range);
			}
			opts.emitContent();
		}
	}

	const ghost = usePostboxGhostText({
		enabled: () => opts.enabled(),
		requestCompletion: async (input: GhostTextRequestInput) => {
			const res = await requireConvex().action(api.mail.ai.completeDraft, {
				threadContext: input.threadContext,
				draftSoFar: input.draftSoFar,
				cursorSentence: input.cursorSentence,
			});
			return res?.completion ?? '';
		},
		onAccept: insertAcceptedText,
	});

	/** Sample the caret context — null unless the caret sits at the end of a text node. */
	function getCaretContext(): GhostTextRequestInput | null {
		const el = opts.editorRef.value;
		if (!el) return null;
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
		const focusNode = sel.focusNode;
		if (!focusNode || focusNode.nodeType !== Node.TEXT_NODE) return null;
		if (!el.contains(focusNode)) return null;
		if (sel.focusOffset !== (focusNode.textContent?.length ?? 0)) return null;
		const pre = document.createRange();
		pre.setStart(el, 0);
		pre.setEnd(focusNode, sel.focusOffset);
		const before = pre.toString();
		if (!before.trim()) return null;
		const lastBreak = Math.max(
			before.lastIndexOf('. '),
			before.lastIndexOf('! '),
			before.lastIndexOf('? '),
			before.lastIndexOf('\n'),
		);
		const cursorSentence = (lastBreak >= 0 ? before.slice(lastBreak + 1) : before)
			.slice(-500)
			.trimStart();
		return {
			threadContext: opts.threadContext().slice(0, 4000),
			draftSoFar: el.innerText.slice(-4000),
			cursorSentence,
		};
	}

	/** Position the ghost overlay at the caret; drop it if the rect is unmeasurable. */
	function positionGhost() {
		const rect = measureCaretRect(opts.surfaceRef.value);
		if (!rect) {
			ghost.cancel(); // fail-soft: hide rather than mis-place
			return;
		}
		// Anchor the ghost at the caret's trailing edge (it continues the line).
		ghostStyle.value = {
			left: `${rect.right}px`,
			top: `${rect.top}px`,
			height: `${rect.height}px`,
		};
	}

	/** Arm the debounced completion request for the current caret context. */
	function schedule() {
		if (!opts.enabled()) return;
		ghost.schedule(() => getCaretContext());
	}

	watch(ghost.ghost, (value) => {
		if (!value) {
			ghostStyle.value = null;
			return;
		}
		void nextTick(() => positionGhost());
	});

	return { ghost, ghostStyle, schedule };
}
