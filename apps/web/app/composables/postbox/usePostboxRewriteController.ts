/**
 * Selection-rewrite CONTROLLER for the Postbox Simple composer.
 *
 * This is the DOM/network glue that sits between {@link usePostboxBasicEditor}'s
 * contenteditable and the pure {@link usePostboxSelectionRewrite} state machine:
 * it owns the pill/preview placement, the saved selection range, the Apply /
 * Discard / Undo lifecycle and the transient "Rewritten — Undo" affordance.
 *
 * Extracted out of `PostboxBasicEditor.vue` to keep that SFC focused on the
 * editor surface and its toolbar (and under the file-size ratchet). The editor
 * hands us its refs plus an `emitContent` callback and delegates the selection /
 * keydown / input hooks below; everything AI-rewrite lives here.
 *
 * Advisory only: a rewrite is NEVER auto-applied — the user must click Apply,
 * which routes the swap through the editor's native input path (single-step
 * undo). Fail-soft: a request error surfaces a toast and leaves the selection
 * untouched. The whole surface is suppressed when `enabled()` is false.
 */

import { ref, watch, nextTick, type Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { useRichText } from '@owlat/ui/composables/useRichText';
import {
	usePostboxSelectionRewrite,
	isRewriteEligible,
	type RewriteIntent,
	type SelectionRewriteInput,
} from '~/composables/postbox/usePostboxSelectionRewrite';
import { useRewriteLanguages } from '~/composables/postbox/useRewriteLanguages';

type RichText = ReturnType<typeof useRichText>;

export interface RewriteControllerOptions {
	editorRef: Ref<HTMLDivElement | null>;
	surfaceRef: Ref<HTMLDivElement | null>;
	richText: RichText;
	/** True when the AI rewrite pill is allowed (parent's `ai` flag). */
	enabled: () => boolean;
	/**
	 * True when the STANDALONE floating pill may be placed. Off in the default
	 * floating-toolbar mode, where the AI actions render inside the combined
	 * format bar instead (the controller still tracks `eligible`/`savedRange`).
	 * Defaults to always-on.
	 */
	pillEnabled?: () => boolean;
	/** Mailbox whose voice profile personalizes rewrites (optional). */
	mailboxId: () => Id<'mailboxes'> | undefined;
	/** Re-emit the editor's HTML after an Apply/Undo mutates the DOM. */
	emitContent: () => void;
}

export function usePostboxRewriteController(opts: RewriteControllerOptions) {
	const { showToast } = useToast();
	const pillStyle = ref<Record<string, string> | null>(null);
	const previewStyle = ref<Record<string, string> | null>(null);
	// True when the current selection is eligible for a rewrite — read by the
	// editor's combined format bar to decide whether to show the AI actions even
	// while `pillStyle` (the standalone pill) is suppressed.
	const eligible = ref(false);
	const pillEnabled = opts.pillEnabled ?? (() => true);
	// The selection to rewrite, saved so Apply can restore it even if focus moved.
	let savedRange: Range | null = null;
	const showUndo = ref(false);
	let undoTimer: ReturnType<typeof setTimeout> | null = null;

	const { languages, remember } = useRewriteLanguages();

	const rewrite = usePostboxSelectionRewrite({
		requestRewrite: async (input: SelectionRewriteInput) => {
			const mailboxId = opts.mailboxId();
			const res = await requireConvex().action(api.mail.ai.rewriteSelection, {
				selection: input.selection,
				intent: input.intent,
				...(input.targetLanguage ? { targetLanguage: input.targetLanguage } : {}),
				surroundingContext: input.surroundingContext,
				...(mailboxId ? { mailboxId } : {}),
			});
			return res?.rewritten ?? '';
		},
		onError: (message) => {
			showToast(message, 'error');
		},
	});

	/** Position a box anchored to the current selection, relative to the surface. */
	function selectionBoxStyle(place: 'above' | 'below'): Record<string, string> | null {
		const surface = opts.surfaceRef.value;
		const sel = window.getSelection();
		if (!surface || !sel || sel.rangeCount === 0) return null;
		const rect = sel.getRangeAt(0).getBoundingClientRect();
		if (!rect || (rect.top === 0 && rect.left === 0 && rect.width === 0)) return null;
		const host = surface.getBoundingClientRect();
		const left = rect.left - host.left + surface.scrollLeft;
		if (place === 'above') {
			return {
				left: `${Math.max(left, 4)}px`,
				top: `${rect.top - host.top + surface.scrollTop}px`,
				transform: 'translateY(-100%)',
			};
		}
		return {
			left: `${Math.max(left, 4)}px`,
			top: `${rect.bottom - host.top + surface.scrollTop + 6}px`,
		};
	}

	/** Recompute pill/preview placement + visibility for the current selection. */
	function refreshUi() {
		if (!opts.enabled()) {
			pillStyle.value = null;
			previewStyle.value = null;
			eligible.value = false;
			return;
		}
		// A live preview owns the anchor; leave it in place until Apply/Discard.
		if (rewrite.hasPreview()) {
			pillStyle.value = null;
			return;
		}
		const ctx = opts.richText.getSelection();
		const text = ctx ? ctx.sel.toString() : '';
		if (ctx && !ctx.range.collapsed && isRewriteEligible(true, text)) {
			savedRange = ctx.range.cloneRange();
			eligible.value = true;
			// In floating-toolbar mode the combined bar hosts the AI actions, so the
			// standalone pill stays suppressed even though the selection is eligible.
			pillStyle.value = pillEnabled() ? selectionBoxStyle('above') : null;
		} else {
			eligible.value = false;
			pillStyle.value = null;
		}
	}

	function onSelect(payload: { intent: RewriteIntent; targetLanguage?: string }) {
		const el = opts.editorRef.value;
		if (!el || !savedRange) return;
		const selection = savedRange.toString();
		if (!isRewriteEligible(true, selection)) return;
		if (payload.targetLanguage) remember(payload.targetLanguage);
		void rewrite.start({
			selection,
			intent: payload.intent,
			...(payload.targetLanguage ? { targetLanguage: payload.targetLanguage } : {}),
			surroundingContext: el.innerText.slice(0, 2000),
		});
	}

	function restoreSelection(): boolean {
		const range = savedRange;
		if (!range) return false;
		const sel = window.getSelection();
		if (!sel) return false;
		opts.editorRef.value?.focus();
		sel.removeAllRanges();
		sel.addRange(range);
		return true;
	}

	function apply() {
		const text = rewrite.takeApplied();
		if (text === null) return;
		if (!restoreSelection()) return;
		if (opts.richText.replaceSelection(text)) {
			opts.emitContent();
			// Transient "Rewritten — Undo" affordance reusing the native undo stack.
			showUndo.value = true;
			if (undoTimer) clearTimeout(undoTimer);
			undoTimer = setTimeout(() => {
				showUndo.value = false;
			}, 6000);
		}
		previewStyle.value = null;
		savedRange = null;
	}

	function discard() {
		rewrite.reset();
		previewStyle.value = null;
	}

	function undo() {
		showUndo.value = false;
		if (undoTimer) clearTimeout(undoTimer);
		opts.editorRef.value?.focus();
		document.execCommand('undo');
		opts.emitContent();
	}

	/** Typing/edits invalidate a pending/previewed rewrite anchored to old text. */
	function invalidateOnEdit() {
		if (rewrite.status.value !== 'idle') rewrite.reset();
		pillStyle.value = null;
		previewStyle.value = null;
		eligible.value = false;
	}

	/** A caret/selection move aborts an in-flight rewrite and re-places the pill. */
	function onSelectionChange() {
		if (rewrite.isLoading()) rewrite.reset();
		refreshUi();
	}

	/** Escape dismisses a shown pill/preview without touching the selection. */
	function handleEscape(): boolean {
		if (rewrite.status.value === 'idle') return false;
		discard();
		return true;
	}

	// Move the preview into view when a rewrite result arrives; drop the pill.
	watch(rewrite.status, (status) => {
		if (status === 'preview') {
			pillStyle.value = null;
			void nextTick(() => {
				previewStyle.value = selectionBoxStyle('below');
			});
		} else if (status === 'idle') {
			previewStyle.value = null;
		}
	});

	/** Tear down timers + abort any in-flight request (call from onBeforeUnmount). */
	function dispose() {
		rewrite.reset();
		if (undoTimer) clearTimeout(undoTimer);
	}

	return {
		rewrite,
		languages,
		pillStyle,
		previewStyle,
		eligible,
		showUndo,
		refreshUi,
		onSelect,
		apply,
		discard,
		undo,
		invalidateOnEdit,
		onSelectionChange,
		handleEscape,
		dispose,
	};
}
