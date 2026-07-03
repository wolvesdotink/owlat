<script setup lang="ts">
/**
 * Postbox basic rich-text editor.
 *
 * `contenteditable` + Selection/Range plumbing shared with the campaign
 * builder via `useRichText` in @owlat/ui. Toolbar covers B / I / U, H1-H2,
 * bullet & ordered lists, blockquote, link. v-models raw HTML.
 *
 * For richer compositions (heroes, columns, tables, …) the composer's
 * "Designer" mode mounts the full @owlat/email-builder instead.
 *
 * The empty document is normalized to `<p><br></p>` so the cursor always
 * lives inside a real paragraph (avoids browser-quirky wrapping on first
 * keystroke).
 */

import { api } from '@owlat/api';
import {
	useRichText,
	EMPTY_ACTIVE_MARKS,
	type ActiveMarks,
} from '@owlat/ui/composables/useRichText';
import {
	usePostboxGhostText,
	type GhostTextRequestInput,
} from '~/composables/postbox/usePostboxGhostText';
import { usePostboxRewriteController } from '~/composables/postbox/usePostboxRewriteController';
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	modelValue: string;
	placeholder?: string;
	/**
	 * Enable inline ghost-text autocomplete (Tab to accept). The parent passes
	 * `ai` flag AND the per-user "Writing suggestions" toggle. Off by default so
	 * the editor's other mount sites (e.g. signatures) never call out.
	 */
	suggestionsEnabled?: boolean;
	/** Bounded thread context for the completion prompt (untrusted data). */
	ghostThreadContext?: string;
	/**
	 * Enable the AI selection-rewrite pill (Shorter / Friendlier / …). Gated on
	 * the `ai` flag ONLY (unlike ghost text, no per-user toggle). Off by default.
	 */
	rewriteEnabled?: boolean;
	/** Mailbox whose voice profile personalizes rewrites (optional). */
	rewriteMailboxId?: Id<'mailboxes'>;
}>();

const emit = defineEmits<{
	(e: 'update:modelValue', value: string): void;
}>();

const editorRef = ref<HTMLDivElement | null>(null);
const surfaceRef = ref<HTMLDivElement | null>(null);
const isEmpty = ref(true);
const activeMarks = ref<ActiveMarks>({ ...EMPTY_ACTIVE_MARKS });
const ghostStyle = ref<Record<string, string> | null>(null);

const richText = useRichText({
	editorRef,
	onChange: () => emitContent(),
	// Notion-style markdown typing shortcuts are a Postbox-only affordance.
	patternShortcuts: true,
});

const {
	toggleBold,
	toggleItalic,
	toggleUnderline,
	toggleHeading,
	toggleBlockquote,
	toggleList,
	setLink,
	pasteAsPlainText,
	handleFormatKeydown,
	handleBeforeInput,
	handleShortcutUndoKeydown,
	resetShortcutUndo,
	readActiveMarks,
} = richText;

function syncActiveMarks() {
	activeMarks.value = readActiveMarks();
}

function syncEmptyState() {
	const el = editorRef.value;
	if (!el) {
		isEmpty.value = true;
		return;
	}
	const text = el.innerText.replace(/​/g, '').trim();
	isEmpty.value = text.length === 0;
}

function ensureScaffold() {
	const el = editorRef.value;
	if (!el) return;
	if (el.childNodes.length === 0) {
		el.innerHTML = '<p><br></p>';
	}
}

function emitContent() {
	const el = editorRef.value;
	if (!el) return;
	emit('update:modelValue', el.innerHTML);
	syncEmptyState();
	syncActiveMarks();
}

// The editor input path must NEVER await the network: `onInput` only emits and
// arms the debounce timer; the completion resolves (or is dropped) out of band.
function onInput() {
	emitContent();
	scheduleGhost();
	// Typing invalidates any pending/previewed rewrite anchored to old text.
	rewriteCtl.invalidateOnEdit();
}

// ── Inline ghost-text autocomplete ─────────────────────────────────────
// A muted suggestion at the caret, requested after a typing pause and accepted
// with Tab. The overlay is a positioned, non-editable sibling of the
// contenteditable — it is NEVER part of the DOM the draft serializes from, so
// an un-accepted ghost can't leak into the sent message. Positioning is
// best-effort: if the caret rect can't be measured, the ghost is dropped rather
// than risk breaking typing.

function insertAcceptedText(text: string) {
	const el = editorRef.value;
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
		emitContent();
	}
}

const ghost = usePostboxGhostText({
	enabled: () => props.suggestionsEnabled === true,
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
	const el = editorRef.value;
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
		before.lastIndexOf('\n')
	);
	const cursorSentence = (lastBreak >= 0 ? before.slice(lastBreak + 1) : before)
		.slice(-500)
		.trimStart();
	return {
		threadContext: (props.ghostThreadContext ?? '').slice(0, 4000),
		draftSoFar: el.innerText.slice(-4000),
		cursorSentence,
	};
}

/** Position the ghost overlay at the caret; drop it if the rect is unmeasurable. */
function positionGhost() {
	const surface = surfaceRef.value;
	const sel = window.getSelection();
	if (!surface || !sel || sel.rangeCount === 0) {
		ghost.cancel();
		return;
	}
	const range = sel.getRangeAt(0).cloneRange();
	range.collapse(false);
	const rects = range.getClientRects();
	const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
	if (!rect || (rect.top === 0 && rect.left === 0 && rect.height === 0)) {
		ghost.cancel(); // fail-soft: hide rather than mis-place
		return;
	}
	const host = surface.getBoundingClientRect();
	ghostStyle.value = {
		left: `${rect.right - host.left + surface.scrollLeft}px`,
		top: `${rect.top - host.top + surface.scrollTop}px`,
		height: `${rect.height}px`,
	};
}

function scheduleGhost() {
	if (props.suggestionsEnabled !== true) return;
	ghost.schedule(() => getCaretContext());
}

watch(ghost.ghost, (value) => {
	if (!value) {
		ghostStyle.value = null;
		return;
	}
	void nextTick(() => positionGhost());
});

// ── AI selection rewrite (Shorter / Friendlier / … / Translate) ─────────
// A tiny floating pill over a >=3-word selection offers one-tap rewrites; the
// result is shown as an original-vs-rewritten preview the user must Apply. The
// whole lifecycle (placement, saved range, Apply/Discard/Undo) lives in the
// controller composable; the editor just wires its refs + input hooks to it.

const rewriteCtl = usePostboxRewriteController({
	editorRef,
	surfaceRef,
	richText,
	enabled: () => props.rewriteEnabled === true,
	mailboxId: () => props.rewriteMailboxId,
	emitContent,
});

// Markdown shortcuts intercept the raw input BEFORE the character lands, so a
// conversion never flickers the literal marker into the DOM. When consumed the
// composable has already called preventDefault().
function onBeforeInput(event: InputEvent) {
	if (handleBeforeInput(event)) {
		// The conversion mutates the DOM directly without firing @input, so emit
		// the new content and re-run the ghost/rewrite bookkeeping the input path
		// would normally do.
		emitContent();
		rewriteCtl.invalidateOnEdit();
	}
}

function onKeydown(event: KeyboardEvent) {
	// A conversion's first Cmd+Z restores the literal marker text (one undo step).
	if (handleShortcutUndoKeydown(event)) {
		emitContent();
		return;
	}
	if (ghost.hasGhost()) {
		if (event.key === 'Tab') {
			event.preventDefault();
			ghost.accept();
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			ghost.cancel();
			return;
		}
		// Any other key: the draft is changing under the ghost — dismiss it.
		ghost.cancel();
	}
	// Escape dismisses a rewrite pill/preview without touching the selection.
	if (event.key === 'Escape' && rewriteCtl.handleEscape()) {
		event.preventDefault();
		return;
	}
	handleFormatKeydown(event);
}

function onPaste(event: ClipboardEvent) {
	pasteAsPlainText(event);
}

function onBlur() {
	emitContent();
	ghost.cancel(); // never leave a ghost hanging over an unfocused editor
	resetShortcutUndo(); // a literal-restore undo shouldn't survive leaving the editor
}

function onSelectionChange() {
	if (richText.getSelection()) syncActiveMarks();
	// A caret move (arrow/click) invalidates a shown ghost. Only dismiss when one
	// is visible, so this can't clear a request still pending in its debounce.
	if (ghost.hasGhost()) ghost.cancel();
	// A selection change aborts an in-flight rewrite (its anchor is now stale)
	// and re-places the pill for the new selection.
	rewriteCtl.onSelectionChange();
}

function focusEditor() {
	editorRef.value?.focus();
}

// Toolbar buttons must not steal focus from the editor — `mousedown.prevent`
// in the template handles that. Define guarded handlers that re-focus first.
function withFocus(fn: () => void | Promise<void>) {
	return () => {
		focusEditor();
		void fn();
	};
}

onMounted(() => {
	const el = editorRef.value;
	if (el) {
		if (props.modelValue && el.innerHTML !== props.modelValue) {
			el.innerHTML = props.modelValue;
		} else {
			ensureScaffold();
		}
	}
	syncEmptyState();
	syncActiveMarks();
	document.addEventListener('selectionchange', onSelectionChange);
});

onBeforeUnmount(() => {
	document.removeEventListener('selectionchange', onSelectionChange);
	ghost.cancel();
	rewriteCtl.dispose();
});

watch(
	() => props.modelValue,
	(value) => {
		const el = editorRef.value;
		if (!el) return;
		if (el.innerHTML === value) return;
		const isFocused = document.activeElement === el;
		if (isFocused) return; // don't clobber the user's cursor mid-typing
		el.innerHTML = value || '';
		ensureScaffold();
		syncEmptyState();
	}
);

defineExpose({ focus: focusEditor });
</script>

<template>
	<div class="flex flex-col h-full">
		<PostboxEditorToolbar
			:active-marks="activeMarks"
			@bold="withFocus(toggleBold)()"
			@italic="withFocus(toggleItalic)()"
			@underline="withFocus(toggleUnderline)()"
			@heading="(level) => withFocus(() => toggleHeading(level))()"
			@list="(ordered) => withFocus(() => toggleList(ordered))()"
			@blockquote="withFocus(toggleBlockquote)()"
			@link="withFocus(setLink)()"
		/>
		<div ref="surfaceRef" class="flex-1 overflow-auto relative">
			<div
				ref="editorRef"
				role="textbox"
				aria-multiline="true"
				contenteditable="true"
				spellcheck="true"
				class="postbox-basic-editor outline-none p-3 min-h-full"
				@beforeinput="onBeforeInput"
				@input="onInput"
				@keydown="onKeydown"
				@paste="onPaste"
				@blur="onBlur"
			/>
			<div
				v-if="isEmpty"
				class="absolute top-3 left-3 text-text-tertiary text-sm pointer-events-none select-none"
			>
				{{ placeholder ?? 'Write your message…' }}
			</div>
			<!--
				Ghost text: non-editable, positioned at the caret. Lives OUTSIDE the
				contenteditable so it can never be serialized into the draft; aria-hidden
				because it's advisory chrome, not committed content.
			-->
			<div
				v-if="ghost.ghost.value && ghostStyle"
				class="postbox-ghost-text pointer-events-none absolute whitespace-pre select-none"
				:style="ghostStyle"
				aria-hidden="true"
			>{{ ghost.ghost.value }}</div>
			<!-- AI rewrite pill + preview + undo affordance (all flag-gated). -->
			<PostboxRewriteLayer
				v-if="rewriteEnabled"
				:controller="rewriteCtl"
			/>
		</div>
	</div>
</template>

<style scoped>
.postbox-basic-editor {
	font-size: 14px;
	line-height: 1.55;
	color: var(--color-text-primary, #1a1a1a);
}
.postbox-basic-editor :deep(h1) {
	font-size: 1.5rem;
	font-weight: 600;
	margin: 0.5em 0 0.3em;
}
.postbox-basic-editor :deep(h2) {
	font-size: 1.25rem;
	font-weight: 600;
	margin: 0.5em 0 0.3em;
}
.postbox-basic-editor :deep(p) {
	margin: 0 0 0.6em;
}
.postbox-basic-editor :deep(ul) {
	list-style: disc;
	padding-left: 1.5em;
	margin: 0 0 0.6em;
}
.postbox-basic-editor :deep(ol) {
	list-style: decimal;
	padding-left: 1.5em;
	margin: 0 0 0.6em;
}
.postbox-basic-editor :deep(blockquote) {
	border-left: 3px solid var(--color-border-subtle, #ddd);
	padding-left: 0.75em;
	color: var(--color-text-secondary, #555);
	margin: 0 0 0.6em;
}
.postbox-basic-editor :deep(a) {
	color: var(--color-brand, #0a6cdd);
	text-decoration: underline;
}
.postbox-basic-editor :deep(code) {
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	font-size: 0.9em;
	background: var(--color-bg-subtle, #f2f2f2);
	border: 1px solid var(--color-border-subtle, #e0e0e0);
	border-radius: 3px;
	padding: 0.1em 0.3em;
}
.postbox-ghost-text {
	font-size: 14px;
	line-height: 1.55;
	color: var(--color-text-tertiary, #9aa0a6);
	opacity: 0.75;
}
</style>
